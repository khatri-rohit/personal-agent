import express from 'express';
import cors from 'cors';

import { memoryRouter } from './memory/memory.routes';
import { warnRoleModelsWithoutTools } from './models/model-runtime';
import { modelsRouter } from './models/models.routes';
import { errorHandler } from './platform/http-errors';
import { createLogger, createHttpLogger } from './platform/logger';
import { runsRouter } from './runs/runs.routes';
import { initSystem1 } from './runs/system1-runtime';
import { skillsRouter } from './skills/skills.routes';
import { threadsRouter } from './threads/threads.routes';
import { voiceProviders, voiceRouter } from './voice/voice.routes';

const host = process.env.HOST ?? 'localhost';
const port = process.env.PORT ? Number(process.env.PORT) : 3333;

const logger = createLogger('api');

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? true, // true = reflect request origin (dev-friendly)
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Origin',
      'X-Requested-With',
      'X-Voice-Context',
    ],
  }),
);

app.use(express.json({ limit: '25mb' }));

// Request-scoped structured logging: stamps x-request-id, logs each request in/out.
// SSE event streams and OPTIONS preflight are skipped (see createHttpLogger).
app.use(createHttpLogger(logger));

// Agent endpoints (no two routers share a path, so order does not matter)
app.use(
  '/api/agent',
  skillsRouter,
  modelsRouter,
  threadsRouter,
  runsRouter,
  memoryRouter,
);

// Voice add-on (Speaches, not Ollama). The voice module decides which routes
// exist; nothing on the run path depends on them.
app.use('/api/voice', voiceRouter);

app.use(errorHandler);

app.listen(port, host, () => {
  logger.info(
    { host, port, voice: voiceProviders },
    'api ready',
  );
  // Logs the System 1 setup and warms the scorer; never blocks or throws.
  initSystem1();
  void warnRoleModelsWithoutTools();
});
