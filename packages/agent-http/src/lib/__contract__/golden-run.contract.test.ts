/**
 * Golden run: one Workspace run end to end through the real HTTP app with a
 * scripted model (no network). It reads a file, edits it, runs the project's
 * check, asks the user a choice, and answers. The SSE event sequence, the
 * ledger rows and the trace event sequence are pinned in
 * `__golden__/workspace-run.json`.
 *
 * This is the migration's main behaviour guard (plan §2): after every stage
 * the same request must produce the same file. A deliberate behaviour change
 * re-records it with `vitest -u` and says why in the commit.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { AgentEvent, ModelTurn } from '@agent/agent-models';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bootContractApp, listen, localFetch, type ContractApp } from './harness';

const fake = vi.hoisted(() => {
  type Msg = { role: string; tool_calls?: Array<{ id: string }> };
  const call = (n: number, name: string, args: Record<string, unknown>) => ({
    id: `golden-${n}`,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  });
  /** One step per assistant tool turn the transcript already holds. */
  const turnFor = (messages: Msg[]) => {
    const step = messages.filter((m) => m.role === 'assistant' && m.tool_calls?.some((tc) => tc.id.startsWith('golden-'))).length;
    const usage = { promptTokens: 1_000 + step * 100, completionTokens: 20 };
    const tools = (calls: ReturnType<typeof call>[]) => ({ content: '', toolCalls: calls, finishReason: 'tool_calls', usage });
    switch (step) {
      case 0:
        return tools([call(0, 'read_file', { path: 'src/greet.js' })]);
      case 1:
        return tools([call(1, 'edit_file', { path: 'src/greet.js', oldText: "'hello'", newText: "'hi'" })]);
      case 2:
        return tools([call(2, 'run_terminal', { command: 'node check.js' })]);
      case 3:
        return tools([
          call(3, 'offer_choice', {
            question: 'Which greeting should the README use?',
            options: [
              { id: 'hi', label: 'hi' },
              { id: 'hey', label: 'hey' },
            ],
          }),
        ]);
      default:
        return { content: 'Done: greet() now returns "hi" and the check passes. README wording: hi.', toolCalls: [], finishReason: 'stop', usage };
    }
  };
  return { turnFor, models: [] as string[], prompts: [] as Array<{ messages: unknown[]; tools: string[] }> };
});

vi.mock('@agent/agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/agent-core')>();
  return {
    ...actual,
    createStreamModelCall:
      () =>
      async (model: string, messages: unknown[], tools: { definitions: Array<{ function: { name: string } }> }): Promise<ModelTurn> => {
        fake.models.push(model);
        // Exactly what the model was sent: the proof that prompt assembly (and so token cost) is unchanged.
        fake.prompts.push({ messages: structuredClone(messages), tools: tools.definitions.map((d) => d.function.name) });
        return fake.turnFor(messages as Parameters<typeof fake.turnFor>[0]) as ModelTurn;
      },
    getOllamaModelConfig: async (model: string) => ({
      model,
      capabilities: ['completion', 'tools'],
      contextLength: 131_072,
      // = classifyThinking(undefined): a model with no thinking block.
      thinking: { supported: false, values: [], default: null, mode: 'none' },
      supportsTools: true,
      supportsVision: false,
    }),
    // Title generation is maintenance after the run; it must fail quietly here.
    getClient: () => {
      throw new Error('no model client in contract tests');
    },
  };
});

let api: ContractApp;
let server: Server;
let base: string;
let folder: string;

beforeAll(async () => {
  api = await bootContractApp();
  ({ server, base } = await listen(api.app));
  folder = await mkdtemp(path.join(os.tmpdir(), 'agent-golden-ws-'));
  await mkdir(path.join(folder, 'src'));
  await writeFile(path.join(folder, 'src', 'greet.js'), "module.exports = () => 'hello';\n");
  await writeFile(
    path.join(folder, 'check.js'),
    "const greet = require('./src/greet.js');\nif (greet() !== 'hi') { console.error('FAIL'); process.exit(1); }\nconsole.log('PASS');\n",
  );
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await api.close();
  await rm(folder, { recursive: true, force: true }).catch(() => undefined);
});

