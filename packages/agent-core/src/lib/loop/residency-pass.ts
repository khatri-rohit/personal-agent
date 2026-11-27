import { CARD_MARKS, inputBudgetTokens, inRunMarks, windowGuardTokens } from '@agent/agent-models';

import { stubLiveToolResults } from '../context/assemble-context';
import { toolCallIndex } from '../context/outcome-card';
import {
  compactCurrentRun,
  foldResidue,
  manageWorkingSet,
  MIN_EVICT_CHARS,
  retireSkillBodies,
  windowCard,
  type EvictionReason,
  type InRunCompactionResult,
} from '../context/residency';
import { estimatePromptTokens } from '../model/estimate-prompt-tokens';
import type { ToolTraits } from '../tools/traits';
import { sha256Text } from '../tools/web/source';
import { toolCallKey } from './call-identity';
import { tracePolicyDecision } from './policy-trace';
import { recordDeltaTokens, recordMessage, removeRecordMessages } from './record-message';
import type { RunState } from './run-state';
import { recordOverflowText } from './state-card';

/**
 * What the pass reads from the run, and the fields it writes: the prompt
 * (`messages`, its job), the residency counters `markLift`, `prefixHeavy`,
 * `recordedThrough`, `recordBlobSha` and `recordBlobKey`, and the removed
 * calls it tells read dedupe, skill loads and admission about.
 */
export type ResidencyView = Pick<
  RunState,
  | 'messages'
  | 'runStart'
  | 'iterations'
  | 'contextBudget'
  | 'flags'
  | 'traitsOf'
  | 'task'
  | 'runId'
  | 'trace'
  | 'readDedupe'
  | 'skillLoads'
  | 'markLift'
  | 'prefixHeavy'
  | 'recordedThrough'
  | 'recordBlobSha'
  | 'recordBlobKey'
> & {
  readonly tools: Pick<RunState['tools'], 'definitions'>;
  readonly webSources: Pick<RunState['webSources'], 'putBlob'>;
  readonly admission: Pick<RunState['admission'], 'forgetSkillLoads' | 'forgetDeferredCall'>;
};

/**
 * The prompt projection after a tool turn (v2 phase 7). Between boundaries
 * the prompt only grows (new steps are appended); at a boundary it is
 * reshaped once, by every mechanism together, so the cached prefix breaks
 * at one known step instead of at each mechanism's own moment (P3).
 *
 * A boundary is any of: a verified milestone (a check passed after edits),
 * the whole prompt past the in-run high mark (`inRunMarks`, derived from
 * the window), a skill body retiring, or the card's new findings past
 * `CARD_MARKS.recordDeltaTokens`. Once one fires, the free removals ride
 * along (superseded copies, and card-only steps when folding them saves
 * more than it writes: the prefix is broken anyway), and the run's task
 * record is written into the history as one message, cached until the next
 * boundary.
 *
 * Order: cap oversized recent results and retire skill bodies; milestone
 * fold (before anything trims what it would fold); the pass at the high
 * mark (card-only steps, then results by value, then the recap fold); then,
 * at a boundary, the ride-along round and the record message.
 */
