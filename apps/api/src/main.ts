import { createApp } from './app';
import { warnRoleModelsWithoutTools } from './models/model-runtime';
import { API_TOKEN_FILE } from './platform/access';
import { harnessVersion } from './platform/harness-version';
import { getAgentHome } from './platform/instances';
import { createLogger } from './platform/logger';
import { initSystem1 } from './runs/system1-runtime';
import { voiceProviders } from './voice/voice.routes';

const host = process.env.HOST ?? 'localhost';
const port = process.env.PORT ? Number(process.env.PORT) : 3333;

const logger = createLogger('api');

const app = createApp(logger);

app.listen(port, host, () => {
  logger.info(
    { host, port, voice: voiceProviders, tokenFile: `${getAgentHome()}/${API_TOKEN_FILE}` },
    'api ready',
  );
  // Read the running code's version now, so later edits are not mistaken for it.
  void harnessVersion().then((version) => logger.info({ harnessVersion: version }, 'harness version'));
  // Logs the System 1 setup and warms the scorer; never blocks or throws.
  initSystem1();
  void warnRoleModelsWithoutTools();
});