async function apiCall(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await localFetch(`${base}${url}`, {
    method,
    headers: { ...api.auth, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Reads the run's SSE stream to its end, answering the one choice it asks. */
async function streamRun(runId: string): Promise<AgentEvent[]> {
  const res = await localFetch(`${base}/api/agent/run/${runId}/events?fromSeq=0`, { headers: api.auth });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: AgentEvent[] = [];
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = block.split('\n').find((line) => line.startsWith('data: '));
      if (!data) continue;
      const event = JSON.parse(data.slice(6)) as AgentEvent;
      events.push(event);
      if (event.type === 'choice.requested') {
        const answered = await apiCall('POST', `/api/agent/run/${runId}/choice`, { choiceId: event.choiceId, optionIds: ['hi'] });
        expect(answered).toEqual({ status: 200, body: { ok: true } });
      }
    }
  }
  return events;
}

async function readJsonl(file: string): Promise<any[]> {
  const text = await readFile(file, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('golden workspace run', () => {
  it('produces the recorded events, ledger and trace', async () => {
    const thread = await apiCall('POST', '/api/agent/threads', { kind: 'workspace', workspaceRoot: folder, model: 'golden-model' });
    expect(thread.status).toBe(201);
    const threadId = thread.body.id as string;

    const started = await apiCall('POST', '/api/agent/run', {
      threadId,
      message: { content: 'Make greet() return "hi", run the check, and ask me which wording the README should use.' },
    });
    expect(started.status).toBe(200);
    const runId = started.body.runId as string;

    const busy = await apiCall('POST', '/api/agent/run', { threadId, message: { content: 'again' } });
    expect(busy.status).toBe(409);

    const events = await streamRun(runId);
    expect(events.at(-1)?.type).toBe('run.settled');

    // The edit landed and the check the run ran passes.
    expect(await readFile(path.join(folder, 'src', 'greet.js'), 'utf8')).toBe("module.exports = () => 'hi';\n");

    const session = path.join(api.home, 'sessions', threadId);
    const ledger = await readJsonl(path.join(session, 'ledger.jsonl'));
    const trace = await readJsonl(path.join(session, 'traces', `${runId}.jsonl`));
    const toolNameOf = new Map<string, string>();
    for (const row of ledger) for (const tc of row.record?.tool_calls ?? []) toolNameOf.set(tc.id, tc.function?.name);

    // Volatile parts of a prompt (temp paths, ids, clock) become placeholders; everything else must match byte for byte.
    const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const volatile: Array<[RegExp, string]> = [
      ...[folder, api.home, os.tmpdir(), os.homedir()].flatMap((dir): Array<[RegExp, string]> => {
        const forms = new Set([dir, dir.replace(/\\/g, '/'), dir.replace(/\\/g, '\\\\'), dir.replace(/\\/g, '\\\\\\\\')]);
        const label = dir === folder ? '<ws>' : dir === api.home ? '<home>' : dir === os.tmpdir() ? '<tmp>' : '<user>';
        return [...forms].map((form) => [new RegExp(escapeRe(form), 'gi'), label]);
      }),
      [new RegExp(escapeRe(threadId), 'g'), '<thread>'],
      [new RegExp(escapeRe(runId), 'g'), '<run>'],
      [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>'],
      [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<iso>'],
      [/\b\d{4}-\d{2}-\d{2}\b/g, '<date>'],
      [/\b[0-9a-f]{40,64}\b/g, '<sha>'],
      [/\b\d+(\.\d+)?\s?ms\b/g, '<ms>'],
    ];
    const normalize = (text: string) => volatile.reduce((acc, [pattern, label]) => acc.replace(pattern, label), text);
    const prompts = fake.prompts.map(({ messages, tools }) => {
      const text = normalize(JSON.stringify(messages));
      return {
        roles: (messages as Array<{ role: string }>).map((m) => m.role).join(','),
        chars: text.length,
        sha256: createHash('sha256').update(text).digest('hex'),
        tools: [...tools].sort(),
      };
    });

    const summary = {
      models: [...new Set(fake.models)],
      prompts,
      sse: events.map((event) => event.type),
      settled: (() => {
        const last = events.at(-1) as Extract<AgentEvent, { type: 'run.settled' }>;
        return { incomplete: last.incomplete ?? false, cancelled: last.cancelled ?? false };
      })(),
      tools: events
        .filter((event): event is Extract<AgentEvent, { type: 'tool.completed' }> => event.type === 'tool.completed')
        .map((event) => ({ tool: event.toolName, outcome: event.outcome })),
      ledger: ledger.map((row) => ({
        seq: row.seq,
        run: row.runId === null ? null : row.runId === runId ? 'run' : 'other',
        role: row.record?.role,
        ...(row.record?.role === 'user' || (row.record?.role === 'assistant' && !row.record?.tool_calls?.length)
          ? { content: row.record?.content }
          : {}),
        ...(row.record?.tool_calls?.length ? { calls: row.record.tool_calls.map((tc: { function: { name: string } }) => tc.function.name) } : {}),
        ...(row.record?.role === 'tool' ? { tool: toolNameOf.get(row.record.tool_call_id) ?? '?' } : {}),
      })),
      trace: trace.map((event) => event.type),
      runFinish: (() => {
        const finish = trace.find((event) => event.type === 'run_finish');
        return finish
          ? { status: finish.status, iterations: finish.iterations, toolCalls: finish.toolCalls, limitReason: finish.limitReason ?? null }
          : null;
      })(),
    };

    await expect(JSON.stringify(summary, null, 2) + '\n').toMatchFileSnapshot('./__golden__/workspace-run.json');
  }, 120_000);
});
