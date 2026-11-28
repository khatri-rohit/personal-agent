/**
 * One value per quantity. Where two parts of the harness mean the same
 * thing (a tool's read window and the cap applied to its result, a brief's
 * call budget and the limit it runs under), they must agree. Each check
 * names the pair it guards.
 */
import { describe, expect, it } from 'vitest';

import {
  CHARS_PER_TOKEN,
  CHILD_BUDGET_SHARE,
  childAllocation,
  compactionMarks,
  contextBudgetForWindow,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  FINDING_CLAIM_MAX_CHARS,
  FINDING_EVIDENCE_MAX_CHARS,
  FINDINGS_MAX,
  GREP_WINDOW,
  inRunMarks,
  liveResultCapChars,
  MAX_CONCURRENT_SUBAGENTS,
  MIN_CONTEXT_WINDOW_TOKENS,
  READ_WINDOW,
  REPORT_MAX_CHARS,
  THOROUGHNESS_TOOL_CALLS,
  type SubagentThoroughness,
  type TaskFinding,
} from '@agent/agent-models';

import { recordOverflowText, recordSection } from './loop/state-card';
import { createDelegateTool } from './subagent/delegate';
import { getSubagentProfile, listSubagentProfiles } from './subagent/profiles';
import { buildBrief, createReportTool } from './subagent/prompt';
import { DIGEST_MAX_CHARS } from './subagent/types';
import { record_finding } from './tools/record-finding';
import {
  WORKSPACE_GREP_MAX_CHARS,
  WORKSPACE_GREP_MAX_CONTEXT,
  WORKSPACE_READ_MAX_CHARS,
  WORKSPACE_READ_MAX_LINES,
  WORKSPACE_READ_MIN_LINES,
} from './tools/workspace/tools';

const LEVELS = Object.keys(THOROUGHNESS_TOOL_CALLS) as SubagentThoroughness[];

