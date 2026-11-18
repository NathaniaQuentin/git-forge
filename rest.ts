// REST v3 API under /api/v3 — repositories, git refs, contents, labels,
// issues, comments and pull requests. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors are {"message": string}; unknown routes are
// 404 JSON; malformed JSON bodies are 400.
//
// Auth: a missing/empty Authorization header is 401. Any non-empty Bearer
// token authenticates as the scenario viewer (adaiversen); a repository name
// under any other owner is a 404, never a 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';
import {
  VIEWER_LOGIN,
  VIEWER_ID,
  FIXED_CREATED_AT,
  buildTree,
  commitFiles,
  commitSnapshot,
  flattenTree,
  getObject,
  objectId,
  parseCommit,
  collectCommits,
  mergeBase,
} from './store.ts';

export interface RestContext {
  store: Store;
  reqSeq: { value: number };
  host: string;
}

const JSON_CT = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, ctx: RestContext, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': JSON_CT,
    // A known Content-Length avoids chunked framing on every response.
    'Content-Length': Buffer.byteLength(payload),
    'X-GitHub-Request-Id': `req-${++ctx.reqSeq.value}`,
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, ctx: RestContext, status: number, message: string): void {
  sendJson(res, ctx, status, { message });
}

/** Read and parse a JSON request body. Returns null when there is no body. */
export async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).length;
    if (size > 64 * 1024 * 1024) return { ok: false, error: 'request body too large' };
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'malformed JSON body' };
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth === undefined) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m === null ? null : m[1].trim();
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ------------------------------------------------------------ serializers

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_CREATED_AT,
    updated_at: FIXED_CREATED_AT,
    pushed_at: FIXED_CREATED_AT,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    fork: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    license: null,
    language: null,
    topics: [],
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
    size: 0,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${issue.id}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: FIXED_CREATED_AT,
    updated_at: FIXED_CREATED_AT,
    closed_at: issue.state === 'closed' ? FIXED_CREATED_AT : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${pull.id}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    mergeable: !pull.merged,
    mergeable_state: pull.merged ? 'unknown' : 'clean',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    created_at: FIXED_CREATED_AT,
    updated_at: FIXED_CREATED_AT,
    closed_at: pull.state === 'closed' ? FIXED_CREATED_AT : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ------------------------------------------------------------ helpers

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Line-level diff counts via LCS dynamic programming (files here are small). */
function lineDiffCounts(oldBuf: Buffer, newBuf: Buffer): { additions: number; deletions: number } {
  const a = oldBuf.toString('utf8').split('\n');
  const b = newBuf.toString('utf8').split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: m - common, deletions: n - common };
}

