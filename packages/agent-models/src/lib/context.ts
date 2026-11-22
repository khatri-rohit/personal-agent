/**
 * Token budget for assembleContext. Numbers are defaults until /api/show
 * supplies a real window.
 */
export type ContextBudget = {
  /** Total model context window. */
  windowTokens: number;
  /** Reserved for the model's answer. */
  outputReserveTokens: number;
  /** Soft trigger for compaction (e.g. 0.65). M2 reports this; M4 acts on it. */
  compactAtRatio: number;
  /**
   * The same trigger in absolute tokens; the lower of the two applies (see
   * `compactionMarks`). History is re-sent on every call of the next run, so
   * what a run may start with is bounded by cost, not by the window: a
   * larger window is headroom for one run, not room to carry more.
   */
  compactAtTokens: number;
  /** Per-call cap before a tool result is stubbed even in the recent tail. */
  toolResultMaxTokens: number;
  /** Tool results older than this many user turns become stubs. */
  keepToolResultsForTurns: number;
  /** Image attachments older than this many user turns become text stubs. */
  keepAttachmentsForTurns: number;
  /** Between-run compaction cuts older turns until history fits this share of the input budget. */
  compactToRatio: number;
  /** The same target in absolute tokens; the lower of the two applies. */
  compactToTokens: number;
  /**
   * Tool results from earlier turns kept in full when a run starts, newest
   * first. Past it the older ones become cards (the same cards results older
   * than `keepToolResultsForTurns` get). Absolute, like the in-run working
   * set: a "continue" turn used to carry the whole previous run's results
   * (live run: 154k tokens on every call).
   */
  carryOverToolTokens: number;
  /**
   * In-run high mark, as a share of the input budget (window minus output
   * reserve). The whole prompt is measured, not one part of it: below the
   * mark nothing leaves and the prompt only grows (a stable prefix the
   * provider can cache); past it one pass removes down to the low mark,
   * cheapest loss first (see `inRunMarks`).
   */
  inRunHighRatio: number;
  /** In-run low mark, as a share of the high mark: where a pass stops, so the next steps fit without another. */
  inRunLowShare: number;
  /**
   * Optional absolute ceiling on the in-run high mark. Unset, the mark
   * scales with the window (the window mode is the ceiling: `default` caps
   * the window at 260k, `model` opts in to the model's full size). Set it
   * when the provider does not cache prompts, so per-call cost is bounded.
   */
  inRunHighTokens?: number;
  /** Newest steps an in-run fold keeps in place (recap and residue folds). */
  inRunKeepToolResults: number;
  /** Iterations a loaded skill body stays in full before it becomes a skill card. */
  skillResidentIterations: number;
  /**
   * Tokens of findings the harness card shows (newest first). The card is
   * sent on every call, so it is part of the window like any other item.
   * A record that does not fit is stored whole as a blob; the card shows
   * the newest findings, a per-topic count for the rest and the sha.
   */
  recordCardTokens: number;
};

/**
 * Which window a thread budgets against. `default` caps at 260k (or the
 * model's size when smaller); `model` uses the model's full reported size.
 */
export type ContextWindowMode = 'default' | 'model';

/**
 * Provenance of ContextReport.budget.windowTokens (host sets after assemble).
 * `served`: a local daemon runs the model with a smaller context than the
 * chosen window, so the window was clamped to what is actually served.
 */
export type ContextWindowSource = 'default' | 'model' | 'fallback' | 'served';

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 260_000;

/**
 * Smallest window a run starts on. Below it the system prompt, tool schemas
 * and one real file read leave too little room for the conversation, so the
 * host refuses the send with a clear message instead of running degraded.
 */
export const MIN_CONTEXT_WINDOW_TOKENS = 32_000;

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  windowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
  outputReserveTokens: 20_000,
  compactAtRatio: 0.65,
  compactAtTokens: 100_000,
  /** ~16k chars; cards are small, slices max 8k — keep recent research readable. */
  toolResultMaxTokens: 4_000,
  keepToolResultsForTurns: 2,
  keepAttachmentsForTurns: 2,
  compactToRatio: 0.25,
  compactToTokens: 50_000,
  carryOverToolTokens: 40_000,
  inRunHighRatio: 0.8,
  inRunLowShare: 0.7,
  inRunKeepToolResults: 4,
  skillResidentIterations: 4,
  /** ~24k chars: about 200 typical (~120-char) findings. */
  recordCardTokens: 6_000,
};

export function parseContextWindowMode(value: unknown): ContextWindowMode | undefined {
  return value === 'default' || value === 'model' ? value : undefined;
}

/**
 * The window a run budgets against. `modelMax` is the provider-reported
 * context length (null when /api/show failed → 260k fallback). `servedMax`
 * is the context a local daemon actually loaded the model with: the
 * OpenAI-compatible endpoint cannot ask for a size, and a prompt past the
 * served size is cut from the front without an error, so it caps the window.
 */
export function resolveContextWindow(input: {
  mode?: ContextWindowMode;
  modelMax: number | null;
  servedMax?: number | null;
}): { windowTokens: number; source: ContextWindowSource } {
  const chosen = chooseContextWindow(input.mode, input.modelMax);
  const served = input.servedMax ?? 0;
  return served > 0 && served < chosen.windowTokens
    ? { windowTokens: served, source: 'served' }
    : chosen;
}

