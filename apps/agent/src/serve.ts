import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { serverOrigin, type ServerInfo } from '@agent/agent-models';
import {
  API_TOKEN_FILE,
  createApp,
  createLogger,
  isLoopbackHost,
  resolveUiDir,
  voiceProviders,
} from '@agent/agent-http';
import {
  createAgentService,
  harnessVersion,
  initSystem1,
  loadConfig,
  warnRoleModelsWithoutTools,
} from '@agent/agent-service';

import { pickFolderDialog } from './pick-folder';
import { liveServer, removeServerFile, writeServerFile, type LiveServer } from './server-file';

export type ServeOptions = {
  /** The agent home, over AGENT_HOME (already resolved against the caller's cwd). */
  home?: string;
  host: string;
  /** 0 = any free port (the one chosen is in server.json). */
  port: number;
  /** Serve the chat UI embedded in this build (`dist/ui`); false = headless. */
  ui: boolean;
};

/** `started`: this process serves the home. `attached`: another process already did, and keeps doing so. */
export type ServeResult =
  | { url: string; started: true; server: ServerInfo }
  /** `runsOtherCode`: the running server's code differs from this checkout's (it needs a restart to run the new code). */
  | { url: string; started: false; server: LiveServer; runsOtherCode: boolean };

/** How long a stop waits for runs to write their last rows (post-run compaction can be a model call). */
const DRAIN_MS = 10_000;

/**
 * One service, one HTTP server, one port: the API and (unless headless) the
 * chat UI. One server per home: when the home already has a live server,
 * this returns it instead of starting a second one.
 */
export async function serve(options: ServeOptions): Promise<ServeResult> {
  const { host } = options;
  const logger = createLogger('api');

  // The host's settings, read from the environment once (ADR-0003 §4.1); --home wins over AGENT_HOME.
  const env = options.home ? { ...process.env, AGENT_HOME: options.home } : process.env;
  const service = createAgentService({ config: loadConfig(env, os.homedir()) });
  const home = service.home();

  const running = await liveServer(home);
  if (running) return await attached(running);

  // The chat UI the build embedded next to this bundle; none = headless.
  const uiDir = options.ui ? resolveUiDir(path.join(__dirname, 'ui')) : null;
  const app = createApp(service, logger, {
    uiDir,
    browser: isLoopbackHost(host),
    pickFolder: pickFolderDialog,
  });

  let server: ReturnType<typeof app.listen>;
  try {
    server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
      const listening = app.listen(options.port, host, () => resolve(listening));
      listening.on('error', reject);
    });
  } catch (error) {
    // Two starts at once: the other one won the port; attach to it once it has written its file.
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      for (let i = 0; i < 10; i++) {
        const winner = await liveServer(home);
        if (winner) return await attached(winner);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      throw new Error(`Port ${options.port} is in use by another program. Choose another with --port.`);
    }
    throw error;
  }

  const port = (server.address() as AddressInfo).port;
  const info: ServerInfo = { pid: process.pid, host, port, agentHome: home, startedAt: new Date().toISOString() };
  writeServerFile(home, info);
  stopOnSignal(() => {
    logger.info('stopping: refusing new runs, cancelling the ones going');
    return service.close(DRAIN_MS).then((settled) => {
      if (!settled) logger.warn(`some runs did not settle within ${DRAIN_MS / 1000}s`);
      removeServerFile(home);
      server.closeAllConnections();
      server.close();
    });
  });

  logger.info(
    { host, port, ui: uiDir ?? 'none (headless)', voice: voiceProviders, tokenFile: `${home}/${API_TOKEN_FILE}` },
    'api ready',
  );
  // Read the running code's version now, so later edits are not mistaken for it.
  void harnessVersion().then((version) => logger.info({ harnessVersion: version }, 'harness version'));
  // Logs the System 1 setup and warms the scorer; never blocks or throws.
  initSystem1(service.config.system1);
  void warnRoleModelsWithoutTools(service.config.roleModels);
  return { url: `${serverOrigin(info)}/`, started: true, server: info };
}

async function attached(server: LiveServer): Promise<ServeResult> {
  const here = await harnessVersion();
  const there = server.harnessVersion;
  const runsOtherCode = Boolean(here && there && (here.sha !== there.sha || here.dirty !== there.dirty));
  return { url: `${serverOrigin(server)}/`, started: false, server, runsOtherCode };
}

/**
 * Ctrl+C, SIGTERM, or (Windows) closing the console or Ctrl+Break: stop
 * gracefully once; a second signal exits at once.
 */
function stopOnSignal(stop: () => Promise<void>): void {
  let stopping = false;
  const onSignal = () => {
    if (stopping) process.exit(1);
    stopping = true;
    void stop().finally(() => process.exit(0));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(signal, onSignal);
}