/** Diff the file maps of two commits; returns per-file entries. */
function diffCommits(repo: Repo, baseCommit: string, headCommit: string): DiffEntry[] {
  const baseFlat = new Map<string, { mode: string; id: string }>();
  const headFlat = new Map<string, { mode: string; id: string }>();
  const baseObj = getObject(repo, baseCommit);
  const headObj = getObject(repo, headCommit);
  if (baseObj !== undefined && baseObj.type === 'commit') flattenTree(repo, parseCommit(baseObj.data).tree, '', baseFlat);
  if (headObj !== undefined && headObj.type === 'commit') flattenTree(repo, parseCommit(headObj.data).tree, '', headFlat);
  const out: DiffEntry[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b !== undefined && h === undefined) {
      const blob = getObject(repo, b.id);
      const deletions = blob !== undefined ? countLines(blob.data) : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b === undefined && h !== undefined) {
      const blob = getObject(repo, h.id);
      const additions = blob !== undefined ? countLines(blob.data) : 0;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h !== undefined && b.id !== h.id) {
      const oldBlob = getObject(repo, b.id);
      const newBlob = getObject(repo, h.id);
      const { additions, deletions } = lineDiffCounts(oldBlob?.data ?? Buffer.alloc(0), newBlob?.data ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** File map (path -> bytes) of a commit, via its branch snapshot when available. */
function filesAtCommit(repo: Repo, commitSha: string): Map<string, Buffer> {
  for (const [ref, sha] of repo.refs) {
    if (sha === commitSha && ref.startsWith('refs/heads/')) {
      return new Map(repo.branchFiles.get(ref) ?? new Map());
    }
  }
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

function resolveRef(repo: Repo, ref: string): string | undefined {
  if (ref === undefined || ref === '') return undefined;
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  const asTag = repo.refs.get(`refs/tags/${ref}`);
  if (asTag !== undefined) return asTag;
  const obj = getObject(repo, ref);
  if (obj !== undefined && obj.type === 'commit') return ref.toLowerCase();
  return undefined;
}

function paginate<T>(items: T[], url: URL, ctx: RestContext): { page: T[]; link: string } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const origin = `http://${ctx.host}`;
  const mk = (p: number): string => `${origin}/api/v3/user/repos?per_page=${perPage}&page=${p}`;
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${mk(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${mk(page - 1)}>; rel="prev"`);
  parts.push(`<${mk(1)}>; rel="first"`);
  parts.push(`<${mk(totalPages)}>; rel="last"`);
  return { page: slice, link: parts.join(', ') };
}

// ------------------------------------------------------------ router

export async function handleRest(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${ctx.host}`);
  const method = (req.method ?? 'GET').toUpperCase();
  const path = url.pathname;

  if (!path.startsWith('/api/v3')) return false;

  // Root and meta: no repo, but still require a token like every other call.
  if (path === '/api/v3/' || path === '/api/v3') {
    if (bearerToken(req) === null) return sendError(res, ctx, 401, 'Requires authentication'), true;
    return sendJson(res, ctx, 200, {
      current_user_url: '/api/v3/user',
      authorizations_url: '/api/v3/authorizations',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
      emojis_url: '/api/v3/emojis',
      meta: '/api/v3/meta',
    }, { 'X-OAuth-Scopes': 'repo, read:org, user' }), true;
  }
  if (path === '/api/v3/meta') {
    if (bearerToken(req) === null) return sendError(res, ctx, 401, 'Requires authentication'), true;
    return sendJson(res, ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true }), true;
  }

  // Everything below needs a token.
  if (bearerToken(req) === null) return sendError(res, ctx, 401, 'Requires authentication'), true;

  const parts = path.slice('/api/v3/'.length).split('/').map(decodeSegment);

  // ---- GET /user (authenticated user)
  if (parts[0] === 'user' && parts.length === 1 && method === 'GET') {
    return sendJson(res, ctx, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: Buffer.from(`User:${VIEWER_ID}`).toString('base64'),
      name: 'ada iversen',
      email: 'adaiversen@example.invalid',
      type: 'User',
      html_url: `https://example.invalid/${VIEWER_LOGIN}`,
      url: '/api/v3/user',
    }), true;
  }

  // ---- POST /user/repos, GET /user/repos
  if (parts[0] === 'user' && parts[1] === 'repos' && parts.length === 2) {
    if (method === 'GET') {
      const repos = ctx.store.listRepos(VIEWER_LOGIN);
      const { page, link } = paginate(repos, url, ctx);
      return sendJson(res, ctx, 200, page.map(repoJson), { Link: link }), true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, ctx, 400, body.error), true;
      const v = (body.value ?? {}) as Record<string, unknown>;
      const name = typeof v.name === 'string' ? v.name : '';
      if (name === '') return sendError(res, ctx, 422, 'name is required'), true;
      if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) return sendError(res, ctx, 422, 'name already exists on this account'), true;
      const repo = ctx.store.createRepo(VIEWER_LOGIN, name, v.private === true, typeof v.description === 'string' ? v.description : '');
      return sendJson(res, ctx, 201, repoJson(repo)), true;
    }
    return sendError(res, ctx, 404, 'Not Found'), true;
  }

  // ---- /repos/{owner}/{repo}[...]
  if (parts[0] !== 'repos' || parts.length < 3) {
    return sendError(res, ctx, 404, 'Not Found'), true;
  }
  const owner = parts[1];
  const repoName = parts[2];
  const repo = ctx.store.getRepo(owner, repoName);
  const rest = parts.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') {
      if (repo === undefined) return sendError(res, ctx, 404, 'Not Found'), true;
      return sendJson(res, ctx, 200, repoJson(repo)), true;
    }
    if (method === 'PATCH') {
      if (repo === undefined) return sendError(res, ctx, 404, 'Not Found'), true;
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, ctx, 400, body.error), true;
      const v = (body.value ?? {}) as Record<string, unknown>;
      if (typeof v.description === 'string') repo.description = v.description;
      if (typeof v.private === 'boolean') repo.private = v.private;
      return sendJson(res, ctx, 200, repoJson(repo)), true;
    }
    if (method === 'DELETE') {
      if (repo === undefined) return sendError(res, ctx, 404, 'Not Found'), true;
      ctx.store.deleteRepo(owner, repoName);
      res.writeHead(204, { 'X-GitHub-Request-Id': `req-${++ctx.reqSeq.value}` });
      res.end();
      return true;
    }
    return sendError(res, ctx, 404, 'Not Found'), true;
  }

  if (repo === undefined) return sendError(res, ctx, 404, 'Not Found'), true;

  // ---- git/refs
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length > 2) {
    if (method !== 'GET') return sendError(res, ctx, 404, 'Not Found'), true;
    const ref = `refs/${rest.slice(2).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return sendError(res, ctx, 404, 'Not Found'), true;
    return sendJson(res, ctx, 200, { ref, object: { sha, type: 'commit' } }), true;
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2) {
    if (method !== 'POST') return sendError(res, ctx, 404, 'Not Found'), true;
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, ctx, 400, body.error), true;
    const v = (body.value ?? {}) as Record<string, unknown>;
    const ref = typeof v.ref === 'string' ? v.ref : '';
    const sha = typeof v.sha === 'string' ? v.sha.toLowerCase() : '';
    if (!ref.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/.test(sha)) return sendError(res, ctx, 422, 'invalid ref or sha'), true;
    const obj = getObject(repo, sha);
    if (obj === undefined || obj.type !== 'commit') return sendError(res, ctx, 422, 'sha is not a commit in this repository'), true;
    if (repo.refs.has(ref)) return sendError(res, ctx, 422, 'Reference already exists'), true;
    repo.refs.set(ref, sha);
    repo.branchFiles.set(ref, filesAtCommit(repo, sha));
    return sendJson(res, ctx, 201, { ref, object: { sha, type: 'commit' } }), true;
  }

  // ---- branches
  if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
    const sha = repo.refs.get(`refs/heads/${rest[1]}`);
    if (sha === undefined) return sendError(res, ctx, 404, 'Not Found'), true;
    return sendJson(res, ctx, 200, { name: rest[1], commit: { sha }, protected: false }), true;
  }
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches: Array<Record<string, unknown>> = [];
    for (const [ref, sha] of [...repo.refs.entries()].sort()) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
    }
    return sendJson(res, ctx, 200, branches), true;
  }

  // ---- commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const refParam = url.searchParams.get('sha') ?? repo.defaultBranch;
    const tip = resolveRef(repo, refParam);
    if (tip === undefined) return sendJson(res, ctx, 200, []), true;
    const commits = collectCommits(repo, tip, 1000).map((sha) => {
      const obj = getObject(repo, sha);
      const parsed = obj !== undefined ? parseCommit(obj.data) : null;
      return {
        sha,
        commit: {
          message: parsed?.message ?? '',
          author: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: FIXED_CREATED_AT },
          committer: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: FIXED_CREATED_AT },
        },
        author: { login: VIEWER_LOGIN, id: VIEWER_ID },
        committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
        parents: (parsed?.parents ?? []).map((p) => ({ sha: p })),
      };
    });
    return sendJson(res, ctx, 200, commits), true;
  }

  // ---- contents
  if (rest[0] === 'contents') {
    const contentPath = rest.slice(1).join('/');
    return handleContents(req, res, ctx, repo, method, contentPath, url);
  }

  // ---- labels
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return sendJson(res, ctx, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, default: false }))), true;
    }
    if (method === 'POST' && rest.length === 1) {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, ctx, 400, body.error), true;
      const v = (body.value ?? {}) as Record<string, unknown>;
      const name = typeof v.name === 'string' ? v.name : '';
      if (name === '') return sendError(res, ctx, 422, 'name is required'), true;
      const color = typeof v.color === 'string' ? v.color : 'ededed';
      repo.labels.set(name, { name, color });
      return sendJson(res, ctx, 201, { name, color, default: false, description: '' }), true;
    }
    return sendError(res, ctx, 404, 'Not Found'), true;
  }

  // ---- issues
  if (rest[0] === 'issues') {
    return handleIssues(req, res, ctx, repo, method, rest.slice(1), url);
  }

  // ---- pulls
  if (rest[0] === 'pulls') {
    return handlePulls(req, res, ctx, repo, method, rest.slice(1), url);
  }

  return sendError(res, ctx, 404, 'Not Found'), true;
}

// ------------------------------------------------------------ contents

async function handleContents(
  req: IncomingMessage, res: ServerResponse, ctx: RestContext, repo: Repo,
  method: string, contentPath: string, url: URL,
): Promise<boolean> {
  const refParam = url.searchParams.get('ref') ?? repo.defaultBranch;
  const ref = `refs/heads/${refParam}`;
  const files = repo.branchFiles.get(ref);

  if (method === 'GET') {
    if (files === undefined) return sendError(res, ctx, 404, 'Not Found'), true;
    const direct = files.get(contentPath);
    if (direct !== undefined) {
      const sha = objectId('blob', direct);
      return sendJson(res, ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: direct.length,
        name: contentPath.split('/').pop() ?? contentPath,
        path: contentPath,
        content: direct.toString('base64'),
        sha,
      }), true;
    }
    // Directory listing: immediate children of the prefix.
    const prefix = contentPath === '' ? '' : `${contentPath}/`;
    const children = new Map<string, { type: string; path: string; sha: string }>();
    for (const [path, content] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        children.set(rest, { type: 'file', path, sha: objectId('blob', content) });
      } else {
        const dirName = rest.slice(0, slash);
        if (!children.has(dirName)) {
          children.set(dirName, { type: 'dir', path: `${prefix}${dirName}`, sha: '' });
        }
      }
    }
    if (children.size === 0) return sendError(res, ctx, 404, 'Not Found'), true;
    // Fill directory shas from subtree trees.
    const entries = [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, e]) => {
      let sha = e.sha;
      if (e.type === 'dir') {
        const sub = new Map<string, string>();
        for (const [path, content] of files) {
          if (path.startsWith(`${e.path}/`)) sub.set(path.slice(e.path.length + 1), objectId('blob', content));
        }
        sha = buildTree(repo, sub);
      }
      return { type: e.type, name, path: e.path, sha };
    });
    return sendJson(res, ctx, 200, entries), true;
  }

  if (method === 'PUT') {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, ctx, 400, body.error), true;
    const v = (body.value ?? {}) as Record<string, unknown>;
    const message = typeof v.message === 'string' ? v.message : 'Update';
    const branch = typeof v.branch === 'string' && v.branch !== '' ? v.branch : repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    let branchFiles = repo.branchFiles.get(branchRef);
    const hasRef = repo.refs.has(branchRef);
    if (!hasRef && repo.refs.size > 0) return sendError(res, ctx, 422, 'branch does not exist'), true;
    if (branchFiles === undefined) branchFiles = new Map();
    const contentB64 = typeof v.content === 'string' ? v.content : '';
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    } catch {
      return sendError(res, ctx, 422, 'content is not valid base64'), true;
    }
    const existing = branchFiles.get(contentPath);
    const isUpdate = existing !== undefined;
    if (isUpdate) {
      const currentSha = objectId('blob', existing as Buffer);
      if (typeof v.sha === 'string' && v.sha.toLowerCase() !== currentSha) {
        return sendError(res, ctx, 409, 'sha does not match the current blob'), true;
      }
    }
    const changes = new Map<string, Buffer | null>([[contentPath, content]]);
    const commitSha = commitFiles(repo, branch, message, changes);
    const blobSha = objectId('blob', content);
    return sendJson(res, ctx, isUpdate ? 200 : 201, {
      content: { name: contentPath.split('/').pop() ?? contentPath, path: contentPath, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    }), true;
  }

  if (method === 'DELETE') {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, ctx, 400, body.error), true;
    const v = (body.value ?? {}) as Record<string, unknown>;
    const message = typeof v.message === 'string' ? v.message : 'Delete';
    const branch = typeof v.branch === 'string' && v.branch !== '' ? v.branch : repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    const branchFiles = repo.branchFiles.get(branchRef);
    if (branchFiles === undefined) return sendError(res, ctx, 404, 'Not Found'), true;
    const existing = branchFiles.get(contentPath);
    if (existing === undefined) return sendError(res, ctx, 404, 'Not Found'), true;
    if (typeof v.sha === 'string' && v.sha.toLowerCase() !== objectId('blob', existing)) {
      return sendError(res, ctx, 409, 'sha does not match the current blob'), true;
    }
    const commitSha = commitFiles(repo, branch, message, new Map([[contentPath, null]]));
    return sendJson(res, ctx, 200, { commit: { sha: commitSha, message } }), true;
  }

  return sendError(res, ctx, 404, 'Not Found'), true;
}

// ------------------------------------------------------------ issues (shared)

export function createIssueObj(store: Store, repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    id: store.nextId(),
    number: ++repo.issueSeq,
    title,
    body,
    state: 'open',
    labels,
    seq: ++store.globalSeq,
    comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

export function addCommentObj(repo: Repo, issue: Issue, body: string): { id: number; body: string } {
  const comment = { id: ++repo.commentSeq, body };
  issue.comments.push(comment);
  return comment;
}

async function handleIssues(
  req: IncomingMessage, res: ServerResponse, ctx: RestContext, repo: Repo,
  method: string, rest: string[], url: URL,
): Promise<boolean> {
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, ctx, 400, body.error), true;
      const v = (body.value ?? {}) as Record<string, unknown>;
      const title = typeof v.title === 'string' ? v.title : '';
      const bodyText = typeof v.body === 'string' ? v.body : '';
      const labelNames = Array.isArray(v.labels) ? (v.labels as unknown[]).filter((l) => typeof l === 'string') as string[] : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return sendError(res, ctx, 422, `label "${name}" does not exist`), true;
      }
      const issue = createIssueObj(ctx.store, repo, title, bodyText, labelNames);
      return sendJson(res, ctx, 201, issueJson(repo, issue)), true;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = repo.issues.filter((i) => state === 'all' || i.state === state);
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
      const slice = list.slice((page - 1) * perPage, page * perPage);
      return sendJson(res, ctx, 200, slice.map((i) => issueJson(repo, i))), true;
    }
    return sendError(res, ctx, 404, 'Not Found'), true;
  }

  const num = Number(rest[0]);
  if (!Number.isInteger(num) || num < 1) return sendError(res, ctx, 404, 'Not Found'), true;
  const issue = repo.issues.find((i) => i.number === num);

  if (rest.length === 1) {
    if (method === 'GET') {
      if (issue === undefined) return sendError(res, ctx, 404, 'Not Found'), true;
      return sendJson(res, ctx, 200, issueJson(repo, issue)), true;
    }
    if (method === 'PATCH') {
      if (issue === undefined) return sendError(res, ctx, 404, 'Not Found'), true;
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, ctx, 400, body.error), true;
      const v = (body.value ?? {}) as Record<string, unknown>;
      if (v.state === 'open' || v.state === 'closed') issue.state = v.state;
      if (typeof v.title === 'string') issue.title = v.title;
      if (typeof v.body === 'string') issue.body = v.body;
      return sendJson(res, ctx, 200, issueJson(repo, issue)), true;
    }
    return sendError(res, ctx, 404, 'Not Found'), true;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return sendError(res, ctx, 404, 'Not Found'), true;
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, ctx, 400, body.error), true;
      const v = (body.value ?? {}) as Record<string, unknown>;
      const comment = addCommentObj(repo, issue, typeof v.body === 'string' ? v.body : '');
      return sendJson(res, ctx, 201, {
        id: comment.id,
        node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
        body: comment.body,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID },
        created_at: FIXED_CREATED_AT,
        updated_at: FIXED_CREATED_AT,
      }), true;
    }
    if (method === 'GET') {
      return sendJson(res, ctx, 200, issue.comments.map((c) => ({
        id: c.id,
        body: c.body,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID },
        created_at: FIXED_CREATED_AT,
        updated_at: FIXED_CREATED_AT,
      }))), true;
    }
    return sendError(res, ctx, 404, 'Not Found'), true;
  }

  return sendError(res, ctx, 404, 'Not Found'), true;
}

// ------------------------------------------------------------ pulls (shared)

interface DiffEntry {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Three-way merge of a pull request: base = merge-base, head = PR head,
 * tip = CURRENT base-branch tip. Returns the merged file map, or null when
 * a path was changed differently on both sides (a conflict). */
export function computeMerge(repo: Repo, pull: Pull): Map<string, Buffer> | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const baseCommit = mergeBase(repo, pull.headSha, baseTip);
  const baseFiles = baseCommit === null ? new Map<string, Buffer>() : filesAtCommit(repo, baseCommit);
  const headFiles = filesAtCommit(repo, pull.headSha);
  const tipFiles = filesAtCommit(repo, baseTip);
  const merged = new Map<string, Buffer>();
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const t = tipFiles.get(path);
    const eq = (x: Buffer | undefined, y: Buffer | undefined): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.equals(y));
    if (eq(h, b)) {
      if (t !== undefined) merged.set(path, t);
    } else if (eq(t, b)) {
      if (h !== undefined) merged.set(path, h);
    } else if (eq(h, t)) {
      if (h !== undefined) merged.set(path, h);
    } else {
      return null;
    }
  }
  return merged;
}

/** Apply a squash merge of an open pull request onto its base branch.
 * Returns the merge commit sha, or null when the PR is closed or conflicts. */
export function mergePull(repo: Repo, pull: Pull): string | null {
  if (pull.state !== 'open') return null;
  const merged = computeMerge(repo, pull);
  if (merged === null) return null;
  const commitSha = commitSnapshot(repo, pull.baseRef, `Merge pull request #${pull.number} from ${pull.headRef}`, merged);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_CREATED_AT;
  pull.mergeCommitSha = commitSha;
  return commitSha;
}

