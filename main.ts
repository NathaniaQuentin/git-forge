// The entry <-> env lifecycle, as env/src/wire.ts settles it: bind an ephemeral port, check the
// server answers its own boot probe, tell the env the port it bound, then poll until the env says
// the trial is over and exit 0. Revised from the kit starter: the starter registered the port
// without ever asking the server whether it worked, so a server that could not answer would hand
// the env a dead endpoint and fail the whole trial with confusing errors. The self-check below
// fails fast, before register, with a message that says exactly what is wrong.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a trial container). Without it
//      there is nothing to talk to, so the program exits 1 at once.
//   2. Create the server and listen(0): the kernel picks a free port. Never bind 8080 — the env owns it.
//   3. GET the server's own /healthz on that port, a few times: the env's boot check does the same
//      probe twice after register, so a server that cannot answer it is caught here, before register,
//      instead of failing the trial after it.
//   4. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request came from
//      plus N as your base URL and dials it from then on. The first register wins; a 409 means another
//      entry already registered, and this process keeps waiting like any other.
//   5. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once ({"done":
//      false} while the suite runs), so this is a poll, not a long-held request. A failed or slow poll
//      is retried with a short exponential backoff; the process never exits before the env says done.
//   6. Close the server and exit 0. The harness then stops the env, which writes the export the scorer
//      reads.
//
// main.ts imports its own server and nothing else: no package, no Node built-in, no model call.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/** How many times the entry probes its own health endpoint before registering, and the waits. */
const SELF_CHECK_ATTEMPTS = 3;
const SELF_CHECK_TIMEOUT_MS = 1_000;
const SELF_CHECK_DELAY_MS = 100;

/**
 * Ask the server just bound whether it answers its own boot probe. The env's boot check does the
 * same GET /healthz twice after register; a server that cannot answer it would register a dead
 * endpoint and fail the whole trial with confusing errors. A few tries are allowed because the
 * server has only just bound; a server that never answers is a broken entry, and failing here,
 * before register, says exactly that instead of wasting the trial.
 */
async function selfCheck(port: number): Promise<void> {
  for (let attempt = 1; attempt <= SELF_CHECK_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(SELF_CHECK_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { ok?: unknown };
        if (body.ok === true) return;
      }
    } catch {
      // Not answering yet: try again after a short wait.
    }
    if (attempt < SELF_CHECK_ATTEMPTS) await sleep(SELF_CHECK_DELAY_MS);
  }
  throw new Error(`the server does not answer its own GET /healthz on port ${port}`);
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means a first register
 * already won, which is not this process's to fix. 400 and 405 are contract errors and end the program;
 * a network error or another status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await selfCheck(address.port);
  process.stdout.write('[entry] self-check passed; registering with the env\n');

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