export async function manageResidency(s: ResidencyView): Promise<void> {
  const triggers: string[] = [];
  // A result cut here is no longer in the prompt in full: read dedupe must
  // not answer an identical call with "identical to the earlier result above".
  const stubbed = stubLiveToolResults(s.messages, s.contextBudget, s.runStart, s.flags, (id) =>
    s.readDedupe.forget([id]),
  );
  if (stubbed > 0) triggers.push('stub');

  for (const retired of retireSkillBodies(
    s.messages,
    s.skillLoads,
    s.iterations,
    s.contextBudget.skillResidentIterations,
  )) {
    // A reload after retirement is legitimate, not a repeat.
    s.admission.forgetSkillLoads();
    s.trace({
      type: 'skill_evicted',
      runId: s.runId,
      iteration: s.iterations,
      name: retired.name,
      residentIterations: s.contextBudget.skillResidentIterations,
    });
    if (!triggers.includes('skill')) triggers.push('skill');
  }

  const putBlob = (text: string) => s.webSources.putBlob(text);

  await storeRecordOverflow(s, putBlob);
  // Recap lines carry the step each folded call ran in.
  const stepOf = (toolCallId: string) => s.task.callIteration(toolCallId);

  const milestone = atVerifiedMilestone(s);
  if (milestone) {
    const compacted = await compactCurrentRun(
      s.messages,
      s.runStart,
      s.contextBudget,
      s.tools.definitions,
      putBlob,
      { milestone: true, stepOf, session: s.task.taskClass === 'long', traitsOf: s.traitsOf },
    );
    if (compacted) {
      traceFold(s, compacted, 'milestone');
      triggers.push(compacted.session ? 'session' : 'milestone');
    }
  }

  // The one budget: past the high mark (on the whole prompt), one pass down
  // to the low mark, cheapest loss first. Card-only steps fold, then results
  // leave by value, then (still over) the oldest steps fold into the recap.
  // Below the mark nothing leaves: the prompt only grows.
  const base = inRunMarks(s.contextBudget);
  if (s.markLift > 0 && estimatePromptTokens(s.messages, s.tools.definitions) <= base.low) s.markLift = 0;
  const marks = { high: base.high + s.markLift, low: base.low + s.markLift };
  if (estimatePromptTokens(s.messages, s.tools.definitions) > marks.high) {
    triggers.push('mark');
    // Without the card, the record_finding calls' arguments are the only copy
    // of the findings: steps holding them do not fold.
    const folded = await foldResidue(s.messages, s.runStart, s.contextBudget, s.tools.definitions, {
      keepFindingCalls: !s.flags.stateCard,
      stepOf,
      putBlob,
      requireSaving: true,
      traitsOf: s.traitsOf,
    });
    if (folded) traceFold(s, folded, 'residue');
    await workingSetPass(s, putBlob, { marks });
    if (!s.prefixHeavy) {
      const compacted = await compactCurrentRun(
        s.messages,
        s.runStart,
        s.contextBudget,
        s.tools.definitions,
        putBlob,
        { stepOf, traitsOf: s.traitsOf, marks },
      );
      if (compacted) {
        traceFold(s, compacted, undefined);
        if (compacted.prefixHeavy) {
          // Prior turns alone keep the prompt over the low mark. Folding one
          // more iteration per call would rewrite the prefix every call, so stop;
          // pre-run compaction handles this at the next run.
          s.prefixHeavy = true;
          s.trace({
            type: 'context_prefix_heavy',
            runId: s.runId,
            iteration: s.iterations,
            promptTokens: compacted.afterTokens,
          });
        }
      }
    }
    // The pass could not reach the low mark (prior turns, or results it may
    // not remove): lift both marks by the shortfall, so the next pass waits
    // for the same real growth as any other instead of firing every step.
    // The lifted high mark stays inside the input budget: at that ceiling a
    // pass every step is the lesser cost next to a prompt the window rejects.
    const after = estimatePromptTokens(s.messages, s.tools.definitions);
    if (after > marks.low) {
      const input = Math.max(1, s.contextBudget.windowTokens - s.contextBudget.outputReserveTokens);
      s.markLift = Math.min(after - base.low, Math.max(0, input * LIFTED_HIGH_CEILING - base.high));
    }
  }

  const findings = s.flags.stateCard ? s.task.snapshot().evidence.findings : [];
  const recordDue =
    findings.length > s.recordedThrough &&
    recordDeltaTokens(findings, s.recordedThrough) >= CARD_MARKS.recordDeltaTokens;
  if (triggers.length === 0 && !recordDue) return;
  if (triggers.length === 0) triggers.push('record');

  // Ride-along round: the prefix changes at this step anyway, so losses that
  // cost nothing go now: superseded copies, and card-only steps when folding
  // them frees more than the recap line (a record-only boundary keeps the
  // break small: only from the old record message onward).
  if (!(triggers.length === 1 && triggers[0] === 'record')) {
    if (await workingSetPass(s, putBlob, { freeOnly: true })) triggers.push('ride_along');
    const residue = await foldResidue(s.messages, s.runStart, s.contextBudget, s.tools.definitions, {
      keepFindingCalls: !s.flags.stateCard,
      stepOf,
      putBlob,
      requireSaving: true,
      traitsOf: s.traitsOf,
    });
    if (residue) {
      traceFold(s, residue, 'residue');
      if (!triggers.includes('ride_along')) triggers.push('ride_along');
    }
  }

  // The task record joins the history at the boundary (F-6); the card then
  // carries only findings recorded after it.
  if (s.flags.stateCard) {
    removeRecordMessages(s.messages, s.runStart);
    if (findings.length > 0) {
      s.messages.push(recordMessage(findings, s.contextBudget.recordCardTokens, s.recordBlobSha));
      s.recordedThrough = findings.length;
    }
  }
  tracePolicyDecision(s, 'boundary', triggers.map((trigger) => `boundary:${trigger}`), 'prompt reshaped once for all mechanisms', {
    findingsInHistory: s.recordedThrough,
  });
}

