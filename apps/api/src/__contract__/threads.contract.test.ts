/**
 * Contract: /api/agent/threads* and /workspace/pick (threads.routes.ts).
 * The native folder dialog is replaced; everything else is the real store.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CHECKPOINT_NOT_COVERED, HOME_MODE } from '@agent/agent-models';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bootContractApp, type ContractApp } from './harness';

const picker = vi.hoisted(() => ({
  next: { ok: false, reason: 'cancelled' } as
    | { ok: true; path: string }
    | { ok: false; reason: 'cancelled' | 'failed'; message?: string },
}));
vi.mock('../threads/pick-folder', () => ({
  pickFolderDialog: async () => picker.next,
}));

let api: ContractApp;
let folder: string;
const browser = { Origin: 'http://localhost:4200' };

beforeAll(async () => {
  api = await bootContractApp();
  folder = await mkdtemp(path.join(os.tmpdir(), 'agent-contract-ws-'));
  await writeFile(path.join(folder, 'a.txt'), 'a\n');
});
afterAll(async () => {
  await api.close();
  await rm(folder, { recursive: true, force: true });
});

const post = (url: string, body: unknown, headers: Record<string, string> = api.auth) =>
  request(api.app).post(url).set(headers).send(body as object);

describe('POST /threads', () => {
  it('creates a home thread with defaults', async () => {
    const res = await post('/api/agent/threads', {});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: 'New Chat', kind: 'home', model: HOME_MODE.model });
    expect(typeof res.body.id).toBe('string');
  });

  it('keeps a given title and model', async () => {
    const res = await post('/api/agent/threads', { title: '  Plan  ', model: ' m1 ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: 'Plan', model: 'm1' });
  });

  it('requires an existing directory for a workspace thread', async () => {
    expect((await post('/api/agent/threads', { kind: 'workspace' })).body.error).toBe(
      'workspaceRoot is required for workspace threads',
    );
    const missing = await post('/api/agent/threads', { kind: 'workspace', workspaceRoot: path.join(folder, 'nope') });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/^workspaceRoot does not exist: /);
    const file = await post('/api/agent/threads', { kind: 'workspace', workspaceRoot: path.join(folder, 'a.txt') });
    expect(file.status).toBe(400);
    expect(file.body.error).toBe('workspaceRoot must be a directory');
  });

  it('lets a token client open any existing folder', async () => {
    const res = await post('/api/agent/threads', { kind: 'workspace', workspaceRoot: folder });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'workspace', workspaceRoot: path.normalize(folder) });
  });

  it('refuses a browser a folder nobody picked', async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), 'agent-contract-unpicked-'));
    try {
      const res = await post('/api/agent/threads', { kind: 'workspace', workspaceRoot: other }, browser);
      expect(res.status).toBe(403);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe('POST /workspace/pick', () => {
  it('204 when the dialog is cancelled', async () => {
    picker.next = { ok: false, reason: 'cancelled' };
    expect((await post('/api/agent/workspace/pick', {})).status).toBe(204);
  });

  it('500 with the message when the dialog fails', async () => {
    picker.next = { ok: false, reason: 'failed', message: 'no display' };
    const res = await post('/api/agent/workspace/pick', {});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('no display');
  });

  it('returns the picked folder, and a browser may then open it', async () => {
    const picked = await mkdtemp(path.join(os.tmpdir(), 'agent-contract-picked-'));
    try {
      picker.next = { ok: true, path: picked };
      const res = await post('/api/agent/workspace/pick', {}, browser);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ workspaceRoot: path.normalize(picked) });
      const thread = await post('/api/agent/threads', { kind: 'workspace', workspaceRoot: picked }, browser);
      expect(thread.status).toBe(201);
    } finally {
      await rm(picked, { recursive: true, force: true });
    }
  });
});

describe('GET /threads and /threads/:id', () => {
  it('lists threads and filters by kind and folder', async () => {
    const all = await request(api.app).get('/api/agent/threads').set(api.auth);
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body.threads)).toBe(true);
    const workspace = await request(api.app).get('/api/agent/threads').query({ kind: 'workspace' }).set(api.auth);
    expect(workspace.body.threads.every((t: { kind: string }) => t.kind === 'workspace')).toBe(true);
    const inFolder = await request(api.app).get('/api/agent/threads').query({ workspaceRoot: folder }).set(api.auth);
    expect(inFolder.body.threads.length).toBeGreaterThan(0);
    expect(inFolder.body.threads.every((t: { workspaceRoot: string }) => t.workspaceRoot === path.normalize(folder))).toBe(true);
  });

  it('returns a thread with running=false, 404 for an unknown id', async () => {
    const created = await post('/api/agent/threads', {});
    const res = await request(api.app).get(`/api/agent/threads/${created.body.id}`).set(api.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.body.id, running: false });
    const missing = await request(api.app).get('/api/agent/threads/nope').set(api.auth);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Thread not found' });
  });
});

describe('PATCH /threads/:id', () => {
  it('updates title and pinned, rejects a non-string workspaceRoot, 404 for unknown', async () => {
    const created = await post('/api/agent/threads', {});
    const res = await request(api.app)
      .patch(`/api/agent/threads/${created.body.id}`)
      .set(api.auth)
      .send({ title: 'Renamed', pinned: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Renamed', pinned: true });
    const bad = await request(api.app).patch(`/api/agent/threads/${created.body.id}`).set(api.auth).send({ workspaceRoot: 5 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('workspaceRoot must be a string or null');
    const missing = await request(api.app).patch('/api/agent/threads/nope').set(api.auth).send({ title: 'x' });
    expect(missing.status).toBe(404);
  });
});

describe('GET /threads/:id/ledger', () => {
  it('is empty for a new thread, 404 for an unknown one', async () => {
    const created = await post('/api/agent/threads', {});
    const res = await request(api.app).get(`/api/agent/threads/${created.body.id}/ledger`).set(api.auth);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.lastSeq).toBe(0);
    expect(res.body).not.toHaveProperty('activeRun');
    expect(res.body).not.toHaveProperty('lastUserSeq');
    expect((await request(api.app).get('/api/agent/threads/nope/ledger').set(api.auth)).status).toBe(404);
  });
});

describe('changes, diff and undo', () => {
  it('reports nothing to show without runs, and validates diff and undo', async () => {
    const ws = await post('/api/agent/threads', { kind: 'workspace', workspaceRoot: folder });
    const id = ws.body.id as string;
    const changes = await request(api.app).get(`/api/agent/threads/${id}/changes`).set(api.auth);
    expect(changes.status).toBe(200);
    expect(changes.body).toEqual({ available: false, files: [], notCovered: CHECKPOINT_NOT_COVERED });

    const diff = await request(api.app).get(`/api/agent/threads/${id}/changes/diff`).set(api.auth);
    expect(diff.status).toBe(400);
    expect(diff.body.error).toBe('runIds and path are required');

    const undo = await post(`/api/agent/threads/${id}/changes/undo`, {});
    expect(undo.status).toBe(400);
    expect(undo.body.error).toBe('runIds is required');

    const home = await post('/api/agent/threads', {});
    expect((await request(api.app).get(`/api/agent/threads/${home.body.id}/changes/diff`).query({ runIds: 'r', path: 'a' }).set(api.auth)).status).toBe(404);
    expect((await post(`/api/agent/threads/${home.body.id}/changes/undo`, { runIds: ['r'] })).status).toBe(404);
  });
});

describe('DELETE /threads/:id', () => {
  it('deletes once, then 404', async () => {
    const created = await post('/api/agent/threads', {});
    const res = await request(api.app).delete(`/api/agent/threads/${created.body.id}`).set(api.auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await request(api.app).delete(`/api/agent/threads/${created.body.id}`).set(api.auth)).status).toBe(404);
  });
});
