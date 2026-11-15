/**
 * The tool traits contract: what a tool declares is what the task state and
 * the working set do with its calls. The proof that matters is a tool the
 * harness has never heard of: declaring traits is enough for its calls to
 * count as evidence, need a check, and stay in the working set.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONTEXT_BUDGET, type ContextBudget, type TraceEvent } from '@agent/agent-models';

import { manageWorkingSet, residentReadPaths, type WorkingSetView } from '../context/residency';
import { TaskStateTracker } from '../state/task-state';
import {
  builtinToolTraits,
  builtinTraitNames,
  fileLineRange,
  traitsResolver,
  type ToolTraits,
} from './traits';

const runId = 'r1';
const request = (iteration: number): TraceEvent => ({ type: 'llm_request', runId, iteration });
const start = (iteration: number, id: string, toolName: string, args: unknown): TraceEvent => ({
  type: 'tool_start',
  runId,
  iteration,
  toolName,
  toolCallId: id,
  args,
});
const complete = (
  iteration: number,
  id: string,
  toolName: string,
  resultPreview: string,
  extra: Partial<Extract<TraceEvent, { type: 'tool_complete' }>> = {},
): TraceEvent => ({ type: 'tool_complete', runId, iteration, toolName, toolCallId: id, durationMs: 0, resultPreview, ...extra });

/** Tools the harness does not ship. Their names appear nowhere in the core. */
const NEW_TOOLS: Record<string, ToolTraits> = {
  save_document: { effect: 'change', file: (args) => (typeof args.document === 'string' ? args.document : null) },
  run_suite: {
    effect: 'command',
    isCheck: () => true,
    repeatKey: (args) => (typeof args.suite === 'string' ? args.suite : null),
  },
  open_document: {
    effect: 'read',
    file: (args) => (typeof args.document === 'string' ? args.document : null),
    lineRange: fileLineRange,
  },
  page_snapshot: {
    effect: 'read',
    file: (args) => (typeof args.page === 'string' ? args.page : null),
    repeatKey: (args) => (typeof args.page === 'string' ? args.page : null),
    residency: 'no_aging',
  },
};
const traitsOf = traitsResolver((name) => NEW_TOOLS[name]);

describe('a tool the harness has never heard of', () => {
  it('counts as an edit that needs a check, and its check clears it', () => {
    const tracker = new TaskStateTracker(traitsOf);
    for (const event of [
      request(1),
      start(1, 'a', 'save_document', { document: 'report.docx' }),
      complete(1, 'a', 'save_document', 'saved', { outcome: 'ok' }),
    ]) {
      tracker.apply(event);
    }
    expect(tracker.snapshot().evidence.edits).toBe(1);
    expect(tracker.shape).toBe('change');
    expect(tracker.unchecked).toBe(true);
    expect(tracker.isUnchecked('report.docx')).toBe(true);
    expect(tracker.evidenceCount).toBe(1);
    expect(tracker.current).toBe('change');

    for (const event of [
      request(2),
      start(2, 'b', 'run_suite', { suite: 'docs' }),
      complete(2, 'b', 'run_suite', 'ok', { exitCode: 0 }),
    ]) {
      tracker.apply(event);
    }
    expect(tracker.unchecked).toBe(false);
    expect(tracker.evidenceCount).toBe(2);
    expect(tracker.snapshot().evidence.lastCheck).toMatchObject({ command: 'docs', check: true, exitCode: 0 });
  });

  it('a failed change is a failed edit, not evidence', () => {
    const tracker = new TaskStateTracker(traitsOf);
    for (const event of [
      request(1),
      start(1, 'a', 'save_document', { document: 'report.docx' }),
      complete(1, 'a', 'save_document', 'refused', { outcome: 'error' }),
    ]) {
      tracker.apply(event);
    }
    expect(tracker.snapshot().evidence).toMatchObject({ edits: 0, failedEdits: 1 });
    expect(tracker.evidenceCount).toBe(0);
  });

  it('counts as reading a file when it returns a window of the file', () => {
    const tracker = new TaskStateTracker(traitsOf);
    for (const event of [
      request(1),
      start(1, 'a', 'open_document', { document: 'report.docx' }),
      complete(1, 'a', 'open_document', '[lines 1–40 of 90]\n…'),
    ]) {
      tracker.apply(event);
    }
    expect(tracker.snapshot().workingSet).toEqual([
      { path: 'report.docx', reads: 1, edits: 0, failedEdits: 0, lastReadIteration: 1, lastRange: { from: 1, to: 40, of: 90 } },
    ]);
    expect(tracker.current).toBe('locate');
  });

  it('without traits it is a generic call: no evidence, no working set', () => {
    const tracker = new TaskStateTracker(traitsOf);
    for (const event of [
      request(1),
      start(1, 'a', 'mystery_tool', { path: 'a.ts' }),
      complete(1, 'a', 'mystery_tool', 'done', { outcome: 'ok' }),
    ]) {
      tracker.apply(event);
    }
    expect(tracker.evidenceCount).toBe(0);
    expect(tracker.snapshot().workingSet).toEqual([]);
    expect(tracker.current).toBe('orient');
  });

  it('what a tool declares on itself wins over the built-in table', () => {
    const resolve = traitsResolver((name) => (name === 'grep' ? { effect: 'change' } : undefined));
    expect(resolve('grep')).toEqual({ effect: 'change' });
    expect(resolve('read_file')).toBe(builtinToolTraits('read_file'));
    expect(resolve('mystery_tool')).toBeUndefined();
  });
});

