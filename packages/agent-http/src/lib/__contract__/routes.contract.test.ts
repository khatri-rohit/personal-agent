/**
 * Contract: run control without a model (runs.routes.ts), memory, models,
 * skills and voice routes. Response bodies and statuses are today's; a run
 * that reaches the model is pinned in golden-run.contract.test.ts.
 */
import { DEFAULT_MEMORY_CAPS } from '@agent/agent-models';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootContractApp, type ContractApp } from './harness';

let api: ContractApp;
let threadId: string;

beforeAll(async () => {
  api = await bootContractApp();
  threadId = (await request(api.app).post('/api/agent/threads').set(api.auth).send({})).body.id;
});
afterAll(async () => {
  await api.close();
});

const get = (url: string) => request(api.app).get(url).set(api.auth);
const send = (method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) =>
  request(api.app)[method](url).set(api.auth).send(body);

describe('runs: start, cancel, choice, events', () => {
  it('POST /run validates the request and the thread', async () => {
    expect((await send('post', '/api/agent/run')).body).toEqual({ error: 'threadId is required' });
    const missing = await send('post', '/api/agent/run', { threadId: 'nope' });
    expect([missing.status, missing.body]).toEqual([404, { error: 'Thread not found' }]);
    const badMessage = await send('post', '/api/agent/run', { threadId, message: { content: 5 } });
    expect([badMessage.status, badMessage.body]).toEqual([400, { error: 'message.content must be a string' }]);
  });

  it('cancel, choice and events answer 404 for an unknown run', async () => {
    expect([(await send('post', '/api/agent/run/x/cancel')).status, (await send('post', '/api/agent/run/x/cancel')).body]).toEqual([
      404,
      { error: 'Run not found or not active' },
    ]);
    const events = await get('/api/agent/run/x/events');
    expect([events.status, events.body]).toEqual([404, { error: 'Run not found' }]);
  });

  it('choice validates its body before looking up the run', async () => {
    expect((await send('post', '/api/agent/run/x/choice')).body).toEqual({ error: 'choiceId is required' });
    const badIds = await send('post', '/api/agent/run/x/choice', { choiceId: 'c', optionIds: 'x' });
    expect([badIds.status, badIds.body]).toEqual([400, { error: 'optionIds must be a string array' }]);
    for (const body of [{ choiceId: 'c' }, { choiceId: 'c', skipped: true }]) {
      const res = await send('post', '/api/agent/run/x/choice', body);
      expect([res.status, res.body]).toEqual([404, { error: 'Choice not found or already resolved' }]);
    }
  });
});

describe('POST /context/estimate', () => {
  it('estimates a draft, falls back to the 260k window when /api/show is unreachable, 404 for an unknown thread', async () => {
    const draft = await send('post', '/api/agent/context/estimate');
    expect(draft.status).toBe(200);
    expect(draft.body).toMatchObject({ contextLength: 260_000, source: 'estimate' });
    expect(draft.body.estimatedPromptTokens).toBeGreaterThan(0);
    expect(draft.body.contextReport.budget.windowTokens).toBe(260_000);

    const withDraft = await send('post', '/api/agent/context/estimate', { threadId, draft: 'hello there' });
    expect(withDraft.status).toBe(200);
    expect(withDraft.body.estimatedPromptTokens).toBeGreaterThan(draft.body.estimatedPromptTokens);

    const missing = await send('post', '/api/agent/context/estimate', { threadId: 'nope' });
    expect([missing.status, missing.body]).toEqual([404, { error: 'Thread not found' }]);
  });
});

