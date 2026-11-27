/**
 * Contract: the host serves exactly the protocol table (agent-models
 * protocol.ts). Every route answers with its method — never Express's own
 * "Cannot <METHOD>" 404 — and /version reports the protocol version. The
 * Speaches routes exist only when voice uses Speaches, so they are checked
 * with that provider on in voice-capabilities.test.ts, not here.
 */
import { API_MOUNTS, API_ROUTES, PROTOCOL_VERSION, type ApiRouteName } from '@agent/agent-models';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bootContractApp, type ContractApp } from './harness';

vi.mock('../threads/pick-folder', () => ({
  pickFolderDialog: async () => ({ ok: false, reason: 'cancelled' }),
}));

const SPEACHES_ONLY: ApiRouteName[] = ['voice.transcribe', 'voice.speak'];

let api: ContractApp;

beforeAll(async () => {
  api = await bootContractApp();
});
afterAll(async () => {
  await api.close();
});

function urlOf(name: ApiRouteName): string {
  const route = API_ROUTES[name];
  return API_MOUNTS[route.mount] + route.path.replace(/:([A-Za-z]+)/g, 'contract-x');
}

describe('protocol table', () => {
  it('every route is mounted with its method', async () => {
    for (const name of Object.keys(API_ROUTES) as ApiRouteName[]) {
      if (SPEACHES_ONLY.includes(name)) continue;
      const route = API_ROUTES[name];
      const call = request(api.app)[route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](urlOf(name)).set(api.auth);
      const res = route.method === 'GET' || route.method === 'DELETE' ? await call : await call.send({});
      const unmounted = res.status === 404 && /Cannot (GET|POST|PUT|PATCH|DELETE)/.test(res.text);
      expect(unmounted, `${name}: ${route.method} ${urlOf(name)}`).toBe(false);
    }
  });

  it('/version reports the protocol version', async () => {
    const res = await request(api.app).get(`${API_MOUNTS.agent}${API_ROUTES.version.path}`).set(api.auth);
    expect(res.status).toBe(200);
    expect(res.body.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});
