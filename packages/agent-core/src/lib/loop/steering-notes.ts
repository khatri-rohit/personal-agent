import { estimatePromptTokens } from '../model/estimate-prompt-tokens';
import { EVIDENCE_WORDS } from '../policy';
import type { ProgressSteering } from './progress-steering';
import type { RunBudget } from './run-budget';
import type { RunState } from './run-state';

/**
 * Loop-control notes. None of them is a durable turn: they never reach the
 * ledger. With the harness card on (flags.stateCard), budget, stall and
 * advisor advice live on the card, rebuilt from state every step; these
 * functions then only trace the moment the condition starts. With it off
 * each returns its note, and the caller appends it to the live prompt
 * (`pushHarnessNote`; the earlier behaviour, for A/B). None writes the prompt.
 */

/** What the notes read from the run. */
export type NotesView = Pick<RunState, 'flags' | 'trace' | 'runId' | 'iterations' | 'can' | 'messages'> & {
  readonly tools: Pick<RunState['tools'], 'definitions'>;
  readonly budget: Pick<RunBudget, 'takeWarning' | 'spent'>;
  readonly steering: Pick<ProgressSteering, 'takeStallNudge'>;
};

/** The advisor hint also writes: it is given once, and with the card on it waits in `advisories`. */
export type AdvisorView = Pick<RunState, 'flags' | 'can' | 'advisorHinted' | 'advisories'>;

export const OPEN_PLAN_WORK_NUDGE =
  'Open todos remain on the Final plan. If the user\'s current request covers them, finish them or update their status before ending the turn, and do not claim that work is done. If the request covers only part of the plan, record that with todo scope, then answer and list what remains.';

export const BUDGET_NUDGE =
  'Run budget nearly spent. Finish the current step, run verification once, and report what is done and what is left. Do not start new work.';

export const ADVISOR_HINT =
  'The same command produced the same result twice. If you are stuck, delegate to the advisor profile with the specific question instead of retrying.';

/** The budget warning, once, when the run nears its prompt cap; its note when the card is off. */
export function budgetNote(s: NotesView): string | null {
  const warning = s.budget.takeWarning();
  if (!warning) return null;
  s.trace({
    type: 'budget_warning',
    runId: s.runId,
    iteration: s.iterations,
    reason: 'prompt tokens',
    promptTokens: warning.spent,
    limitPromptTokens: warning.limit,
  });
  return s.flags.stateCard ? null : BUDGET_NUDGE;
}

/** The stall nudge, once per stall; its note when the card is off. */
export function progressNote(s: NotesView): string | null {
  const stall = s.steering.takeStallNudge();
  if (!stall) return null;
  const { idle, max } = stall;
  const spent = s.budget.spent();
  s.trace({
    type: 'stall_nudge',
    runId: s.runId,
    iteration: s.iterations,
    idleTokens: idle,
    promptTokens: spent,
    limitPromptTokens: max,
  });
  if (s.flags.stateCard) return null;
  const perCall = Math.max(1, estimatePromptTokens(s.messages, s.tools.definitions));
  const callsLeft = Math.floor(Math.max(0, max - spent) / perCall);
  const delegate = s.can.delegate
    ? ' If one specific fact is still missing, delegate(explore) with that question instead of searching more yourself.'
    : '';
  return `${Math.round(idle / 1000)}k prompt tokens (${Math.round((idle / max) * 100)}% of this run's budget) went to steps with no new evidence (${EVIDENCE_WORDS}). About ${callsLeft} model calls remain at the current context size. Act on what you have: make the change if one was asked; otherwise answer from what you have confirmed.${delegate}`;
}

/** The advisor hint after a near-stuck outcome, once per run; its note when the card is off. */
export function advisorNote(s: AdvisorView): string | null {
  if (s.advisorHinted || !s.can.delegate) return null;
  s.advisorHinted = true;
  if (!s.flags.stateCard) return ADVISOR_HINT;
  s.advisories.push(ADVISOR_HINT);
  return null;
}
