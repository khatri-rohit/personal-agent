/**
 * The HTTP adapter over agent-service (ADR-0003 §8, type:adapter): routes
 * from the protocol table, access (§4.6), logging, errors, the voice proxy
 * and the static chat UI. `apps/agent` creates the service and listens.
 */
export { createApp, type AppOptions } from './lib/app';
export { API_TOKEN_FILE, isLoopbackHost } from './lib/platform/access';
export { createLogger, type Logger } from './lib/platform/logger';
export { resolveUiDir } from './lib/platform/static-ui';
export type { PickFolder, PickFolderResult } from './lib/threads/threads.routes';
export { voiceProviders } from './lib/voice/voice.routes';
