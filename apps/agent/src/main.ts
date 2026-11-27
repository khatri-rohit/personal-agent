// First: the root .env, before anything below imports the engine.
import { REPO_ROOT } from './load-env';

import { spawn } from 'node:child_process';
import path from 'node:path';

const USAGE = `agent <command> [options]

  serve [--home <dir>] [--port 3333] [--host localhost] [--no-ui]
      The harness: API and chat UI on one port. --no-ui = headless (API only).
  web [same options as serve]
      serve, then print and open the URL.
  run "<query>" [--workspace <dir>] [--ask] [--mode home|workspace]
      One isolated local run in this process (no agent home, memory or user skills).
  eval <command> [options]
      The agent-eval CLI (runs, run, up, gate, …); "agent eval --help" lists them.`;

type Flags = { values: Map<string, string>; switches: Set<string> };

function parseFlags(argv: string[], valued: string[]): Flags {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`);
    const [name, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
    if (!valued.includes(name)) {
      switches.add(name);
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    values.set(name, value);
  }
  return { values, switches };
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}

async function serveCommand(argv: string[], open: boolean): Promise<number> {
  const flags = parseFlags(argv, ['home', 'port', 'host']);
  const unknown = [...flags.switches].filter((name) => name !== 'no-ui');
  if (unknown.length > 0) throw new Error(`unknown option --${unknown[0]}`);
  const home = flags.values.get('home');
  const port = Number(flags.values.get('port') ?? process.env.PORT ?? 3333);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a port number');
  // Paths are the caller's; the server then runs from the repo, so the
  // built-in skills and the harness version (git) resolve as they always have.
  const resolvedHome = home ? path.resolve(home) : undefined;
  process.chdir(REPO_ROOT);
  const { serve } = await import('./serve.js');
  const url = await serve({
    ...(resolvedHome ? { home: resolvedHome } : {}),
    host: flags.values.get('host') ?? process.env.HOST ?? 'localhost',
    port,
    ui: !flags.switches.has('no-ui'),
  });
  if (open) {
    console.log(`\n  Agent harness: ${url}\n`);
    openBrowser(url);
  }
  // Keep running until the process is stopped.
  return new Promise<number>(() => undefined);
}

function evalCommand(argv: string[]): Promise<number> {
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'packages/agent-eval/scripts/cli.mjs'), ...argv], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'serve':
      return serveCommand(rest, false);
    case 'web':
      return serveCommand(rest, true);
    case 'run': {
      const { runCommand } = await import('./run.js');
      return runCommand(rest);
    }
    case 'eval':
      return evalCommand(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