/**
 * A result the window guard may turn into a card (flags.windowGuard). Not:
 * live state or a sub-agent report (`never`, a child run to get back), a
 * restore of a stored result (the model asked for that exact text), a
 * change (its report is the receipt of an edit already made) or a command
 * (getting it back would mean running it again, which may not be safe).
 */
function deferrable(traits: ToolTraits | undefined): boolean {
  if (!traits) return true;
  if (traits.residency === 'never' || traits.restores) return false;
  return traits.effect !== 'subagent' && traits.effect !== 'change' && traits.effect !== 'command';
}

/** A tool row the window guard is about: where it is, which call, and what it holds. */
type GuardedRow = { index: number; toolCallId: string; name: string; rawArgs: string; content: string };

/**
 * Turn one row into a window card (flags.windowGuard): the full text goes to
 * the blob store first, so the card's sha restores it. Read dedupe forgets
 * the call (it recorded the result as seen while shaping it), admission
 * stops counting it as a use (asking again is not a repeat), and a row of
 * the same turn that dedupe answered "(unchanged …)" with this call as its
 * copy gets the same card, since the copy it pointed at is gone.
 */
async function deferRow(s: ResidencyView, row: GuardedRow): Promise<void> {
  const traits = s.traitsOf(row.name);
  const sha = await s.webSources.putBlob(row.content);
  const card = windowCard(row.name, row.rawArgs, traits, row.content, sha);
  s.messages[row.index] = { role: 'tool', tool_call_id: row.toolCallId, content: card };
  s.readDedupe.forget([row.toolCallId]);
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.rawArgs);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    // A call whose arguments do not parse never ran; nothing to uncount.
  }
  s.admission.forgetDeferredCall(row.name, args);
  const key = toolCallKey(row.name, args);
  const calls = toolCallIndex(s.messages);
  for (let i = s.runStart; i < s.messages.length; i++) {
    const message = s.messages[i];
    if (i === row.index || message?.role !== 'tool' || typeof message.content !== 'string') continue;
    if (!message.content.startsWith('(unchanged')) continue;
    const info = calls.get(message.tool_call_id);
    if (!info || info.name !== row.name) continue;
    let otherArgs: unknown = {};
    try {
      otherArgs = JSON.parse(info.args);
    } catch {
      continue;
    }
    if (toolCallKey(info.name, otherArgs) !== key) continue;
    s.messages[i] = { role: 'tool', tool_call_id: message.tool_call_id, content: card };
  }
  s.trace({
    type: 'tool_note',
    runId: s.runId,
    iteration: s.iterations,
    toolName: row.name,
    note: 'window_deferred',
    count: row.content.length,
  });
}

/**
 * flags.windowGuard, per result, right after it joined the prompt. Below
 * the window guard (`windowGuardTokens`, 0.9 of the input budget) nothing
 * happens. Past it, first make room the normal way: one working-set pass
 * down to the in-run low mark with only this turn's results pinned (results
 * the model already saw in earlier steps leave by value, cheapest first;
 * the ordinary pass pins the newest four steps, so a turn that read a lot
 * left nothing to remove and a re-read was deferred again). Only if the
 * prompt is still past the guard does this result become a window card.
 * Results of one turn settle in order, so the first stay whole. The ledger
 * and the trace keep the full result either way.
 */
