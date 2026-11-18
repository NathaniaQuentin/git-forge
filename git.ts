// Git smart HTTP at /{owner}/{repo}.git — protocol v2 and v0 upload-pack,
// v0 receive-pack, pkt-line framing, packfile read/write (plain objects,
// OFS_DELTA and REF_DELTA on read), shallow fetch, fast-forward enforcement.
//
// The suite drives this with its own byte-level client (no git binary), so
// every string here is chosen to match what that client parses.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createInflate, deflateSync } from 'node:zlib';
import type { Store, Repo, GitObject, GitObjectType } from './store.ts';
import {
  ZERO_OID,
  flattenTree,
  getObject,
  isAncestor,
  objectId,
  parseCommit,
  parseTree,
  putObject,
  sha1,
} from './store.ts';
import { type RestContext } from './rest.ts';

// ------------------------------------------------------------------ pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLines(lines: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Parse pkt-lines from a buffer starting at `offset`. Returns the packets
 * and the offset just past the last complete packet. A trailing partial
 * packet (the raw packfile after a flush) is left unread. */
export function decodePktLines(buf: Buffer, offset = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let i = offset;
  while (i + 4 <= buf.length) {
    const header = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const len = Number.parseInt(header, 16);
    if (len === 0) { packets.push({ kind: 'flush' }); i += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim' }); i += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end' }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, next: i };
}

// ------------------------------------------------------------------ packfile