type Call = { id: string; name: string; args: Record<string, unknown>; result: string; iteration: number };

function transcript(calls: Call[]): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'go' }];
  for (const call of calls) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }],
    });
    messages.push({ role: 'tool', tool_call_id: call.id, content: call.result });
  }
  return messages;
}

function view(calls: Call[], iteration: number, cited: string[] = []): WorkingSetView {
  return {
    iteration,
    callIteration: (id) => calls.find((call) => call.id === id)?.iteration,
    lastTouch: () => undefined,
    isUnchecked: () => false,
    isCited: (file) => cited.includes(file),
  };
}

const budget = (over: Partial<ContextBudget> = {}): ContextBudget => ({
  ...DEFAULT_CONTEXT_BUDGET,
  inRunClearAtLeastTokens: 500,
  inRunResidentToolTokens: 100_000,
  inRunColdAfterIterations: 4,
  inRunKeepToolResults: 1,
  ...over,
});
const blob = async (text: string) => `sha-${text.length}`;
const body = (label: string, chars = 4_000) => `${label}\n${'x'.repeat(chars)}`;
const resident = (messages: ChatCompletionMessageParam[], id: string) =>
  !String(messages.find((message) => message.role === 'tool' && message.tool_call_id === id)?.content).startsWith('(evicted)');