export async function guardResultWindow(
  s: ResidencyView,
  result: { toolCallId: string; name: string; rawArgs: string; content: string },
): Promise<void> {
  if (result.content.length < MIN_EVICT_CHARS || !deferrable(s.traitsOf(result.name))) return;
  const guard = windowGuardTokens(s.contextBudget);
  if (estimatePromptTokens(s.messages, s.tools.definitions) <= guard) return;
  const putBlob = (text: string) => s.webSources.putBlob(text);
  if (await workingSetPass(s, putBlob, { marks: { high: guard, low: inRunMarks(s.contextBudget).low }, keepSteps: 1 })) {
    tracePolicyDecision(s, 'boundary', ['boundary:window', 'boundary:working_set'], 'turn past the window guard: earlier results left first');
  }
  if (estimatePromptTokens(s.messages, s.tools.definitions) <= guard) return;
  let index = -1;
  for (let i = s.messages.length - 1; i >= s.runStart; i--) {
    const message = s.messages[i];
    if (message?.role === 'tool' && message.tool_call_id === result.toolCallId) {
      index = i;
      break;
    }
  }
  if (index < 0) return;
  await deferRow(s, { index, ...result });
}

/**
 * Headroom kept below the input budget for the harness card, which is added
 * after this check (`withStateCard`): its findings section is bounded by
 * `recordCardTokens`, plus a few lines of state and advice.
 */
const CARD_LINES_TOKENS = 1_000;

/**
 * flags.windowGuard, before a model call: the prompt plus the card it is
 * about to get would be over the input budget (window minus output
 * reserve), so the provider would reject it. In order, each only if still
 * over:
 * 1. a working-set pass down to the window guard, pinning the last
 *    completed step (the loop has already counted the call about to be
 *    sent, so pinning one step would pin nothing, and the model has not
 *    seen that step's results yet);
 * 2. the recap fold, keeping the same step;
 * 3. the largest results of that step become window cards, as the
 *    per-result guard would have done.
 * Results before `runStart` (earlier turns) stay: only between-run
 * compaction may change them, so a thread whose earlier turns alone fill
 * the window is sent as it is (traced `stillOver`). Returns the estimate
 * after the pass.
 */
export async function enforceWindow(s: ResidencyView): Promise<number> {
  const input = inputBudgetTokens(s.contextBudget);
  const sendLimit = input - s.contextBudget.recordCardTokens - CARD_LINES_TOKENS;
  const estimate = () => estimatePromptTokens(s.messages, s.tools.definitions);
  const before = estimate();
  if (before <= sendLimit) return before;
  const putBlob = (text: string) => s.webSources.putBlob(text);
  // Down to the window guard: what is needed, plus the guard's headroom.
  const guard = windowGuardTokens(s.contextBudget);
  const marks = { high: guard, low: guard };
  const triggers = ['boundary:window'];
  if (await workingSetPass(s, putBlob, { marks, keepSteps: 2 })) triggers.push('boundary:working_set');
  if (estimate() > sendLimit) {
    const compacted = await compactCurrentRun(
      s.messages,
      s.runStart,
      { ...s.contextBudget, inRunKeepToolResults: 2 },
      s.tools.definitions,
      putBlob,
      { stepOf: (toolCallId) => s.task.callIteration(toolCallId), traitsOf: s.traitsOf, marks },
    );
    if (compacted) {
      traceFold(s, compacted, undefined);
      triggers.push('boundary:recap');
    }
  }
  if (estimate() > sendLimit) {
    // The last completed step's own results, largest first.
    const lastStep = s.iterations - 1;
    const calls = toolCallIndex(s.messages);
    const rows: GuardedRow[] = [];
    for (let i = s.runStart; i < s.messages.length; i++) {
      const message = s.messages[i];
      if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
      if (s.task.callIteration(message.tool_call_id) !== lastStep) continue;
      const info = calls.get(message.tool_call_id);
      if (!info || message.content.length < MIN_EVICT_CHARS || message.content.startsWith('(')) continue;
      if (!deferrable(s.traitsOf(info.name))) continue;
      rows.push({ index: i, toolCallId: message.tool_call_id, name: info.name, rawArgs: info.args, content: message.content });
    }
    rows.sort((a, b) => b.content.length - a.content.length);
    for (const row of rows) {
      if (estimate() <= sendLimit) break;
      await deferRow(s, row);
      if (!triggers.includes('boundary:deferred')) triggers.push('boundary:deferred');
    }
  }
  const after = estimate();
  tracePolicyDecision(s, 'boundary', triggers, 'prompt over the input budget before a model call', {
    beforeTokens: before,
    afterTokens: after,
    sendLimit,
    stillOver: after > sendLimit,
  });
  return after;
}

