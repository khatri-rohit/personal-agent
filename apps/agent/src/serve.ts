import os from 'node:os';
import path from 'node:path';

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

export type ServeOptions = {
  /** The agent home, over AGENT_HOME (already resolved against the caller's cwd). */
  home?: string;
  host: string;
  port: number;
  /** Serve the chat UI embedded in this build (`dist/ui`); false = headless. */
  ui: boolean;
};

/** One service, one HTTP server, one port: the API and (unless headless) the chat UI. Resolves with the URL once listening. */
export function serve(options: ServeOptions): Promise<string> {
  const { host, port } = options;
  const logger = createLogger('api');

  // The host's settings, read from the environment once (ADR-0003 §4.1); --home wins over AGENT_HOME.
  const env = options.home ? { ...process.env, AGENT_HOME: options.home } : process.env;
  const service = createAgentService({ config: loadConfig(env, os.homedir()) });

  // The chat UI the build embedded next to this bundle; none = headless.
  const uiDir = options.ui ? resolveUiDir(path.join(__dirname, 'ui')) : null;
  const app = createApp(service, logger, {
    uiDir,
    browser: isLoopbackHost(host),
    pickFolder: pickFolderDialog,
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      logger.info(
        { host, port, ui: uiDir ?? 'none (headless)', voice: voiceProviders, tokenFile: `${service.home()}/${API_TOKEN_FILE}` },
        'api ready',
      );
      // Read the running code's version now, so later edits are not mistaken for it.
      void harnessVersion().then((version) => logger.info({ harnessVersion: version }, 'harness version'));
      // Logs the System 1 setup and warms the scorer; never blocks or throws.
      initSystem1(service.system1);
      void warnRoleModelsWithoutTools(service.config.env);
      resolve(`http://${host.includes(':') ? `[${host}]` : host}:${port}/`);
    });
    server.on('error', reject);
  });
}
