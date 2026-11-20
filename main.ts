// main.ts — the entrypoint of the github-core-clone-01 forge.
//
// Lifecycle (the trial wire, see the kit's RULES.txt):
//   1. bind an ephemeral port of our own (never 8080, where the suite listens);
//   2. POST {"port": <port>} to $MAKEFUN_ENV_URL/register so the suite can dial us back;
//   3. serve the forge on that port (GET /healthz answers 200 {"ok": true});
//   4. long-poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}, then exit 0.
// MAKEFUN_ENV_URL unset means there is no suite to serve: exit 1 at once.
// Register and poll failures are retried with a short exponential backoff.

import { createForgeServer } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const REGISTER_PATH = '/register';
const DONE_PATH = '/done';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST {"port"} to the suite's register endpoint, retrying with backoff. */
async function register(envUrl: string, port: number): Promise<void> {
  const target = `${envUrl.replace(/\/+$/, '')}${REGISTER_PATH}`;
  let delayMs = 100;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status >= 200 && response.status < 300) return;
      await response.text().catch(() => undefined);
    } catch {
      // The suite may not be listening yet; back off and try again.
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 5000);
  }
  throw new Error(`could not register at ${target} after 30 attempts`);
}

/** Long-poll the suite's done endpoint until it answers {"done": true}. */
async function waitForDone(envUrl: string): Promise<void> {
  const target = `${envUrl.replace(/\/+$/, '')}${DONE_PATH}`;
  let delayMs = 250;
  for (;;) {
    try {
      const response = await fetch(target, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      if (response.status === 200) {
        const body = (await response.json().catch(() => null)) as { done?: unknown } | null;
        if (body !== null && body.done === true) return;
      }
      delayMs = 250;
    } catch {
      // A dropped poll is not a verdict; back off briefly and ask again.
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 5000);
  }
}

async function main(): Promise<number> {
  if (ENV_URL === '') {
    console.error('MAKEFUN_ENV_URL is not set; nothing to register with');
    return 1;
  }
  const server = createForgeServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 0) {
    console.error('the forge bound no port');
    return 1;
  }
  await register(ENV_URL, port);
  await waitForDone(ENV_URL);
  server.close();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
