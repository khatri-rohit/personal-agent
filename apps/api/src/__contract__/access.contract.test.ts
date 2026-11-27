/**
 * Contract: who may drive the API (platform/access.ts), CORS, and /version.
 * Pins today's behaviour; the migration's auth change (ADR-0003 §4.6) must
 * update this file deliberately, not by accident.
 */
import path from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootContractApp, type ContractApp } from './harness';

let api: ContractApp;

beforeAll(async () => {
  api = await bootContractApp();
});
afterAll(async () => {
  await api.close();
});

describe('access guard', () => {
  it('refuses a Host that is not loopback (DNS rebinding)', async () => {
    const res = await request(api.app).get('/api/agent/threads').set('Host', 'evil.example:3333').set(api.auth);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/is not this API/);
  });

  it('refuses a request with no Origin and no token', async () => {
    const res = await request(api.app).get('/api/agent/threads');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/needs its token/);
  });

  it('refuses a wrong token', async () => {
    const res = await request(api.app).get('/api/agent/threads').set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
  });

  it('admits the bearer token and the x-agent-token header', async () => {
    expect((await request(api.app).get('/api/agent/threads').set(api.auth)).status).toBe(200);
    expect((await request(api.app).get('/api/agent/threads').set('x-agent-token', api.token)).status).toBe(200);
  });

  it('admits any loopback Origin (the web app on another port) without a token', async () => {
    for (const origin of ['http://localhost:4200', 'http://127.0.0.1:5173']) {
      const res = await request(api.app).get('/api/agent/threads').set('Origin', origin);
      expect(res.status, origin).toBe(200);
      expect(res.headers['access-control-allow-origin'], origin).toBe(origin);
    }
  });

  it('refuses a non-loopback Origin even with the token', async () => {
    const res = await request(api.app).get('/api/agent/threads').set('Origin', 'https://evil.example').set(api.auth);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/may not use this API/);
  });

  it('answers a CORS preflight from a loopback origin', async () => {
    const res = await request(api.app)
      .options('/api/agent/run')
      .set('Origin', 'http://localhost:4200')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});

describe('GET /api/agent/version', () => {
  it('reports the running code and the home it writes to', async () => {
    const res = await request(api.app).get('/api/agent/version').set(api.auth);
    expect(res.status).toBe(200);
    expect(path.resolve(res.body.agentHome)).toBe(path.resolve(api.home));
    expect(res.body).toHaveProperty('harnessVersion');
    if (res.body.harnessVersion !== null) {
      expect(res.body.harnessVersion.sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});