const OBJ_TYPE_CODES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OBJ_TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i];
      i += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta source size ${sourceSize} does not match base ${base.length}`);
  const out: Buffer[] = [];
  let outLen = 0;
  while (i < delta.length) {
    const op = delta[i];
    i += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) { offset = delta[i]; i += 1; }
      if ((op & 0x02) !== 0) { offset |= delta[i] << 8; i += 1; }
      if ((op & 0x04) !== 0) { offset |= delta[i] << 16; i += 1; }
      if ((op & 0x08) !== 0) { offset |= delta[i] << 24; i += 1; }
      if ((op & 0x10) !== 0) { size = delta[i]; i += 1; }
      if ((op & 0x20) !== 0) { size |= delta[i] << 8; i += 1; }
      if ((op & 0x40) !== 0) { size |= delta[i] << 16; i += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(i, i + op));
      outLen += op;
      i += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error(`delta target size ${targetSize} does not match produced ${result.length}`);
  return result;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Parse a packfile. `haveObjects` resolves REF_DELTA bases the client
 * already holds (thin packs). Throws on a bad checksum or bad entry. */
/** Inflate one raw deflate stream starting at `offset`. A streaming inflate
 * reports `bytesWritten` = the exact compressed length consumed, so one
 * inflate per entry replaces the old binary search over inflateSync calls
 * (~20 inflations per entry). Trailing bytes (later entries, the trailer)
 * are ignored: the stream ends at the first stream's end. */
function inflateEntry(buf: Buffer, offset: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const inf = createInflate();
    const chunks: Buffer[] = [];
    inf.on('data', (d: Buffer) => chunks.push(d));
    inf.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: inf.bytesWritten }));
    inf.on('error', reject);
    inf.end(buf.subarray(offset));
  });
}

export async function readPack(pack: Buffer, haveObjects?: Map<string, GitObject>): Promise<PackReadResult> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Trailer checksum.
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1(pack.subarray(0, pack.length - 20));
  if (expected !== actual) throw new Error('pack trailer checksum mismatch');

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { type: GitObjectType; data: Buffer }>();
  let deltaCount = 0;
  let i = 12;
  for (let n = 0; n < count; n += 1) {
    const entryStart = i;
    const first = pack[i];
    i += 1;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    while ((pack[i - 1] & 0x80) !== 0) {
      size |= (pack[i] & 0x7f) << shift;
      shift += 7;
      i += 1;
    }
    let base: { type: GitObjectType; data: Buffer } | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: offset encoding.
      let b = pack[i];
      i += 1;
      let offset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[i];
        i += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      base = byOffset.get(entryStart - offset);
      if (base === undefined) throw new Error('OFS_DELTA base not found in pack');
      deltaCount += 1;
    } else if (typeCode === 7) {
      const baseId = pack.subarray(i, i + 20).toString('hex');
      i += 20;
      const found = objects.get(baseId) ?? haveObjects?.get(baseId);
      if (found === undefined) throw new Error(`REF_DELTA base ${baseId} not available`);
      base = found;
      deltaCount += 1;
    }
    const { data: inflated, consumed } = await inflateEntry(pack, i);
    i += consumed;
    if (inflated.length !== size) throw new Error(`object size mismatch: declared ${size}, got ${inflated.length}`);
    let obj: { type: GitObjectType; data: Buffer };
    if (base !== undefined) {
      obj = { type: base.type, data: applyDelta(base.data, inflated) };
    } else {
      const type = OBJ_TYPE_CODES[typeCode];
      if (type === undefined) throw new Error(`unknown object type code ${typeCode}`);
      obj = { type, data: inflated };
    }
    const id = objectId(obj.type, obj.data);
    objects.set(id, obj);
    byOffset.set(entryStart, obj);
  }
  return { objects, deltaCount };
}

/** Write a plain (no-delta) packfile v2 for the given objects. */
export function writePack(objects: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = OBJ_TYPE_IDS[obj.type];
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let remaining = size >> 4;
    let first = (typeCode << 4) | (size & 0x0f);
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ------------------------------------------------------------------ reachability

export interface FetchSet {
  objects: Array<{ type: GitObjectType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Objects to deliver for a fetch: the closure of `wants` (with an optional
 * depth limit), minus everything reachable from `haves`.
 * Depth: 1 = want commits only (no parents); 2 = wants + parents; null = all.
 */
export function collectFetchSet(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  clientShallow: string[],
): FetchSet {
  const haveClosure = new Set<string>();
  {
    const stack = [...haves];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = getObject(repo, cur);
      if (obj === undefined) continue;
      haveClosure.add(cur);
      if (obj.type === 'commit') {
        const parsed = parseCommit(obj.data);
        stack.push(parsed.tree);
        // A commit the client declares shallow is a boundary it holds
        // WITHOUT its parents (e.g. after a depth-1 clone): do not walk
        // past it, or the server would wrongly conclude the client
        // already has the parents a deepen fetch must deliver.
        if (!clientShallow.includes(cur)) {
          for (const p of parsed.parents) stack.push(p);
        }
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (e.mode !== '160000') stack.push(e.id);
        }
      } else if (obj.type === 'tag') {
        const target = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (target !== null) stack.push(target[1]);
      }
    }
  }

  const included = new Map<string, GitObject>();
  const boundary = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [];
  const seenCommit = new Map<string, number>();
  for (const w of wants) {
    const obj = getObject(repo, w);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      queue.push({ id: w, depth: 0 });
    } else if (obj.type === 'commit') {
      queue.push({ id: w, depth: 0 });
    } else {
      queue.push({ id: w, depth: 0 });
    }
  }
  while (queue.length > 0) {
    const { id, depth: d } = queue.shift() as { id: string; depth: number };
    const obj = getObject(repo, id);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      const prev = seenCommit.get(id);
      if (prev !== undefined && prev <= d) continue;
      seenCommit.set(id, d);
      if (!included.has(id)) included.set(id, obj);
      const parsed = parseCommit(obj.data);
      // Tree and blobs of this commit are always included.
      queue.push({ id: parsed.tree, depth: d });
      if (depth === null || d + 1 < depth) {
        for (const p of parsed.parents) queue.push({ id: p, depth: d + 1 });
      } else {
        boundary.add(id);
      }
    } else if (obj.type === 'tag') {
      if (!included.has(id)) included.set(id, obj);
      const target = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (target !== null) queue.push({ id: target[1], depth: d });
    } else if (obj.type === 'tree') {
      if (!included.has(id)) included.set(id, obj);
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') queue.push({ id: e.id, depth: d });
      }
    } else {
      if (!included.has(id)) included.set(id, obj);
    }
  }

  // Remove anything the client already holds.
  const objects: Array<{ type: GitObjectType; data: Buffer }> = [];
  for (const [id, obj] of included) {
    if (!haveClosure.has(id)) objects.push(obj);
  }
  // Deterministic pack order: commits, tags, trees, blobs, each by id.
  const order: Record<GitObjectType, number> = { commit: 0, tag: 1, tree: 2, blob: 3 };
  objects.sort((a, b) => {
    const oa = order[a.type] - order[b.type];
    if (oa !== 0) return oa;
    return objectId(a.type, a.data) < objectId(b.type, b.data) ? -1 : 1;
  });

  const shallow = depth === null ? [] : [...boundary].filter((id) => !haveClosure.has(id));
  const unshallow: string[] = [];
  for (const s of clientShallow) {
    if (haveClosure.has(s)) {
      // No longer shallow when one of its parents is now delivered.
      const obj = getObject(repo, s);
      if (obj !== undefined && obj.type === 'commit') {
        const parents = parseCommit(obj.data).parents;
        const deliveredParents = parents.filter((p) => objects.some((o) => o.type === 'commit' && objectId('commit', o.data) === p));
        if (deliveredParents.length > 0) unshallow.push(s);
      }
    }
  }
  return { objects, shallow, unshallow };
}

/** Rebuild a branch's file snapshot (path -> bytes) from a commit's tree. */
export function snapshotFromCommit(repo: Repo, commitSha: string): Map<string, Buffer> {
  const flat = new Map<string, { mode: string; id: string }>();
  const obj = getObject(repo, commitSha);
  if (obj !== undefined && obj.type === 'commit') flattenTree(repo, parseCommit(obj.data).tree, '', flat);
  const out = new Map<string, Buffer>();
  for (const [path, e] of flat) {
    const blob = getObject(repo, e.id);
    if (blob !== undefined) out.set(path, blob.data);
  }
  return out;
}

// ------------------------------------------------------------------ advertisements

const UPLOAD_CAPS_V0 = 'multi_ack thin-pack side-band-64k ofs-delta agent=git-forge/1.0 shallow symref=HEAD:refs/heads/main';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=git-forge/1.0';

interface RefInfo {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

function listRefs(repo: Repo): RefInfo[] {
  const out: RefInfo[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  out.push({ oid: mainTip ?? ZERO_OID, name: 'HEAD', symrefTarget: 'refs/heads/main' });
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of refs) {
    out.push({ oid, name });
    if (name.startsWith('refs/tags/')) {
      const obj = getObject(repo, oid);
      if (obj !== undefined && obj.type === 'tag') {
        const target = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (target !== null) out[out.length - 1].peeled = target[1];
      }
    }
  }
  return out;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = listRefs(repo);
  const hasCommits = [...repo.refs.values()].length > 0;
  if (!hasCommits) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, i) => {
      let line = `${ref.oid} ${ref.name}`;
      if (i === 0) line += `\0${caps}`;
      line += '\n';
      lines.push(line);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  lines.push('flush');
  return pktLines(lines as Array<string | Buffer | 'flush' | 'delim'>);
}

function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'agent=git-forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ------------------------------------------------------------------ sideband

/** Frame `data` as sideband band-1 packets (max 65520 bytes per pkt-line). */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const maxChunk = 65515;
  if (data.length === 0) {
    out.push(pktLine(Buffer.from([1])));
    return out;
  }
  for (let i = 0; i < data.length; i += maxChunk) {
    const chunk = data.subarray(i, Math.min(i + maxChunk, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ------------------------------------------------------------------ handlers

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 128 * 1024 * 1024) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
  res.end(body);
}

export async function handleGit(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${ctx.host}`);
  const method = (req.method ?? 'GET').toUpperCase();
  const m = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(url.pathname);
  if (m === null) return false;
  const owner = decodeURIComponent(m[1]);
  const repoName = decodeURIComponent(m[2]);
  const suffix = m[3];
  const repo = ctx.store.getRepo(owner, repoName);
  const gitProtocol = (req.headers['git-protocol'] ?? '') as string;

  if (suffix === 'info/refs') {
    const service = url.searchParams.get('service') ?? '';
    if (repo === undefined) {
      sendGit(res, 404, 'text/plain', Buffer.from('repository not found'));
      return true;
    }
    if (service === 'git-upload-pack') {
      if (gitProtocol === 'version=2') {
        sendGit(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
      } else {
        sendGit(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
      }
      return true;
    }
    if (service === 'git-receive-pack') {
      sendGit(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
      return true;
    }
    sendGit(res, 404, 'text/plain', Buffer.from('unknown service'));
    return true;
  }

  if (suffix === 'git-upload-pack' && method === 'POST') {
    if (repo === undefined) {
      sendGit(res, 404, 'text/plain', Buffer.from('repository not found'));
      return true;
    }
    const body = await readBody(req);
    if (gitProtocol === 'version=2') {
      sendGit(res, 200, 'application/x-git-upload-pack-result', handleUploadPackV2(repo, body));
    } else {
      sendGit(res, 200, 'application/x-git-upload-pack-result', handleUploadPackV0(repo, body));
    }
    return true;
  }

  if (suffix === 'git-receive-pack' && method === 'POST') {
    if (repo === undefined) {
      sendGit(res, 404, 'text/plain', Buffer.from('repository not found'));
      return true;
    }
    const body = await readBody(req);
    sendGit(res, 200, 'application/x-git-receive-pack-result', await handleReceivePack(repo, body));
    return true;
  }

  return false;
}

// ------------------------------------------------------------------ upload-pack

function parseV2Command(body: Buffer): { command: string; wants: string[]; haves: string[]; shallow: string[]; deepen: number | null; prefixes: string[]; peel: boolean; symrefs: boolean; done: boolean } {
  const { packets } = decodePktLines(body);
  let command = '';
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  const prefixes: string[] = [];
  let deepen: number | null = null;
  let peel = false;
  let symrefs = false;
  let done = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) command = line.slice('command='.length);
    else if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'done') done = true;
  }
  return { command, wants, haves, shallow, deepen, prefixes, peel, symrefs, done };
}

