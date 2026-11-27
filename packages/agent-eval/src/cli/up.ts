import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ApiClient } from '../runner/api-client.js';
import { evalHome, flag, intFlag, type Args } from './args.js';

/** The eval API's own port: the chat API keeps 3333 while a suite runs. */
export const EVAL_API_PORT = 3334;

export function evalApiBase(port: number = EVAL_API_PORT): string {
  return `http://localhost:${port}/api/agent`;
}

export const UP_HELP = `up [--port ${EVAL_API_PORT}] [--eval-home <dir>]
  Start an API for evals: \`agent serve --home <eval home> --port <port> --no-ui\`, built first,
  no watch (the code under test never reloads mid-suite). Stays in the foreground; Ctrl+C stops it. Your chat API on 3333
  keeps running. Then in another terminal: run --suite matrix (its --api defaults to this port).`;

async function waitReady(base: string, home: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && child.exitCode === null) {
    const tokenFile = path.join(home, 'api-token');
    const token = existsSync(tokenFile) ? (await readFile(tokenFile, 'utf8')).trim() : undefined;
    try {
      const info = await new ApiClient(base, undefined, token).version();
      if (info) {
        const version = info.harnessVersion
          ? `${info.harnessVersion.sha.slice(0, 8)}${info.harnessVersion.dirty ? `+${info.harnessVersion.dirty}` : ''}`
          : 'unknown';
        const sameHome = path.resolve(info.agentHome) === path.resolve(home);
        console.log(
          `\nEval API ready at ${base} · home ${info.agentHome}${sameHome ? '' : ' (NOT the eval home)'} · code ${version}\n` +
            'Next: nx run @agent/agent-eval:run --args="--suite matrix"\n',
        );
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

export async function upCommand(args: Args): Promise<number> {
  const home = evalHome(args);
  const port = intFlag(args, 'port', EVAL_API_PORT);
  const base = evalApiBase(port);
  const repo = path.resolve(flag(args, 'repo') ?? process.cwd());
  console.log(`Building the agent app, then starting the eval API on port ${port} with AGENT_HOME=${home} …`);
  // Build once, then run the bundle: the agent loads the repo's .env itself.
  const built = spawnSync('npx', ['nx', 'run', '@agent/agent:build'], {
    cwd: repo,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (built.status !== 0) return built.status ?? 1;
  const child = spawn(
    process.execPath,
    [path.join(repo, 'apps/agent/dist/main.js'), 'serve', '--home', home, '--port', String(port), '--no-ui'],
    { cwd: repo, env: process.env, stdio: 'inherit' },
  );
  void waitReady(base, home, child);
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => child.kill(signal));
    }
  });
}