function chooseContextWindow(
  mode: ContextWindowMode | undefined,
  modelMax: number | null,
): { windowTokens: number; source: ContextWindowSource } {
  if (!modelMax || modelMax <= 0) {
    return { windowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'fallback' };
  }
  if (mode === 'model') {
    return { windowTokens: modelMax, source: 'model' };
  }
  return {
    windowTokens: Math.min(DEFAULT_CONTEXT_WINDOW_TOKENS, modelMax),
    source: 'default',
  };
}

/** Budget for a resolved window. Absolute knobs stay below a share of the input budget. */
export function contextBudgetForWindow(
  windowTokens: number,
  base: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): ContextBudget {
  const input = Math.max(1, windowTokens - base.outputReserveTokens);
  return {
    ...base,
    windowTokens,
    carryOverToolTokens: Math.min(base.carryOverToolTokens, Math.floor(input * 0.2)),
    recordCardTokens: Math.min(base.recordCardTokens, Math.floor(input * 0.05)),
  };
}

/**
 * The in-run marks in tokens, on the whole prompt. `high`: past it, one pass
 * removes down to `low`. Derived from the window alone (P2), unless
 * `inRunHighTokens` sets an absolute ceiling.
 */
export function inRunMarks(budget: ContextBudget): { high: number; low: number } {
  const input = Math.max(1, budget.windowTokens - budget.outputReserveTokens);
  const high = Math.min(input * budget.inRunHighRatio, budget.inRunHighTokens ?? Number.POSITIVE_INFINITY);
  return { high, low: high * budget.inRunLowShare };
}

/** Tokens a request may hold: the window minus the output reserve. */
export function inputBudgetTokens(budget: ContextBudget): number {
  return Math.max(1, budget.windowTokens - budget.outputReserveTokens);
}

/**
 * Share of the input budget past which one turn's results stop joining the
 * prompt (flags.windowGuard). Above the in-run high mark (0.8), so it only
 * acts where residency cannot keep up: one turn that alone fills the window.
 */
const WINDOW_GUARD_SHARE = 0.9;

/** The window guard in tokens (flags.windowGuard). */
export function windowGuardTokens(budget: ContextBudget): number {
  return inputBudgetTokens(budget) * WINDOW_GUARD_SHARE;
}

/** Share of the in-run low mark a run may start at, so a run starts with room before its first pass. */
const START_BELOW_LOW = 0.9;

/**
 * Between-run compaction marks in tokens: compact when the prompt is over
 * `at`, down to `to`. Each is the lower of its window share and its absolute
 * figure, so a small window keeps its ratio and a large one stops at the
 * absolute mark. `at` also stays under the in-run low mark: a run that starts
 * above it would pass the high mark on its first steps and fold every step.
 */
export function compactionMarks(budget: ContextBudget): { at: number; to: number } {
  const input = Math.max(1, budget.windowTokens - budget.outputReserveTokens);
  return {
    at: Math.min(input * budget.compactAtRatio, budget.compactAtTokens, inRunMarks(budget).low * START_BELOW_LOW),
    to: Math.min(input * budget.compactToRatio, budget.compactToTokens),
  };
}

/** Per-layer sizes returned with an assembled prompt for the context meter. */
export type ContextReportLayer = {
  id: string;
  label: string;
  tokens: number;
};

export type ContextReport = {
  budget: ContextBudget;
  layers: ContextReportLayer[];
  /** Sum of layer tokens (excludes output reserve). */
  occupiedTokens: number;
  stubbedToolResults: number;
  needsCompaction: boolean;
  /** `/` picks pinned as core + contents because the pinned total passed its cap. */
  trimmedSkills?: string[];
  /**
   * Where budget.windowTokens came from for this assembly.
   * Hosts set this after assembleContext; refresh preserves it.
   */
  windowSource?: ContextWindowSource;
};

/**
 * Derived compacted window + thread brief. Regenerable; not authoritative history.
 * Full movie remains the ledger. Written in M4; M2 assembler accepts null.
 */
export type Snapshot = {
  threadId: string;
  /** Ledger seq this snapshot covers through (inclusive). */
  throughSeq: number;
  model: string;
  /** Prompt / assembler version for eval diffs. */
  promptVersion?: string;
  /** Short screenplay for the thread (goal, decisions, open questions). */
  brief: string;
  /** Compacted older turns summary kept in the model window. */
  summary: string;
  /**
   * Blob of the full text of every turn this snapshot covers (messages,
   * tool calls, tool results or their blob shas), so a compacted turn is
   * restorable with `recall` instead of lost (v2 phase 6). Absent on
   * snapshots written before it.
   */
  transcriptSha?: string;
  createdAt: string;
};

/** Parse a snapshot from persisted JSON. Rejects malformed files. */
export function parseSnapshot(raw: unknown): Snapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.threadId !== 'string') return null;
  if (typeof r.throughSeq !== 'number' || !Number.isInteger(r.throughSeq) || r.throughSeq < 0) {
    return null;
  }
  if (typeof r.model !== 'string') return null;
  if (typeof r.brief !== 'string') return null;
  if (typeof r.summary !== 'string') return null;
  if (typeof r.createdAt !== 'string') return null;
  return {
    threadId: r.threadId,
    throughSeq: r.throughSeq,
    model: r.model,
    brief: r.brief,
    summary: r.summary,
    createdAt: r.createdAt,
    ...(typeof r.promptVersion === 'string' ? { promptVersion: r.promptVersion } : {}),
    ...(typeof r.transcriptSha === 'string' && /^[a-f0-9]{64}$/.test(r.transcriptSha)
      ? { transcriptSha: r.transcriptSha }
      : {}),
  };
}