function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const req = parseV2Command(body);
  if (req.command === 'ls-refs') {
    const lines: Array<string | 'flush'> = [];
    const refs = listRefs(repo);
    const hasCommits = [...repo.refs.values()].length > 0;
    for (const ref of refs) {
      if (ref.name === 'HEAD') {
        // HEAD obeys the same prefix rule as every ref: real git asks for
        // it with `ref-prefix HEAD`, and the suite's prefix checks never
        // match HEAD, so it stays hidden there.
        if (req.prefixes.length > 0 && !req.prefixes.some((p) => ref.name.startsWith(p))) continue;
        if (!hasCommits) lines.push(`unborn HEAD symref-target:refs/heads/main\n`);
        else lines.push(`${ref.oid} HEAD symref-target:refs/heads/main\n`);
        continue;
      }
      if (req.prefixes.length > 0 && !req.prefixes.some((p) => ref.name.startsWith(p))) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.symrefTarget !== undefined && req.symrefs) line += ` symref-target:${ref.symrefTarget}`;
      if (ref.peeled !== undefined && req.peel) line += ` peeled:${ref.peeled}`;
      line += '\n';
      lines.push(line);
    }
    lines.push('flush');
    return pktLines(lines as Array<string | Buffer | 'flush' | 'delim'>);
  }
  if (req.command === 'fetch') {
    const parts: Buffer[] = [];
    if (req.haves.length > 0) {
      const ackLines: string[] = ['acknowledgments\n'];
      let anyHeld = false;
      for (const have of req.haves) {
        if (getObject(repo, have) !== undefined) {
          ackLines.push(`ACK ${have}\n`);
          anyHeld = true;
        }
      }
      if (!anyHeld) ackLines.push('NAK\n');
      // `ready` invites another negotiation round when the client has not
      // sent `done` yet (real git negotiates; the suite always sends done).
      if (!req.done && anyHeld) ackLines.push('ready\n');
      // The acknowledgments section ends with a delim, like every section
      // except the packfile: a flush here ends the whole response for git.
      parts.push(pktLines([...ackLines, 'delim'] as Array<string | Buffer | 'flush' | 'delim'>));
    }
    const set = collectFetchSet(repo, req.wants, req.haves, req.deepen, req.shallow);
    if (req.deepen !== null || req.shallow.length > 0) {
      const lines: string[] = ['shallow-info\n'];
      for (const s of set.shallow) lines.push(`shallow ${s}\n`);
      for (const s of set.unshallow) lines.push(`unshallow ${s}\n`);
      // Sections are separated by a delim packet (0001), not a flush:
      // real git reads the shallow-info section up to the delim.
      parts.push(pktLines([...lines, 'delim'] as Array<string | Buffer | 'flush' | 'delim'>));
    }
    const pack = writePack(set.objects);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  // Unknown command: answer a flush (the client treats an empty reply as an error).
  return pktLines(['flush']);
}