describe('working set: results that are material under judgement', () => {
  /** The live review: one diff per file, then many steps of reading. */
  const diffs = (count: number, chars = 4_000): Call[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `d${i}`,
      name: 'diff',
      args: { path: `src/f${i}.ts` },
      result: body(`diff --git a/src/f${i}.ts`, chars),
      iteration: i + 1,
    }));

  it('a diff does not leave because it is old (it used to go cold after four steps)', async () => {
    const calls = diffs(6);
    const messages = transcript(calls);
    // Step 20: every diff is far past the cold window, and the cap is not reached.
    expect(await manageWorkingSet(messages, 1, budget(), [], blob, builtinToolTraits, view(calls, 20))).toBeNull();
    expect(calls.every((call) => resident(messages, call.id))).toBe(true);
  });

  it('the same diff taken again replaces the earlier copy', async () => {
    const calls: Call[] = [
      { id: 'a', name: 'diff', args: { path: 'src/a.ts' }, result: body('diff a v1'), iteration: 1 },
      { id: 'b', name: 'diff', args: { path: 'src/b.ts' }, result: body('diff b'), iteration: 2 },
      { id: 'c', name: 'diff', args: { path: 'src/a.ts' }, result: body('diff a v2'), iteration: 3 },
    ];
    const messages = transcript(calls);
    const result = await manageWorkingSet(messages, 1, budget(), [], blob, builtinToolTraits, view(calls, 3));
    expect(result?.byReason).toEqual({ superseded: ['a'] });
    expect(resident(messages, 'b')).toBe(true);
    expect(resident(messages, 'c')).toBe(true);
  });

  it('under the cap’s pressure, diffs of files a finding already cites leave first', async () => {
    const calls = diffs(6, 8_000);
    const messages = transcript(calls);
    // Six 2k-token diffs against a 6k cap: half must go. Two files are judged (cited).
    const result = await manageWorkingSet(
      messages,
      1,
      budget({ inRunResidentToolTokens: 6_000 }),
      [],
      blob,
      builtinToolTraits,
      view(calls, 7, ['src/f4.ts', 'src/f5.ts']),
    );
    expect(result?.byReason.cited).toEqual(expect.arrayContaining(['d4', 'd5']));
    expect(resident(messages, 'd4')).toBe(false);
    expect(resident(messages, 'd5')).toBe(false);
  });

  it('a new tool gets the same treatment by declaring it', async () => {
    const calls: Call[] = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      name: 'page_snapshot',
      args: { page: `/page/${i}` },
      result: body(`snapshot ${i}`),
      iteration: i + 1,
    }));
    const messages = transcript(calls);
    expect(await manageWorkingSet(messages, 1, budget(), [], blob, traitsOf, view(calls, 20))).toBeNull();

    // Without traits the same results age out.
    const generic = transcript(calls);
    const aged = await manageWorkingSet(generic, 1, budget(), [], blob, () => undefined, view(calls, 20));
    expect(aged?.byReason.cold?.length).toBeGreaterThan(0);
  });

  it('only a window of the file’s own content counts as the file being read', () => {
    const calls: Call[] = [
      { id: 'a', name: 'read_file', args: { path: 'src/a.ts' }, result: `[lines 1–50 of 50]\n${'r'.repeat(900)}`, iteration: 1 },
      { id: 'b', name: 'diff', args: { path: 'src/b.ts' }, result: body('diff b'), iteration: 2 },
    ];
    expect([...residentReadPaths(transcript(calls))]).toEqual(['src/a.ts']);
  });
});

describe('the built-in table', () => {
  it('declares what each kind of tool needs', () => {
    for (const name of builtinTraitNames()) {
      const traits = builtinToolTraits(name)!;
      // A command must say what a check is and what the command text is.
      if (traits.effect === 'command') {
        expect(traits.isCheck, name).toBeTypeOf('function');
        expect(traits.repeatKey, name).toBeTypeOf('function');
      }
      // A change is about a file: the working set and the done check need it.
      if (traits.effect === 'change') expect(traits.file, name).toBeTypeOf('function');
      // A file window names its file.
      if (traits.lineRange) expect(traits.file, name).toBeTypeOf('function');
    }
    expect(builtinToolTraits('toString')).toBeUndefined();
  });
});

describe('the core does not know tools by name', () => {
  // Every tool the harness ships or a host adds. A quoted name in these files
  // is a per-tool branch: the behaviour belongs in the tool's traits instead.
  // (`report`, the sub-agent's tool, is left out: it is also a task phase.)
  const NAMES = [...builtinTraitNames(), 'memory', 'offer_choice'];
  const quoted = new RegExp(`['"\`](${NAMES.join('|')})['"\`]`, 'g');

  it.each(['../state/task-state.ts', '../context/residency.ts'])('%s names no tool', (file) => {
    const source = readFileSync(path.join(__dirname, file), 'utf8');
    expect(source.match(quoted) ?? []).toEqual([]);
  });
});
