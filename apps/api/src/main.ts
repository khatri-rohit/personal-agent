import os from 'node:os';

import {
  createAgentService,
  harnessVersion,
  initSystem1,
  loadConfig,
  warnRoleModelsWithoutTools,
} from '@agent/agent-service';

import { createApp } from './app';
import { API_TOKEN_FILE } from './platform/access';
import { createLogger } from './platform/logger';
import { voiceProviders } from './voice/voice.routes';

const host = process.env.HOST ?? 'localhost';
const port = process.env.PORT ? Number(process.env.PORT) : 3333;

const logger = createLogger('api');

// The host's settings, read from the environment once (ADR-0003 §4.1).
const service = createAgentService({ config: loadConfig(process.env, os.homedir()) });

const app = createApp(service, logger);

app.listen(port, host, () => {
  logger.info(
    { host, port, voice: voiceProviders, tokenFile: `${service.home()}/${API_TOKEN_FILE}` },
    'api ready',
  );
  // Read the running code's version now, so later edits are not mistaken for it.
  void harnessVersion().then((version) => logger.info({ harnessVersion: version }, 'harness version'));
  // Logs the System 1 setup and warms the scorer; never blocks or throws.
  initSystem1(service.system1);
  void warnRoleModelsWithoutTools(service.config.env);
});
