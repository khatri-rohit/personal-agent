/**
 * The code a host runs, read once when it starts: the commit and a hash of
 * uncommitted changes (null when clean). Recorded on `run_start`, so an eval
 * attributes a trace to the code that produced it, not to the repo's state
 * when the eval was read.
 */
export type HarnessVersion = { sha: string; dirty: string | null };

/**
 * Harness behaviour switches, one per component that changes what the model
 * sees. Resolved once by the host when a run starts, recorded on the run's
 * `run_start` trace, and never flipped mid-run, so an eval can tell which
 * behaviour produced a trace.
 */
export type HarnessFlags = {
  /** Old tool results become one-line outcome cards instead of bare stubs. */
  outcomeCards: boolean;
  /**
   * One leading system message (identity, tools, skills index, memory,
   * rules, brief); per-send context (plan, picks, mentions, last run,
   * situation) rides in the current user turn instead of mid-history
   * system messages, which many open-model chat templates mishandle.
   */
  promptTiers: boolean;
  /** Loop-control notes the harness adds as `user` rows say they come from the harness. */
  harnessNotes: boolean;
  /**
   * Home gets a short identity and compact tool guidance; the long house
   * style is the optional ai-writing-guidelines pack (repo skills/). A voice change: off
   * until reviewed.
   */
  compactHomePrompt: boolean;
  /**
   * Each send carries a deterministic situation card (the previous answer's
   * lead next to the new message) and a harness evidence log (edits,
   * commands, failures) that survives compaction.
   */
  situationCard: boolean;
  /**
   * After a tool error or a harness steering note, the run uses one
   * reasoning rung above the baseline until its next evidence (an edit, a
   * passing check, a finding, a sub-agent report), then steps back down.
   */
  effortEscalation: boolean;
  /**
   * An Agent run that edited files and then claims success without running
   * a command since its last edit is sent back once to verify.
   */
  stopCheck: boolean;
  /** Between-run compaction asks a side model for a sectioned summary; the extractive one is the fallback. */
  sectionedSummary: boolean;
  /** After a thread goes idle, a side model proposes memory updates, staged for the user's approval. */
  learningLoop: boolean;
  /**
   * One ephemeral harness card (task state, budget, advice) is appended to
   * each model call instead of appending notes to tool results and the
   * prompt. Off = the earlier notes, for A/B.
   */
  stateCard: boolean;
  /*
   * Context and sub-agent behaviour switches. Off until each one's own
   * eval passes with the others off.
   */
  /**
   * An earlier turn's tool rows keep the same per-tool cap they had
   * inside the run (`liveResultCapChars`), a cut lands on a line boundary,
   * and its footer names the ledger blob's sha for `recall`.
   */
  carryWholeReads: boolean;
  /**
   * A turn's results stop joining the prompt past the window guard
   * share of the input budget (they become evicted cards with a sha), and a
   * prompt still over the input budget is reshaped before it is sent.
   */
  windowGuard: boolean;
  /**
   * A sub-agent report is partial only when the child hit a limit,
   * sent no report, or said partial itself; open questions no longer make
   * it partial. Header and body show the same status.
   */
  childStatusAtLimit: boolean;
  /**
   * A brief whose paths overlap a running sub-agent's starts anyway,
   * and every brief names the sub-agents running at the same time instead
   * of being refused.
   */
  siblingBriefs: boolean;
  /**
   * A resumed sub-agent whose replayed history is over the
   * compaction mark gets its older tool results as evicted cards before
   * its first call.
   */
  resumeBudget: boolean;
};

export const DEFAULT_HARNESS_FLAGS: HarnessFlags = {
  outcomeCards: true,
  promptTiers: true,
  harnessNotes: true,
  compactHomePrompt: false,
  situationCard: true,
  effortEscalation: true,
  stopCheck: true,
  sectionedSummary: true,
  learningLoop: true,
  stateCard: true,
  carryWholeReads: false,
  windowGuard: false,
  childStatusAtLimit: false,
  siblingBriefs: false,
  resumeBudget: false,
};

const FLAG_NAMES = Object.keys(DEFAULT_HARNESS_FLAGS) as Array<keyof HarnessFlags>;

function isFlagName(name: string): name is keyof HarnessFlags {
  return (FLAG_NAMES as string[]).includes(name);
}

/**
 * Parse `name:on,name:off` (e.g. the host's AGENT_FLAGS env). Unknown names
 * and values are ignored; missing names keep their default.
 */
export function parseHarnessFlags(raw: string | undefined): HarnessFlags {
  const flags: HarnessFlags = { ...DEFAULT_HARNESS_FLAGS };
  for (const part of (raw ?? '').split(',')) {
    const [name = '', value] = part.split(':').map((piece) => piece.trim());
    if (!isFlagName(name)) continue;
    if (value === 'on') flags[name] = true;
    if (value === 'off') flags[name] = false;
  }
  return flags;
}
