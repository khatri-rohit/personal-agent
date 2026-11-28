import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseServerInfo, SERVER_FILE, serverOrigin, type ServerInfo } from '@agent/agent-models';

import { ApiClient } from '../runner/api-client.js';
import { harnessVersion } from '../runner/runner.js';
import { evalHome, flag, intFlag, type Args } from './args.js';

/** Only a fallback now: the eval server records its real port in `<eval home>/server.json`. */
export const EVAL_API_PORT = 3334;

export function evalApiBase(port: number = EVAL_API_PORT): string {
  return `http://localhost:${port}/api/agent`;
}

function serverInfo(home: string): ServerInfo | null {
  try {
    return parseServerInfo(JSON.parse(readFileSync(path.join(home, SERVER_FILE), 'utf8')));
  } catch {
    return null;
  }
}

/** The eval home's server, from its `server.json`; the fixed port when it has none. */
export function evalApiBaseFor(home: string): string {
  const info = serverInfo(home);
  return info ? `${serverOrigin(info)}/api/agent` : evalApiBase();
}

export const UP_HELP = `up [--port <n>] [--eval-home <dir>]
  Start an API for evals: \`agent serve --home <eval home> --no-ui\` on a free port (or --port), built first,
  no watch (the code under test never reloads mid-suite). It records its port in <eval home>/server.json,
  which run and gate read. Stays in the foreground; Ctrl+C stops it. Your chat API on 3333 keeps running.
  If the eval home's server already runs this checkout's code, up says so and exits; if it runs other
  code, up refuses: stop it first. Then in another terminal: run --suite matrix.`;

function token(home: string): string | undefined {
  const file = path.join(home, 'api-token');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined;
}

/** The server answering for this home, with the code it runs; null when none does. */
async function running(home: string) {
  const info = serverInfo(home);
  if (!info) return null;
  try {
    const live = await new ApiClient(`${serverOrigin(info)}/api/agent`, undefined, token(home)).version();
    if (!live || path.resolve(live.agentHome) !== path.resolve(home)) return null;
    return { base: `${serverOrigin(info)}/api/agent`, version: live.harnessVersion };
  } catch {
    return null;
  }
}

function label(version: { sha: string; dirty: string | null } | null | undefined): string {
  return version ? `${version.sha.slice(0, 8)}${version.dirty ? `+${version.dirty}` : ''}` : 'unknown';
}

async function waitReady(home: string, child: ReturnType<typeof spawn>, startedAfter: number): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && child.exitCode === null) {
    const info = serverInfo(home);
    // Only this child's record counts, not a stale one from an earlier run.
    if (info && Date.parse(info.startedAt) >= startedAfter) {
      const live = await running(home);
      if (live) {
        console.log(
          `\nEval API ready at ${live.base} · home ${home} · code ${label(live.version)}\n` +
            'Next: nx run @agent/agent-eval:run --args="--suite matrix"\n',
        );
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

export async function upCommand(args: Args): Promise<number> {
  const home = evalHome(args);
  const port = intFlag(args, 'port', 0);
  const repo = path.resolve(flag(args, 'repo') ?? process.cwd());

  const existing = await running(home);
  if (existing) {
    const checkout = await harnessVersion(repo);
    if (existing.version && existing.version.sha === checkout.sha && existing.version.dirty === checkout.dirty) {
      console.log(`The eval API already runs this checkout's code at ${existing.base}. Nothing to start.`);
      return 0;
    }
    console.error(
      `The eval API at ${existing.base} runs other code (${label(existing.version)}) than this checkout (${label(checkout)}). ` +
        'Stop it (Ctrl+C in its terminal), then run up again.',
    );
    return 1;
  }

  console.log(`Building the agent app, then starting the eval API with AGENT_HOME=${home} …`);
  // Build once, then run the bundle: the agent loads the repo's .env itself.
  const built = spawnSync('npx', ['nx', 'run', '@agent/agent:build'], {
    cwd: repo,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (built.status !== 0) return built.status ?? 1;
  const startedAfter = Date.now();
  const child = spawn(
    process.execPath,
    [path.join(repo, 'apps/agent/dist/main.js'), 'serve', '--home', home, '--port', String(port), '--no-ui'],
    { cwd: repo, env: process.env, stdio: 'inherit' },
  );
  void waitReady(home, child, startedAfter - 1_000);
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => child.kill(signal));
    }
  });
}
