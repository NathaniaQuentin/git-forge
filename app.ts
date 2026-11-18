// The forge's HTTP surface: a health probe, git smart HTTP, REST v3,
// GraphQL and MCP — all on one server, one shared in-memory store.
//
// main.ts is the entry <-> env lifecycle and stays as it ships; this file
// is the server, grown from the starter.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type RestContext } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const ctx: RestContext = {
    store,
    reqSeq: { value: 0 },
    host: '127.0.0.1',
  };
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    ctx.host = req.headers.host ?? '127.0.0.1';

    void (async () => {
      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/api/graphql') {
          if (await handleGraphQL(req, res, ctx)) return;
        }
        if (path === '/mcp') {
          if (await handleMcp(req, res, ctx)) return;
        }
        if (path.startsWith('/api/v3')) {
          if (await handleRest(req, res, ctx)) return;
        }
        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          if (await handleGit(req, res, ctx)) return;
        }
        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, { 'X-GitHub-Request-Id': `req-${++ctx.reqSeq.value}` });
      } catch (err) {
        // Never crash the server on a bad request: answer 500 JSON.
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' }, { 'X-GitHub-Request-Id': `req-${++ctx.reqSeq.value}` });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
