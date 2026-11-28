import { API_ROUTES, type ApiRouteName } from '@agent/agent-models';
import { describe, expect, it } from 'vitest';

import { createAgentClient } from './client';

type Seen = { url: string; init: RequestInit | undefined };

function recorder() {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe('createAgentClient', () => {
  it('builds every route URL from the protocol table', () => {
    const client = createAgentClient({ baseUrl: 'http://localhost:3333/' });
    expect(client.url('threads.list')).toBe('http://localhost:3333/api/agent/threads');
    expect(client.url('threads.ledger', { id: 't1' })).toBe('http://localhost:3333/api/agent/threads/t1/ledger');
    expect(client.url('runs.events', { runId: 'r1' }, 'fromSeq=4')).toBe(
      'http://localhost:3333/api/agent/run/r1/events?fromSeq=4',
    );
    expect(client.url('voice.capabilities')).toBe('http://localhost:3333/api/voice/capabilities');
    expect(createAgentClient({ baseUrl: '' }).url('version')).toBe('/api/agent/version');
  });

  it('uses a base that already includes the agent mount', () => {
    const client = createAgentClient({ baseUrl: 'http://127.0.0.1:3334/api/agent', mounts: { agent: '' } });
    expect(client.url('runs.choice', { runId: 'r1' })).toBe('http://127.0.0.1:3334/api/agent/run/r1/choice');
    expect(client.url('voice.capabilities')).toBe('http://127.0.0.1:3334/api/agent/api/voice/capabilities');
  });

  it('encodes path parameters and refuses a missing one', () => {
    const client = createAgentClient({ baseUrl: '' });
    expect(client.url('memory.resolvePending', { opId: 'a/b c' })).toBe('/api/agent/memory/pending/a%2Fb%20c');
    expect(() => client.url('threads.get')).toThrow(/missing path parameter "id"/);
  });

  it('sends the route method and the caller body; a browser client adds no headers', async () => {
    const { seen, fetchImpl } = recorder();
    const client = createAgentClient({ baseUrl: '', fetch: fetchImpl });
    await client.request('runs.cancel', { params: { runId: 'r1' } });
    await client.request('threads.create', {
      init: { headers: { 'Content-Type': 'application/json' }, body: '{"kind":"home"}' },
    });
    expect(seen[0]).toEqual({ url: '/api/agent/run/r1/cancel', init: { method: 'POST' } });
    expect(seen[1]?.init).toEqual({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"home"}' });
  });

  it('adds the bearer token for a local process, keeping the caller headers', async () => {
    const { seen, fetchImpl } = recorder();
    const client = createAgentClient({ baseUrl: 'http://127.0.0.1:3334', token: 'tok', fetch: fetchImpl });
    await client.request('threads.list', { init: { headers: { Accept: 'application/json' } } });
    const headers = new Headers(seen[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('accept')).toBe('application/json');
    expect(client.authHeaders()).toEqual({ Authorization: 'Bearer tok' });
  });

  it('every route has a method and an absolute path', () => {
    for (const [name, route] of Object.entries(API_ROUTES) as Array<[ApiRouteName, (typeof API_ROUTES)[ApiRouteName]]>) {
      expect(route.path.startsWith('/'), name).toBe(true);
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(route.method);
    }
  });
});