/** Whether an open PR would merge cleanly (computed, not stored). */
export function prMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  if (pull.state !== 'open') return 'CONFLICTING';
  return computeMerge(repo, pull) === null ? 'CONFLICTING' : 'MERGEABLE';
}

/** Changed files of a PR (snapshot taken at creation, else a live diff). */
export function prFilesOf(repo: Repo, pull: Pull): DiffEntry[] {
  return (pull as Pull & { files?: DiffEntry[] }).files ?? diffCommits(repo, pull.baseSha, pull.headSha);
}

/** Create a pull request; returns null when head or base branch is missing. */
export function createPullObj(store: Store, repo: Repo, head: string, base: string, title: string, body: string): Pull | null {
  const headSha = resolveRef(repo, head);
  const baseSha = resolveRef(repo, base);
  if (headSha === undefined || baseSha === undefined) return null;
  const pull: Pull = {
    id: store.nextId(),
    number: ++repo.pullSeq,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: '',
    mergeCommitSha: '',
    seq: ++store.globalSeq,
  };
  (pull as Pull & { files?: DiffEntry[] }).files = diffCommits(repo, baseSha, headSha);
  repo.pulls.push(pull);
  return pull;
}

async function handlePulls(
  req: IncomingMessage, res: ServerResponse, ctx: RestContext, repo: Repo,
  method: string, rest: string[], url: URL,
): Promise<boolean> {
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, ctx, 400, body.error), true;
      const v = (body.value ?? {}) as Record<string, unknown>;
      const head = typeof v.head === 'string' ? v.head : '';
      const base = typeof v.base === 'string' ? v.base : '';
      const pull = createPullObj(
        ctx.store, repo, head, base,
        typeof v.title === 'string' ? v.title : '',
        typeof v.body === 'string' ? v.body : '',
      );
      if (pull === null) return sendError(res, ctx, 422, 'head or base branch does not exist'), true;
      return sendJson(res, ctx, 201, pullJson(repo, pull)), true;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
      return sendJson(res, ctx, 200, list.map((p) => pullJson(repo, p))), true;
    }
    return sendError(res, ctx, 404, 'Not Found'), true;
  }

  const num = Number(rest[0]);
  if (!Number.isInteger(num) || num < 1) return sendError(res, ctx, 404, 'Not Found'), true;
  const pull = repo.pulls.find((p) => p.number === num);

  if (rest.length === 1) {
    if (method === 'GET') {
      if (pull === undefined) return sendError(res, ctx, 404, 'Not Found'), true;
      return sendJson(res, ctx, 200, pullJson(repo, pull)), true;
    }
    return sendError(res, ctx, 404, 'Not Found'), true;
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (pull === undefined) return sendError(res, ctx, 404, 'Not Found'), true;
    const files = prFilesOf(repo, pull);
    return sendJson(res, ctx, 200, files.map((f) => ({
      sha: '',
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    }))), true;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return sendError(res, ctx, 404, 'Not Found'), true;
    if (pull.state !== 'open') return sendError(res, ctx, 405, 'Pull request is not open'), true;
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, ctx, 400, body.error), true;
    const commitSha = mergePull(repo, pull);
    if (commitSha === null) return sendError(res, ctx, 405, 'Merge conflict'), true;
    return sendJson(res, ctx, 200, {
      merged: true,
      sha: commitSha,
      message: 'Pull request successfully merged',
    }), true;
  }

  return sendError(res, ctx, 404, 'Not Found'), true;
}
