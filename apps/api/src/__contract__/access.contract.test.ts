/**
 * Contract: who may drive the API (platform/access.ts) and /version.
 * Updated deliberately in stage 4 for ADR-0003 §4.6: a browser is admitted
 * only as this server's own page (Fetch Metadata + exact origin), never from
 * another localhost port; local processes keep the token; no CORS at all.
 */
import path from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootContractApp, sameOriginBrowser, type ContractApp } from './harness';

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

  it('admits the server own page (same-origin) without a token, reads and writes', async () => {
    expect((await request(api.app).get('/api/agent/threads').set(sameOriginBrowser)).status).toBe(200);
    // Browsers omit Origin on same-origin GETs (and EventSource): Fetch Metadata alone is enough.
    const { Origin: _origin, ...noOrigin } = sameOriginBrowser;
    expect((await request(api.app).get('/api/agent/threads').set(noOrigin)).status).toBe(200);
    const created = await request(api.app).post('/api/agent/threads').set(sameOriginBrowser).send({ title: 'same-origin' });
    expect(created.status).toBe(201);
    expect(created.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a page on another localhost port: writes and the event stream', async () => {
    const otherPort = { Host: 'localhost:3333', Origin: 'http://localhost:4200', 'Sec-Fetch-Site': 'same-site' };
    const write = await request(api.app).post('/api/agent/threads').set(otherPort).send({ title: 'x' });
    expect(write.status).toBe(403);
    expect(write.body.error).toMatch(/may not use this API/);
    const stream = await request(api.app).get('/api/agent/run/x/events').set(otherPort);
    expect(stream.status).toBe(403);
    // Even a page that claims same-origin is refused when its Origin is not exactly ours.
    const spoofed = await request(api.app)
      .post('/api/agent/threads')
      .set({ ...otherPort, 'Sec-Fetch-Site': 'same-origin' })
      .send({ title: 'x' });
    expect(spoofed.status).toBe(403);
  });

  it('refuses a browser request without Fetch Metadata (fails closed), even with the token', async () => {
    const res = await request(api.app)
      .get('/api/agent/threads')
      .set({ Host: 'localhost:3333', Origin: 'http://localhost:3333' })
      .set(api.auth);
    expect(res.status).toBe(403);
  });

  it('refuses a non-loopback Origin even with the token', async () => {
    const res = await request(api.app).get('/api/agent/threads').set('Origin', 'https://evil.example').set(api.auth);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/may not use this API/);
  });

  it('sends no CORS headers: a preflight from another port is refused', async () => {
    const res = await request(api.app)
      .options('/api/agent/run')
      .set({ Host: 'localhost:3333', Origin: 'http://localhost:4200', 'Sec-Fetch-Site': 'same-site' })
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('access guard, bound beyond loopback', () => {
  it('needs the token for every request, the same-origin page included', async () => {
    // One service per process (ADR-0003 §4.2): a second app over the same one.
    const { createApp } = await import('../app.js');
    const { createLogger } = await import('../platform/logger.js');
    const open = createApp(api.service, createLogger('contract'), { browser: false });
    expect((await request(open).get('/api/agent/threads').set(sameOriginBrowser)).status).toBe(403);
    expect((await request(open).get('/api/agent/threads').set(api.auth)).status).toBe(200);
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
