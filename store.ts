// In-memory store for the forge: git objects, refs, and the GitHub resources
// (repositories, issues, labels, comments, pull requests) all in one place so
// git, REST, GraphQL and MCP always read back the same state.
//
// Determinism: no wall clock or randomness enters any stored value. Commit
// author/committer lines use a fixed timestamp; issue/PR created_at values are
// fixed strings and ordering uses creation sequence numbers. The trial pod is
// one process, so an in-memory store is the forge's own store; nothing needs
// to survive the process.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** Fixed author/committer stamp used for every commit this forge creates. */
export const FIXED_GIT_TIME = '1739175597 +0000';
export const FIXED_AUTHOR = 'ada iversen <adaiversen@example.invalid>';
/** The scenario's viewer: the login the suite's bearer token names (wire.ts
 * buildScenario(), deterministic from the published SCENARIO_SEED). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
/** Fixed created_at/updated_at string for every REST resource. */
export const FIXED_CREATED_AT = '2026-01-01T00:00:00Z';

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of a git object: sha1("<type> <len>\0" + payload). */
export function objectId(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([header, data]));
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
export function isZeroOid(oid: string): boolean {
  return oid === ZERO_OID;
}
export function isHex40(s: string): boolean {
  return /^[0-9a-f]{40}$/i.test(s);
}

// ------------------------------------------------------------------ resources

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: Array<{ id: number; body: string }>;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  /** branch refname -> path -> file bytes (the working snapshot of that branch) */
  branchFiles: Map<string, Map<string, Buffer>>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
  seq: number;
}

export class Store {
  repos: Map<string, Repo> = new Map(); // `${owner}/${name}` -> Repo
  repoSeq = 0;
  globalSeq = 0;
  idSeq = 0;

  /** A globally unique integer id for issues, pulls, comments, etc. */
  nextId(): number {
    return ++this.idSeq;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: ++this.repoSeq,
      name,
      owner,
      private: isPrivate,
      description: description ?? '',
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      branchFiles: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      issueSeq: 0,
      pullSeq: 0,
      commentSeq: 0,
      seq: ++this.globalSeq,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}

// ------------------------------------------------------------------ git objects

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const id = objectId(type, data);
  if (!repo.objects.has(id)) repo.objects.set(id, { type, data });
  return id;
}

export function getObject(repo: Repo, id: string): GitObject | undefined {
  return repo.objects.get(id.toLowerCase());
}

/** Build a tree object from a flat path -> blob-id map. Returns the tree sha. */
export function buildTree(repo: Repo, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, blobId] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], blobId);
  }
  function writeTree(node: Node): string {
    const entries: Array<{ name: string; mode: string; id: string; isDir: boolean }> = [];
    for (const [name, id] of node.files) entries.push({ name, mode: '100644', id, isDir: false });
    for (const [name, child] of node.dirs) entries.push({ name, mode: '40000', id: writeTree(child), isDir: true });
    entries.sort((a, b) => {
      const an = a.isDir ? `${a.name}/` : a.name;
      const bn = b.isDir ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const chunks: Buffer[] = [];
    for (const e of entries) {
      chunks.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      chunks.push(Buffer.from(e.id, 'hex'));
    }
    return putObject(repo, 'tree', Buffer.concat(chunks));
  }
  return writeTree(root);
}

/** Parse a tree object's entries: [{mode, name, id}]. */
export function parseTree(data: Buffer): Array<{ mode: string; name: string; id: string }> {
  const out: Array<{ mode: string; name: string; id: string }> = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const nul = data.indexOf(0x00, sp);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(i, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const id = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, id });
    i = nul + 21;
  }
  return out;
}

/** Flatten a tree into path -> {mode, blobId} by walking tree objects. */
export function flattenTree(repo: Repo, treeId: string, prefix: string, out: Map<string, { mode: string; id: string }>): void {
  const obj = getObject(repo, treeId);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.id, path, out);
    else out.set(path, { mode: e.mode, id: e.id });
  }
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; raw: Buffer } {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep >= 0 ? text.slice(0, sep) : text;
  const message = sep >= 0 ? text.slice(sep + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message, raw: data };
}

/**
 * Create a commit on a branch from a full file map (path -> bytes). Applies
 * `changes` (null value deletes a path) to the branch snapshot, writes blob /
 * tree / commit objects, moves the ref, and returns the new commit sha.
 */
export function commitFiles(
  repo: Repo,
  branch: string,
  message: string,
  changes: Map<string, Buffer | null>,
): string {
  const ref = `refs/heads/${branch}`;
  const current = repo.branchFiles.get(ref) ?? new Map<string, Buffer>();
  const files = new Map(current);
  for (const [path, content] of changes) {
    if (content === null) files.delete(path);
    else files.set(path, content);
  }
  return commitSnapshot(repo, branch, message, files);
}

/**
 * Create a commit on a branch replacing its whole file snapshot with
 * `files` (path -> bytes). Returns the new commit sha.
 */
export function commitSnapshot(repo: Repo, branch: string, message: string, files: Map<string, Buffer>): string {
  const ref = `refs/heads/${branch}`;
  const blobIds = new Map<string, string>();
  for (const [path, content] of files) blobIds.set(path, putObject(repo, 'blob', content));
  const treeId = buildTree(repo, blobIds);
  const parent = repo.refs.get(ref);
  const lines: string[] = [`tree ${treeId}`];
  if (parent !== undefined && !isZeroOid(parent)) lines.push(`parent ${parent}`);
  lines.push(`author ${FIXED_AUTHOR} ${FIXED_GIT_TIME}`);
  lines.push(`committer ${FIXED_AUTHOR} ${FIXED_GIT_TIME}`);
  const commitData = Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
  const commitId = putObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitId);
  repo.branchFiles.set(ref, new Map(files));
  return commitId;
}

/** Is `ancestor` reachable from `tip` by walking parents? */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack: string[] = [tip];
  let guard = 0;
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (++guard > 100000) return false;
    const obj = getObject(repo, cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** Collect all commits reachable from `tip` (newest-first walk, capped). */
export function collectCommits(repo: Repo, tip: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0 && out.length < limit) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(cur);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return out;
}

/** Find a merge base of two commits (first common ancestor in BFS order). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const qa: string[] = [a];
  let guard = 0;
  while (qa.length > 0) {
    const cur = qa.shift() as string;
    if (ancestorsA.has(cur)) continue;
    ancestorsA.add(cur);
    if (++guard > 100000) break;
    const obj = getObject(repo, cur);
    if (obj !== undefined && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) qa.push(p);
    }
  }
  const qb: string[] = [b];
  const seenB = new Set<string>();
  guard = 0;
  while (qb.length > 0) {
    const cur = qb.shift() as string;
    if (ancestorsA.has(cur)) return cur;
    if (seenB.has(cur)) continue;
    seenB.add(cur);
    if (++guard > 100000) break;
    const obj = getObject(repo, cur);
    if (obj !== undefined && obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) qb.push(p);
    }
  }
  return null;
}
