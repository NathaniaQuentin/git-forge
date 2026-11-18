// MCP at /mcp — JSON-RPC 2.0 Streamable HTTP (plain JSON responses).
// Modern revision 2026-07-28 via server/discover, plus the legacy
// initialize handshake. Six tools act on the same store as REST/GraphQL.
//
// Auth: no Authorization header on any POST is HTTP 401, decided before
// tool existence. Unknown tool: -32601. Missing arguments: -32602.
// Non-JSON body: HTTP 400 with -32700.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, VIEWER_ID } from './store.ts';
import type { Store, Repo } from './store.ts';
import {
  addCommentObj,
  createIssueObj,
  createPullObj,
  mergePull,
  prFilesOf,
  readJsonBody,
  sendJson,
  type RestContext,
} from './rest.ts';

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Built once: tools/list must be byte-for-byte identical across calls.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo"' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo"' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo"' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo"' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo"' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        number: { type: 'integer', description: 'Pull request number (alias)' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function resolveRepo(store: Store, args: Record<string, unknown>): { owner: string; repo: Repo } | null {
  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [owner, name] = args.full_name.split('/', 2);
    const repo = store.getRepo(owner, name);
    return repo === undefined ? null : { owner, repo };
  }
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (name === '') return null;
  const repo = store.getRepo(owner, name);
  return repo === undefined ? null : { owner, repo };
}

function toolOk(payload: unknown): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload, isError: false };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

type ToolHandler = (store: Store, args: Record<string, unknown>) => Record<string, unknown>;

const HANDLERS: Record<string, ToolHandler> = {
  create_repo(store, args) {
    const name = typeof args.name === 'string' ? args.name : '';
    if (name === '') return toolErr('name is required');
    const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
    if (store.getRepo(owner, name) !== undefined) return toolErr(`repository "${owner}/${name}" already exists`);
    const repo = store.createRepo(owner, name, args.private === true, typeof args.description === 'string' ? args.description : '');
    return toolOk({
      id: repo.id,
      name: repo.name,
      full_name: `${owner}/${name}`,
      owner: { login: owner },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    });
  },
  get_repo(store, args) {
    const found = resolveRepo(store, args);
    if (found === null) return toolErr('repository not found');
    const { owner, repo } = found;
    return toolOk({
      id: repo.id,
      name: repo.name,
      full_name: `${owner}/${repo.name}`,
      owner: { login: owner },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    });
  },
  create_issue(store, args) {
    const found = resolveRepo(store, args);
    if (found === null) return toolErr('repository not found');
    const title = typeof args.title === 'string' ? args.title : '';
    if (title === '') return toolErr('title is required');
    const issue = createIssueObj(store, found.repo, title, typeof args.body === 'string' ? args.body : '', []);
    return toolOk({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: 'open',
      full_name: `${found.owner}/${found.repo.name}`,
    });
  },
  list_issues(store, args) {
    const found = resolveRepo(store, args);
    if (found === null) return toolErr('repository not found');
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = found.repo.issues.filter((i) => state === 'all' || i.state === state);
    return toolOk({
      issues: list.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels })),
      total_count: list.length,
      full_name: `${found.owner}/${found.repo.name}`,
    });
  },
  create_pull_request(store, args) {
    const found = resolveRepo(store, args);
    if (found === null) return toolErr('repository not found');
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : '';
    if (title === '' || head === '' || base === '') return toolErr('title, head and base are required');
    const pull = createPullObj(store, found.repo, head, base, title, typeof args.body === 'string' ? args.body : '');
    if (pull === null) return toolErr('head or base branch does not exist');
    return toolOk({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: 'open',
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
      files: prFilesOf(found.repo, pull).map((f) => f.filename),
      full_name: `${found.owner}/${found.repo.name}`,
    });
  },
  merge_pull_request(store, args) {
    const found = resolveRepo(store, args);
    if (found === null) return toolErr('repository not found');
    const raw = args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number;
    const num = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(num) || num < 1) return toolErr('pull_number is required');
    const pull = found.repo.pulls.find((p) => p.number === num);
    if (pull === undefined) return toolErr('pull request not found');
    const sha = mergePull(found.repo, pull);
    if (sha === null) return toolErr('pull request cannot be merged (conflict or already closed)');
    return toolOk({ number: pull.number, merged: true, state: 'closed', sha, full_name: `${found.owner}/${found.repo.name}` });
  },
};

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const err: Record<string, unknown> = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function missingRequired(tool: ToolDef, args: Record<string, unknown>): string | null {
  const required = (tool.inputSchema.required ?? []) as string[];
  for (const prop of required) {
    if (args[prop] === undefined || args[prop] === null || args[prop] === '') return prop;
  }
  return null;
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${ctx.host}`);
  if (url.pathname !== '/mcp') return false;
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'DELETE') {
    res.writeHead(204, { 'X-GitHub-Request-Id': `req-${++ctx.reqSeq.value}` });
    res.end();
    return true;
  }
  if (method !== 'POST') return false;

  // Auth is decided before anything else, including tool existence.
  const auth = req.headers.authorization;
  if (auth === undefined || !/^Bearer\s+\S+/.test(auth.trim())) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Request-Id': `req-${++ctx.reqSeq.value}` });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return true;
  }

  // Raw body read (we need the exact bytes for the parse-error path).
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).length;
    if (size > 64 * 1024 * 1024) break;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Best effort: recover the id from the truncated text for the echo.
    let id: unknown = null;
    const m = /"id"\s*:\s*("([^"]*)"|(-?\d+))/.exec(text);
    if (m !== null) id = m[2] !== undefined ? m[2] : Number(m[3]);
    return sendJson(res, ctx, 400, rpcError(id, -32700, 'Parse error')), true;
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return sendJson(res, ctx, 400, rpcError(null, -32600, 'Invalid Request')), true;
  }
  const id = request.id ?? null;
  const rpcMethod = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (rpcMethod === 'server/discover') {
    return sendJson(res, ctx, 200, rpcResult(id, {
      supportedVersions: SUPPORTED_REVISIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    })), true;
  }
  if (rpcMethod === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    if (!SUPPORTED_REVISIONS.includes(offered)) {
      return sendJson(res, ctx, 200, rpcError(id, -32602, `unsupported protocol version ${offered}`)), true;
    }
    return sendJson(res, ctx, 200, rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    })), true;
  }
  if (rpcMethod === 'notifications/initialized') {
    res.writeHead(202, { 'X-GitHub-Request-Id': `req-${++ctx.reqSeq.value}` });
    res.end();
    return true;
  }
  if (rpcMethod === 'ping') {
    return sendJson(res, ctx, 200, rpcResult(id, {})), true;
  }
  if (rpcMethod === 'tools/list') {
    return sendJson(res, ctx, 200, rpcResult(id, { tools: TOOLS })), true;
  }
  if (rpcMethod === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined) {
      return sendJson(res, ctx, 200, rpcError(id, -32601, `unknown tool ${name}`)), true;
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return sendJson(res, ctx, 200, rpcError(id, -32602, 'arguments must be an object')), true;
    }
    const missing = missingRequired(tool, args);
    if (missing !== null) {
      return sendJson(res, ctx, 200, rpcError(id, -32602, `missing required argument: ${missing}`)), true;
    }
    const handler = HANDLERS[name];
    const result = handler(ctx.store, args);
    return sendJson(res, ctx, 200, rpcResult(id, result)), true;
  }
  return sendJson(res, ctx, 200, rpcError(id, -32601, `method not found: ${rpcMethod}`)), true;
}

export { VIEWER_ID };
