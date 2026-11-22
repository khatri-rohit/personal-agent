import { spawn } from 'node:child_process';
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
  Start an API for evals: AGENT_HOME = the eval home, its own port, no watch (the code under
  test never reloads mid-suite). Stays in the foreground; Ctrl+C stops it. Your chat API on 3333
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
  console.log(`Starting the eval API on port ${port} with AGENT_HOME=${home} …`);
  const child = spawn('npx', ['nx', 'run', '@agent/api:serve', '--watch=false'], {
    cwd: path.resolve(flag(args, 'repo') ?? process.cwd()),
    env: { ...process.env, PORT: String(port), AGENT_HOME: home },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  void waitReady(base, home, child);
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => child.kill(signal));
    }
  });
}