describe('memory', () => {
  it('reads empty memory with caps, and validates writes', async () => {
    const mem = await get('/api/agent/memory');
    expect([mem.status, mem.body]).toEqual([200, { files: { user: '', notes: '' }, ops: [], caps: DEFAULT_MEMORY_CAPS }]);
    expect((await send('patch', '/api/agent/memory')).body).toEqual({ error: 'user is required' });
    expect((await send('post', '/api/agent/memory/revert')).body).toEqual({ error: 'opId is required' });
    expect((await get('/api/agent/memory/pending')).body).toEqual({ ops: [] });
    const bad = await send('post', '/api/agent/memory/pending/x', { decision: 'maybe' });
    expect([bad.status, bad.body]).toEqual([400, { error: 'decision must be approve or reject' }]);
    const missing = await send('post', '/api/agent/memory/pending/x', { decision: 'approve' });
    expect([missing.status, missing.body]).toEqual([404, { error: 'Pending suggestion not found' }]);
  });
});

describe('models and usage', () => {
  it('balance is 404 without an API key', async () => {
    const res = await get('/api/agent/usage/balance');
    expect([res.status, res.body]).toEqual([404, { error: 'No OLLAMA_API_KEY configured' }]);
  });

  it('config and list validate input and report a 502 when Ollama is unreachable', async () => {
    expect((await get('/api/agent/models/config')).body).toEqual({ error: 'model is required' });
    expect((await get('/api/agent/models/config?model=m&endpoint=bad')).body).toEqual({ error: 'endpoint must be "local" or "cloud"' });
    expect((await get('/api/agent/models/config?model=m')).status).toBe(502);
    expect((await get('/api/agent/models?endpoint=bad')).body).toEqual({ error: 'endpoint must be "local" or "cloud"' });
    expect((await get('/api/agent/models')).status).toBe(502);
  });

  it('settings round-trip, and unknown fields are refused', async () => {
    const current = await get('/api/agent/models/settings');
    expect(current.status).toBe(200);
    expect(Object.keys(current.body.settings.roles).sort()).toEqual(['fast', 'strong', 'summary', 'title']);
    expect(current.body.resolved.roles.strong.source).toBe('default');
    const saved = await send('put', '/api/agent/models/settings', current.body.settings);
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toEqual(current.body.settings);
    const bad = await send('put', '/api/agent/models/settings', { nonsense: 1 });
    expect([bad.status, bad.body]).toEqual([400, { error: 'Invalid model settings', problems: ['unknown field "nonsense"'] }]);
  });
});

describe('skills', () => {
  it('lists built-in catalogs and refuses bad or unknown skills', async () => {
    const list = await get('/api/agent/skills');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.builtin)).toBe(true);
    expect(list.body.builtin.length).toBeGreaterThan(0);
    expect(list.body.builtin.every((skill: { source: string }) => skill.source === 'builtin')).toBe(true);
    const bad = await send('post', '/api/agent/skills/create');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/^Name must be 1–64 characters/);
    for (const method of ['get', 'delete'] as const) {
      const res = await request(api.app)[method]('/api/agent/skills/nope').set(api.auth);
      expect([res.status, res.body], method).toEqual([404, { error: 'Skill "nope" was not found.' }]);
    }
  });

  it('creates a user skill, reads it back, and deletes it', async () => {
    const content = '---\nname: contract-skill\ndescription: A skill the contract test creates.\n---\n\nBody.\n';
    const created = await send('post', '/api/agent/skills/create', { name: 'contract-skill', content });
    expect(created.status).toBe(200);
    const all = Object.values(created.body).flat() as Array<{ folder: string }>;
    expect(all.some((skill) => skill.folder === 'contract-skill')).toBe(true);
    const doc = await get('/api/agent/skills/contract-skill');
    expect(doc.status).toBe(200);
    const removed = await send('delete', '/api/agent/skills/contract-skill');
    expect(removed.status).toBe(200);
    expect((await get('/api/agent/skills/contract-skill')).status).toBe(404);
  });
});

describe('voice', () => {
  it('reports browser-only voice and mounts no Speaches routes when none is configured', async () => {
    const caps = await request(api.app).get('/api/voice/capabilities').set(api.auth);
    expect([caps.status, caps.body]).toEqual([200, { stt: 'browser', tts: 'browser' }]);
    expect(caps.headers['cache-control']).toBe('no-store');
    expect((await request(api.app).post('/api/voice/speak').set(api.auth).send({})).status).toBe(404);
  });
});
