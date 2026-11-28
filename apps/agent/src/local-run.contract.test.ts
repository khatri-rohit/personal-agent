/**
 * Contract: the CLI's isolated local run (local-run.ts). A scripted model
 * drives one Workspace run; the exact prompt of each model call (sha256,
 * volatile parts normalised), the event and trace sequences, the auto-picked
 * choice and the outcome are pinned in `__golden__/local-run.json`.
 *
 * The CLI run stays isolated: no agent home, no memory, built-in skills
 * only. Its context budget is resolved by agent-service.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgentEvent, ModelTurn, TraceEvent } from '@agent/agent-models';
import { WORKSPACE_MODE } from '@agent/agent-models';
import type { ModelCallFn } from '@agent/agent-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runLocally } from './local-run';

type Msg = { role: string; tool_calls?: Array<{ id: string }> };

const prompts: Array<{ messages: unknown[]; tools: string[] }> = [];

const call = (n: number, name: string, args: Record<string, unknown>) => ({
  id: `cli-${n}`,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

/** One step per assistant tool turn already in the transcript. */
const scripted: ModelCallFn = async (_model, messages, tools) => {
  prompts.push({
    messages: structuredClone(messages),
    tools: tools.definitions.map((d) => (d as { function: { name: string } }).function.name),
  });
  const step = (messages as Msg[]).filter((m) => m.role === 'assistant' && m.tool_calls?.some((tc) => tc.id.startsWith('cli-'))).length;
  const usage = { promptTokens: 1_000 + step * 100, completionTokens: 20 };
  const tool = (c: ReturnType<typeof call>): ModelTurn => ({ content: '', toolCalls: [c], finishReason: 'tool_calls', usage });
  switch (step) {
    case 0:
      return tool(call(0, 'read_file', { path: 'src/greet.js' }));
    case 1:
      return tool(call(1, 'edit_file', { path: 'src/greet.js', oldText: "'hello'", newText: "'hi'" }));
    case 2:
      return tool(call(2, 'run_terminal', { command: 'node check.js' }));
    case 3:
      return tool(
        call(3, 'offer_choice', {
          question: 'Which greeting should the README use?',
          options: [
            { id: 'hi', label: 'hi' },
            { id: 'hey', label: 'hey' },
          ],
        }),
      );
    default:
      return { content: 'Done: greet() returns "hi" and the check passes.', toolCalls: [], finishReason: 'stop', usage };
  }
};

let folder: string;

beforeAll(async () => {
  // No network: /api/show fails, so the budget takes its documented 260k fallback.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      throw new Error(`network is disabled in CLI contract tests: ${String(input)}`);
    }),
  );
  folder = await mkdtemp(path.join(os.tmpdir(), 'agent-cli-ws-'));
  await mkdir(path.join(folder, 'src'));
  await writeFile(path.join(folder, 'src', 'greet.js'), "module.exports = () => 'hello';\n");
  await writeFile(
    path.join(folder, 'check.js'),
    "const greet = require('./src/greet.js');\nif (greet() !== 'hi') { console.error('FAIL'); process.exit(1); }\nconsole.log('PASS');\n",
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await rm(folder, { recursive: true, force: true }).catch(() => undefined);
});

describe('CLI local run', () => {
  it('runs isolated and produces the recorded prompts, events and trace', async () => {
    const events: AgentEvent[] = [];
    const trace: TraceEvent[] = [];
    const end = await runLocally({
      query: 'Make greet() return "hi", run the check, and ask me which wording the README should use.',
      mode: WORKSPACE_MODE,
      posture: 'agent',
      model: 'cli-golden-model',
      modelCall: scripted,
      workspaceRoot: folder,
      trace: (event) => trace.push(event),
      onEvent: (event) => events.push(event),
    });

    expect(await readFile(path.join(folder, 'src', 'greet.js'), 'utf8')).toBe("module.exports = () => 'hi';\n");

    const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const runId = end.result.runId;
    const volatile: Array<[RegExp, string]> = [
      ...[folder, os.tmpdir(), os.homedir()].flatMap((dir): Array<[RegExp, string]> => {
        const forms = new Set([dir, dir.replace(/\\/g, '/'), dir.replace(/\\/g, '\\\\'), dir.replace(/\\/g, '\\\\\\\\')]);
        const label = dir === folder ? '<ws>' : dir === os.tmpdir() ? '<tmp>' : '<user>';
        return [...forms].map((form) => [new RegExp(escapeRe(form), 'gi'), label]);
      }),
      [new RegExp(escapeRe(runId), 'g'), '<run>'],
      [/local-\d+/g, '<local-thread>'],
      [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>'],
      [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<iso>'],
      [/\b\d{4}-\d{2}-\d{2}\b/g, '<date>'],
      [/\b[0-9a-f]{40,64}\b/g, '<sha>'],
      [/\b\d+(\.\d+)?\s?ms\b/g, '<ms>'],
    ];
    const normalize = (text: string) => volatile.reduce((acc, [pattern, label]) => acc.replace(pattern, label), text);

    const summary = {
      outcome: end.outcome,
      iterations: end.result.iterations,
      prompts: prompts.map(({ messages, tools }) => {
        const text = normalize(JSON.stringify(messages));
        return {
          roles: (messages as Msg[]).map((m) => m.role).join(','),
          chars: text.length,
          sha256: createHash('sha256').update(text).digest('hex'),
          tools: [...tools].sort(),
        };
      }),
      events: events.filter((event) => event.type !== 'assistant.delta').map((event) => event.type),
      choice: events
        .filter((event): event is Extract<AgentEvent, { type: 'choice.resolved' }> => event.type === 'choice.resolved')
        .map((event) => normalize(JSON.stringify(event).replace(/"choiceId":"[^"]+"/, '"choiceId":"<choice>"'))),
      trace: trace.map((event) => event.type),
    };

    await expect(JSON.stringify(summary, null, 2) + '\n').toMatchFileSnapshot('./__golden__/local-run.json');
  }, 120_000);
});
