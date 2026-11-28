/**
 * Contract: the chat UI on the API's own origin (ADR-0003 §4.5). Hashed
 * assets are immutable, the shell is revalidated, any non-/api GET falls back
 * to the shell, /api never does, and with no UI the host is headless.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveUiDir } from '../platform/static-ui';
import { bootContractApp, type ContractApp } from './harness';

let ui: string;
let api: ContractApp;

beforeAll(async () => {
  ui = await mkdtemp(path.join(os.tmpdir(), 'agent-contract-ui-'));
  await mkdir(path.join(ui, 'assets'));
  await writeFile(path.join(ui, 'index.html'), '<!doctype html><div id="root"></div>');
  await writeFile(path.join(ui, 'assets', 'index-abc123.js'), 'console.log(1)');
  await writeFile(path.join(ui, 'favicon.ico'), 'icon');
  api = await bootContractApp({}, { uiDir: resolveUiDir(ui) });
});
afterAll(async () => {
  await api.close();
  await rm(ui, { recursive: true, force: true });
});

describe('static UI', () => {
  it('serves the shell at / and at SPA paths, revalidated on every load', async () => {
    for (const url of ['/', '/chat/some-thread']) {
      const res = await request(api.app).get(url);
      expect(res.status, url).toBe(200);
      expect(res.text, url).toContain('<div id="root">');
      expect(res.headers['cache-control'], url).toBe('no-cache');
    }
  });

  it('caches hashed assets for good, other files are revalidated', async () => {
    const asset = await request(api.app).get('/assets/index-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await request(api.app).get('/favicon.ico')).headers['cache-control']).toBe('no-cache');
  });

  it('never answers /api paths with the shell', async () => {
    expect((await request(api.app).get('/api/agent/nope')).status).toBe(401);
    const res = await request(api.app).get('/api/agent/nope').set(api.auth);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });

  it('runs headless when no UI is built', async () => {
    expect(resolveUiDir(path.join(ui, 'missing'))).toBeNull();
    expect(resolveUiDir(undefined)).toBeNull();
  });
});