describe('I8: one value per quantity', () => {
  it('workspace tools use the limits module windows', () => {
    expect(WORKSPACE_READ_MAX_CHARS).toBe(READ_WINDOW.maxChars);
    expect(WORKSPACE_READ_MAX_LINES).toBe(READ_WINDOW.maxLines);
    expect(WORKSPACE_READ_MIN_LINES).toBe(READ_WINDOW.minLines);
    expect(WORKSPACE_GREP_MAX_CHARS).toBe(GREP_WINDOW.maxChars);
    expect(WORKSPACE_GREP_MAX_CONTEXT).toBe(GREP_WINDOW.maxContext);
  });

  it('the live cap never cuts a result its tool already sized', () => {
    const generic = DEFAULT_CONTEXT_BUDGET.toolResultMaxTokens * CHARS_PER_TOKEN;
    expect(liveResultCapChars('read_file', generic)).toBeGreaterThanOrEqual(READ_WINDOW.maxChars);
    expect(liveResultCapChars('grep', generic)).toBeGreaterThanOrEqual(GREP_WINDOW.maxChars);
  });

  it('on every window from 64k up, the in-run low mark holds a whole read window (a pass never strands one read)', () => {
    for (const window of [64_000, 128_000, 200_000, DEFAULT_CONTEXT_WINDOW_TOKENS, 1_000_000]) {
      expect(inRunMarks(contextBudgetForWindow(window)).low, `window ${window}`).toBeGreaterThanOrEqual(
        READ_WINDOW.maxChars / CHARS_PER_TOKEN,
      );
    }
  });

  it('the digest the parent reads holds the whole report the child is told to write', () => {
    expect(DIGEST_MAX_CHARS).toBe(REPORT_MAX_CHARS);
    const description = createReportTool(() => undefined).definition.function.description ?? '';
    expect(description).toContain(REPORT_MAX_CHARS.toLocaleString('en-US'));
  });

  it('the effort a brief names is the limit the child runs under', () => {
    const explore = getSubagentProfile('explore')!;
    expect(explore.defaultThoroughness).toBeDefined();
    for (const level of LEVELS) {
      const calls = THOROUGHNESS_TOOL_CALLS[level];
      const brief = buildBrief({ profile: 'explore', objective: 'o', scope: 's', thoroughness: level });
      expect(brief).toContain(`up to ${calls} tool calls`);
      const allocation = childAllocation({ profile: explore.limits, thoroughness: level })!;
      // One call is kept for the closing report.
      expect(allocation.maxToolCalls).toBe(calls + 1);
      expect(allocation.maxToolCalls).toBeLessThanOrEqual(explore.limits.maxToolCalls);
      expect(allocation.maxPromptTokens).toBeLessThanOrEqual(explore.limits.maxPromptTokens);
    }
  });

  it('the delegate tool states the same effort budgets and concurrency', () => {
    const delegate = createDelegateTool(listSubagentProfiles());
    const text = JSON.stringify(delegate.definition);
    for (const level of LEVELS) expect(text).toContain(`${level} (${THOROUGHNESS_TOOL_CALLS[level]} tool calls)`);
    expect(text).toContain(`at most ${MAX_CONCURRENT_SUBAGENTS} at a time`);
  });

  it('record_finding states the same size limits the task state applies', () => {
    const text = JSON.stringify(record_finding.definition);
    expect(text).toContain(`max ${FINDING_CLAIM_MAX_CHARS} chars`);
    expect(text).toContain(`max ${FINDING_EVIDENCE_MAX_CHARS} chars`);
  });

  it('the card record stays inside its window-scaled budget for any record, and loses nothing', () => {
    // Largest findings the task state allows, a full record, on the smallest
    // and the default window: the card section fits its budget, and every
    // finding it does not show is in the stored full record.
    const claim = 'c'.repeat(FINDING_CLAIM_MAX_CHARS);
    const evidence = 'e'.repeat(FINDING_EVIDENCE_MAX_CHARS);
    for (const window of [MIN_CONTEXT_WINDOW_TOKENS, DEFAULT_CONTEXT_WINDOW_TOKENS, 1_000_000]) {
      const { recordCardTokens } = contextBudgetForWindow(window);
      expect(recordCardTokens).toBeGreaterThan(0);
      expect(recordCardTokens).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET.recordCardTokens);
      for (const count of [1, 50, FINDINGS_MAX]) {
        const findings: TaskFinding[] = Array.from({ length: count }, (_, i) => ({
          claim: `${i} ${claim}`.slice(0, FINDING_CLAIM_MAX_CHARS),
          evidence,
          topic: `topic-${i % 40}`,
          iteration: i,
          verification: 'unverified',
        }));
        const section = recordSection(findings, recordCardTokens, 'a'.repeat(64));
        expect(section.join('\n').length).toBeLessThanOrEqual(recordCardTokens * CHARS_PER_TOKEN);
        const shown = section.filter((line) => line.startsWith('- [topic-')).length;
        if (shown < count) {
          expect(section.some((line) => line.includes('recall sha256:'))).toBe(true);
          const full = recordOverflowText(findings, recordCardTokens) ?? '';
          for (const finding of findings) expect(full).toContain(finding.claim);
        }
      }
    }
  });

  it('in-run marks are ordered on every window: 0 < low < high < input', () => {
    for (const window of [MIN_CONTEXT_WINDOW_TOKENS, 64_000, 128_000, DEFAULT_CONTEXT_WINDOW_TOKENS, 1_000_000]) {
      const budget = contextBudgetForWindow(window);
      const { high, low } = inRunMarks(budget);
      expect(low, `window ${window}`).toBeGreaterThan(0);
      expect(low, `window ${window}`).toBeLessThan(high);
      expect(high, `window ${window}`).toBeLessThan(window - budget.outputReserveTokens);
    }
  });

  it('the in-run high mark scales with the window, unless an absolute ceiling is set', () => {
    const at260k = inRunMarks(contextBudgetForWindow(DEFAULT_CONTEXT_WINDOW_TOKENS)).high;
    const at1m = inRunMarks(contextBudgetForWindow(1_000_000)).high;
    expect(at1m).toBeGreaterThan(at260k);
    const capped = { ...DEFAULT_CONTEXT_BUDGET, inRunHighTokens: 100_000 };
    expect(inRunMarks(contextBudgetForWindow(1_000_000, capped)).high).toBe(100_000);
    expect(inRunMarks(contextBudgetForWindow(MIN_CONTEXT_WINDOW_TOKENS, capped)).high).toBeLessThan(100_000);
  });

  it('a run starts below the in-run low mark on every window (no fold on its first steps)', () => {
    for (const window of [MIN_CONTEXT_WINDOW_TOKENS, 64_000, 128_000, DEFAULT_CONTEXT_WINDOW_TOKENS, 1_000_000]) {
      const budget = contextBudgetForWindow(window);
      expect(compactionMarks(budget).at, `window ${window}`).toBeLessThan(inRunMarks(budget).low);
    }
  });

  it('between-run marks are ordered on every window: carry-over ≤ compaction target < compaction trigger ≤ the window share', () => {
    for (const window of [MIN_CONTEXT_WINDOW_TOKENS, DEFAULT_CONTEXT_WINDOW_TOKENS, 1_000_000]) {
      const budget = contextBudgetForWindow(window);
      const input = window - budget.outputReserveTokens;
      const marks = compactionMarks(budget);
      // Results a run starts with fit inside what compaction cuts down to.
      expect(budget.carryOverToolTokens).toBeGreaterThan(0);
      expect(budget.carryOverToolTokens).toBeLessThanOrEqual(marks.to);
      expect(marks.to).toBeLessThan(marks.at);
      // The absolute figures only ever lower the window's share.
      expect(marks.at).toBeLessThanOrEqual(input * budget.compactAtRatio);
      expect(marks.to).toBeLessThanOrEqual(input * budget.compactToRatio);
    }
    // A large window does not raise what a run may start with.
    expect(compactionMarks(contextBudgetForWindow(1_000_000))).toEqual(compactionMarks(contextBudgetForWindow(DEFAULT_CONTEXT_WINDOW_TOKENS)));
  });

  it('parallel children can never be promised more than the parent has left', () => {
    const parentRemaining = 1_000_000;
    let promised = 0;
    for (let i = 0; i < MAX_CONCURRENT_SUBAGENTS; i++) {
      const allocation = childAllocation({
        profile: { maxToolCalls: 450, maxIterations: 200, maxPromptTokens: 10_000_000 },
        parentRemaining,
        promised,
      })!;
      expect(allocation.maxPromptTokens).toBeLessThanOrEqual((parentRemaining - promised) * CHILD_BUDGET_SHARE);
      promised += allocation.maxPromptTokens;
    }
    expect(promised).toBeLessThan(parentRemaining);
    expect(childAllocation({ profile: { maxToolCalls: 1, maxIterations: 1, maxPromptTokens: 1 }, parentRemaining: 10, promised: 10 })).toBeNull();
  });
});
