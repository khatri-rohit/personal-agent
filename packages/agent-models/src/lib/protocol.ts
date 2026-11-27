/**
 * The HTTP protocol between the agent host and its clients: every route by
 * name, its method, the router it is mounted on, and its path there. The
 * host mounts its routes from this table and agent-client builds its URLs
 * from it, so the two cannot disagree on a path (ADR-0003 §4.9).
 *
 * Changing a path or method is a protocol change: bump PROTOCOL_VERSION.
 */

/** Bumped on any breaking change to a route's path, method or payload. */
export const PROTOCOL_VERSION = 1;

/** Where a router is mounted. */
export const API_MOUNTS = {
  agent: '/api/agent',
  voice: '/api/voice',
} as const;
export type ApiMount = keyof typeof API_MOUNTS;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ApiRoute = Readonly<{ method: HttpMethod; mount: ApiMount; path: string }>;

const agent = (method: HttpMethod, path: string): ApiRoute => ({ method, mount: 'agent', path });
const voice = (method: HttpMethod, path: string): ApiRoute => ({ method, mount: 'voice', path });

export const API_ROUTES = {
  version: agent('GET', '/version'),

  'workspace.pick': agent('POST', '/workspace/pick'),
  'threads.list': agent('GET', '/threads'),
  'threads.create': agent('POST', '/threads'),
  'threads.get': agent('GET', '/threads/:id'),
  'threads.update': agent('PATCH', '/threads/:id'),
  'threads.delete': agent('DELETE', '/threads/:id'),
  'threads.ledger': agent('GET', '/threads/:id/ledger'),
  'threads.changes': agent('GET', '/threads/:id/changes'),
  'threads.changeDiff': agent('GET', '/threads/:id/changes/diff'),
  'threads.undoChanges': agent('POST', '/threads/:id/changes/undo'),

  'runs.start': agent('POST', '/run'),
  'runs.estimate': agent('POST', '/context/estimate'),
  'runs.cancel': agent('POST', '/run/:runId/cancel'),
  'runs.choice': agent('POST', '/run/:runId/choice'),
  'runs.events': agent('GET', '/run/:runId/events'),

  'memory.get': agent('GET', '/memory'),
  'memory.update': agent('PATCH', '/memory'),
  'memory.revert': agent('POST', '/memory/revert'),
  'memory.pending': agent('GET', '/memory/pending'),
  'memory.resolvePending': agent('POST', '/memory/pending/:opId'),

  'usage.balance': agent('GET', '/usage/balance'),
  'models.config': agent('GET', '/models/config'),
  'models.getSettings': agent('GET', '/models/settings'),
  'models.putSettings': agent('PUT', '/models/settings'),
  'models.list': agent('GET', '/models'),

  'skills.list': agent('GET', '/skills'),
  'skills.create': agent('POST', '/skills/create'),
  'skills.get': agent('GET', '/skills/:folder'),
  'skills.delete': agent('DELETE', '/skills/:folder'),

  'voice.capabilities': voice('GET', '/capabilities'),
  'voice.transcribe': voice('POST', '/transcribe'),
  'voice.speak': voice('POST', '/speak'),
} as const satisfies Record<string, ApiRoute>;

export type ApiRouteName = keyof typeof API_ROUTES;