/**
 * One working-set pass (`freeOnly`: superseded copies only; `marks`: this
 * run's marks; `keepSteps`: newest steps pinned, default the budget's
 * `inRunKeepToolResults`); true when it removed anything.
 */
async function workingSetPass(
  s: ResidencyView,
  putBlob: (text: string) => Promise<string>,
  options: { freeOnly?: boolean; marks?: { high: number; low: number }; keepSteps?: number } = {},
): Promise<boolean> {
  const { keepSteps, ...passOptions } = options;
  const evicted = await manageWorkingSet(
    s.messages,
    s.runStart,
    keepSteps === undefined ? s.contextBudget : { ...s.contextBudget, inRunKeepToolResults: keepSteps },
    s.tools.definitions,
    putBlob,
    s.traitsOf,
    {
      iteration: s.iterations,
      callIteration: (id) => s.task.callIteration(id),
      lastTouch: (path) => s.task.lastTouch(path),
      isUnchecked: (path) => s.task.isUnchecked(path),
      isCited: (path) => s.task.isCited(path),
      isRestored: (path) => s.task.wasRestored(path),
    },
    passOptions,
  );
  if (!evicted) return false;
  s.readDedupe.forget(evicted.toolCallIds);
  // One trace line per reason, so eval can tell superseded copies, cited
  // files and removals for the mark apart. Token counts are for the whole pass.
  for (const [reason, ids] of Object.entries(evicted.byReason) as Array<[EvictionReason, string[]]>) {
    s.trace({
      type: 'context_evicted',
      runId: s.runId,
      iteration: s.iterations,
      evicted: ids.length,
      beforeTokens: evicted.beforeTokens,
      afterTokens: evicted.afterTokens,
      toolCallIds: ids,
      reason,
    });
  }
  return true;
}

/**
 * Keep the whole task record recallable once it outgrows the card's record
 * budget: store it as a blob (again only when it changed) and keep the sha
 * on the run state for the card. Findings are never dropped from task
 * state; this makes the ones the card cannot show reachable at 0 calls'
 * search cost (one recall).
 */
async function storeRecordOverflow(s: ResidencyView, putBlob: (text: string) => Promise<string>): Promise<void> {
  if (!s.flags.stateCard) return;
  const full = recordOverflowText(s.task.snapshot().evidence.findings, s.contextBudget.recordCardTokens);
  if (full === null) return;
  const key = sha256Text(full);
  if (key === s.recordBlobKey) return;
  s.recordBlobSha = await putBlob(full);
  s.recordBlobKey = key;
}

/** Forget what a fold removed and trace it. `reason` undefined = the recap fold at the high mark. */
function traceFold(s: ResidencyView, fold: InRunCompactionResult, reason: 'milestone' | 'residue' | undefined): void {
  s.readDedupe.forget(fold.toolCallIds);
  for (const id of fold.toolCallIds) s.skillLoads.delete(id);
  s.trace({
    type: 'context_compacted_inrun',
    runId: s.runId,
    iteration: s.iterations,
    beforeTokens: fold.beforeTokens,
    afterTokens: fold.afterTokens,
    toolCallIds: fold.toolCallIds,
    ...(reason ? { reason } : {}),
  });
}

/**
 * A check passed this iteration after edits (verified state), and this
 * run's own context is big enough that folding it pays for the one-time
 * change to the cached prefix.
 */
function atVerifiedMilestone(s: ResidencyView): boolean {
  const check = s.task.snapshot().evidence.lastCheck;
  if (!check || check.iteration !== s.iterations || check.exitCode !== 0 || !check.afterEdit) {
    return false;
  }
  const ownTokens = estimatePromptTokens(s.messages.slice(s.runStart));
  return ownTokens >= MILESTONE_SHARE_OF_HIGH * inRunMarks(s.contextBudget).high;
}

/** Share of the input budget a lifted high mark may reach (`RunState.markLift`). Exported for the invariants test only. */
export const LIFTED_HIGH_CEILING = 0.95;

/** A milestone folds once the run's own steps reach this share of the high mark (smaller is not worth a prefix break). */
const MILESTONE_SHARE_OF_HIGH = 0.1;