function parseV0Fetch(body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; deepen: number | null } {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') { section = 1; continue; }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7), 10);
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  return { wants, haves, shallow, deepen };
}

function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const req = parseV0Fetch(body);
  const parts: Buffer[] = [];
  let anyHeld = false;
  for (const have of req.haves) {
    if (getObject(repo, have) !== undefined) {
      parts.push(pktLine(`ACK ${have}\n`));
      anyHeld = true;
    }
  }
  if (req.haves.length > 0 && !anyHeld) parts.push(pktLine('NAK\n'));
  const set = collectFetchSet(repo, req.wants, req.haves, req.deepen, req.shallow);
  if (req.deepen !== null || req.shallow.length > 0) {
    for (const s of set.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of set.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  }
  const pack = writePack(set.objects);
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function handleReceivePack(repo: Repo, body: Buffer): Promise<Buffer> {
  const { packets, next } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const raw = packet.payload.toString('utf8');
    const nul = raw.indexOf('\0');
    const line = (nul >= 0 ? raw.slice(0, nul) : raw).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0].toLowerCase(), newOid: parts[1].toLowerCase(), ref: parts[2] });
  }
  const packBytes = body.subarray(next);
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects } = await readPack(packBytes, repo.objects);
      for (const [id, obj] of objects) {
        if (!repo.objects.has(id)) repo.objects.set(id, { type: obj.type, data: obj.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message.replace(/\n/g, ' ') : 'unpack error';
    }
  }
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined || current.toLowerCase() !== cmd.oldOid) {
          report.push(`ng ${cmd.ref} old ref value does not match\n`);
        } else {
          repo.refs.delete(cmd.ref);
          if (cmd.ref.startsWith('refs/heads/')) repo.branchFiles.delete(cmd.ref);
          report.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          report.push(`ng ${cmd.ref} reference already exists\n`);
          continue;
        }
        const obj = getObject(repo, cmd.newOid);
        if (obj === undefined || (obj.type !== 'commit' && obj.type !== 'tag')) {
          report.push(`ng ${cmd.ref} object not found\n`);
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        if (cmd.ref.startsWith('refs/heads/') && obj.type === 'commit') {
          repo.branchFiles.set(cmd.ref, snapshotFromCommit(repo, cmd.newOid));
        }
        report.push(`ok ${cmd.ref}\n`);
        continue;
      }
      // Update: must fast-forward.
      if (current === undefined || current.toLowerCase() !== cmd.oldOid) {
        report.push(`ng ${cmd.ref} old ref value does not match\n`);
        continue;
      }
      const obj = getObject(repo, cmd.newOid);
      if (obj === undefined || (obj.type !== 'commit' && obj.type !== 'tag')) {
        report.push(`ng ${cmd.ref} object not found\n`);
        continue;
      }
      if (obj.type === 'commit' && !isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        report.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      if (cmd.ref.startsWith('refs/heads/') && obj.type === 'commit') {
        repo.branchFiles.set(cmd.ref, snapshotFromCommit(repo, cmd.newOid));
      }
      report.push(`ok ${cmd.ref}\n`);
    }
  }
  const reportLines: Array<string | 'flush'> = [`unpack ${unpackDetail}\n`, ...report, 'flush'];
  const reportBody = pktLines(reportLines as Array<string | Buffer | 'flush' | 'delim'>);
  // Side-band-64k was advertised and the client negotiates it, so the
  // report travels inside band 1 (itself pkt-lined).
  const parts: Buffer[] = [];
  const maxChunk = 65515;
  for (let i = 0; i < reportBody.length; i += maxChunk) {
    const chunk = reportBody.subarray(i, Math.min(i + maxChunk, reportBody.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
