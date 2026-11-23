import type { ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';

import {
  GUARD_LIMITS,
  isAskStrippedTool,
  isReadOnlyPosture,
  limitMessage,
  REPORT_MAX_CHARS,
  type RunPosture,
  type TraceEvent,
} from '@agent/agent-models';

import { EVIDENCE_WORDS, readStormAction, repeatAction, reportOnlyCall } from '../policy';
import { toolStage, type TraitsOf } from '../tools/traits';
import type { Tool } from '../tools/types';
import { outcomeKey, toolCallKey } from './call-identity';
import type { ProgressSteering } from './progress-steering';

type PolicyInputs = Extract<TraceEvent, { type: 'policy_decision' }>['inputs'];

/** A guard decision the caller traces as a `policy_decision` of kind `guard`. */
export type GuardDecision = { ids: string[]; reason: string; inputs?: PolicyInputs };

/**
 * What to do with one tool call:
 * - `run`: execute it (the caller counts it against the tool-call limit).
 * - `answer`: write `text` as its tool row instead of running it; the run
 *   goes on. `decision` / `gated` are what the caller traces for it.
 * - `halt`: end the run on `limit`. `refusal` is the call's row, written
 *   now; without one the caller skips the call. `repeat` halts get the
 *   repeat row when the turn finishes.
 */
export type Verdict =
  | { kind: 'run'; toolName: string; tool: Tool; args: Record<string, unknown> }
  | {
      kind: 'answer';
      text: string;
      decision?: GuardDecision;
      /** Web research is closed: traced as `research_gate` (once per closing). */
      gated?: { toolName: string; idleTokens: number };
      /** Refused because only the reserved `report` call is left. */
      reportOnly?: true;
    }
  | { kind: 'halt'; reason: 'limit' | 'repeat'; limit: string; refusal?: string };

/** What admission reads from the run when a call arrives. */
export type AdmissionRun = {
  readonly byName: ReadonlyMap<string, Tool>;
  readonly posture: RunPosture;
  /** Calls run so far; refusals do not count. */
  readonly toolCalls: number;
  readonly maxPromptTokens: number | undefined;
  readonly canDelegate: boolean;
  readonly research: Pick<ProgressSteering, 'researchGated' | 'idleTokens' | 'noteGated'>;
  /** The tool's own admission check (`Tool.admit`) with the run's tool context. */
  toolAdmit(tool: Tool, args: Record<string, unknown>): string | null | undefined;
};

/** Answer to a read of one file past its per-path limit: points at what is already above or recallable. */
function readStormAnswered(path: string, limit: number): string {
  return `Not read again: ${path} was already read ${limit} times in this run with no edit to it since. Its latest content is above, or in an (evicted) card whose sha \`recall\` restores. Record what you need with record_finding, or read a different file.`;
}

/** Answer to a repeated read or fetch: points at the result already made. */
function repeatAnswered(earlier: number): string {
  return `Not run again: this exact call already ran ${earlier} time(s) in this run with the same arguments, and its result has not changed. Use the earlier result: it is above, or an (evicted) card whose sha \`recall\` restores. Ask something different if you need more.`;
}

/** Refusal once only the reserved `report` call is left in a sub-agent's budget. */
const REPORT_ONLY_REFUSAL =
  `Tool budget used: only \`report\` is available now. Call report with what you found (path:line evidence) and what is still open, in under ${REPORT_MAX_CHARS.toLocaleString('en-US')} characters.`;

/** Row for the call that tripped the repeat halt. */
export const REPEAT_BLOCKED = limitMessage(
  'limit.repeat',
  'This exact tool call has already been attempted multiple times. Do not repeat it.',
);

/**
 * Whether a tool call runs, is answered instead, or ends the run, and the
 * per-run memory those rules count from: invented tool names, paging one
 * file, the exact same call again, the exact same outcome again, the
 * report-only reserve, posture, the research gate and the tool-call limit.
 * Each rule lives here once (its count, its decision, its wording); the
 * pure thresholds are policy/guards. The caller applies a verdict and owns
 * no rule. How many commands a run makes is not a sign of a loop (a
 * migration runs many builds): the tool-call, token and wall limits bound it.
 */
export class Admission {
  private unknownToolStreak = 0;
  /** Reads asked for per path (answered or not). */
  private readonly readsByPath = new Map<string, number>();
  private readonly callCounts = new Map<string, number>();
  /** Call keys of tools whose result depends on the workspace (their traits say so). */
  private readonly workspaceReadKeys = new Set<string>();
  private readonly outcomeCounts = new Map<string, number>();
  /** Exec outcome keys, so a successful change can clear them (an edit between identical builds is progress). */
  private readonly execOutcomeKeys = new Set<string>();
  /** This turn so far: calls admitted to run, and report-only refusals. */
  private turnRan = 0;
  private turnReportOnly = 0;
  /** Consecutive turns whose calls were all refused because only `report` was left. */
  private reportOnlyTurns = 0;

  constructor(
    private readonly limits: {
      traitsOf: TraitsOf;
      maxToolCalls: number | undefined;
      maxRepeatedToolCalls: number;
    },
  ) {}

  admit(toolCall: ChatCompletionMessageToolCall, run: AdmissionRun): Verdict {
    const verdict = this.decide(toolCall, run);
    if (verdict.kind === 'run') this.turnRan += 1;
    if (verdict.kind === 'answer' && verdict.reportOnly) this.turnReportOnly += 1;
    return verdict;
  }

  private decide(toolCall: ChatCompletionMessageToolCall, run: AdmissionRun): Verdict {
    const { maxToolCalls, maxRepeatedToolCalls, traitsOf } = this.limits;
    // Refusals always get a tool row (I1) but do not burn maxToolCalls (D10).
    if (toolCall.type !== 'function') return { kind: 'answer', text: 'Unsupported tool call type.' };

    const toolName = toolCall.function.name;
    const tool = run.byName.get(toolName);
    if (!tool) {
      const text = `Tool "${toolName}" does not exist.`;
      // A valid tool breaks the streak (a lifetime total was ending runs early).
      this.unknownToolStreak += 1;
      if (this.unknownToolStreak < GUARD_LIMITS.unknownToolStreak) return { kind: 'answer', text };
      return {
        kind: 'halt',
        reason: 'limit',
        limit: limitMessage('limit.unknown', `unknown tool streak exceeded (${GUARD_LIMITS.unknownToolStreak})`),
        refusal: text,
      };
    }
    this.unknownToolStreak = 0;

    if (
      reportOnlyCall({ toolName, hasReport: run.byName.has('report'), maxToolCalls, used: run.toolCalls })
    ) {
      return {
        kind: 'answer',
        text: REPORT_ONLY_REFUSAL,
        reportOnly: true,
        decision: {
          ids: [`report_only:${toolName}`],
          reason: 'only the reserved report call is left',
          inputs: { toolCalls: run.toolCalls },
        },
      };
    }

    if (isReadOnlyPosture(run.posture) && isAskStrippedTool(toolName)) {
      return {
        kind: 'answer',
        text:
          run.posture === 'plan'
            ? 'Blocked: this run is Plan (read-only). Finish the plan; the user switches to Agent to carry it out.'
            : 'Blocked: this run is Ask (read-only). Switch the composer to Agent to edit files or run commands.',
      };
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      return { kind: 'answer', text: 'Invalid tool arguments. Expected valid JSON.' };
    }

    const refusal = run.toolAdmit(tool, args);
    if (refusal) return { kind: 'answer', text: refusal };

    // Research gate (policy/progress): past the gate mark with no new
    // evidence, the run's own web tools close until the next evidence. A
    // refusal row, not a halt: reads, edits and delegate(explore) still work.
    if (tool.research && run.research.researchGated()) {
      const idle = run.research.idleTokens();
      const delegate = run.canDelegate
        ? ' If one specific fact is still missing, delegate(explore) with that question.'
        : '';
      return {
        kind: 'answer',
        text: limitMessage(
          'limit.research',
          `Web research is paused for this run: ${Math.round((idle / run.maxPromptTokens!) * 100)}% of the budget went to steps with no new evidence (${EVIDENCE_WORDS}). It reopens after the next one. Use what you have.${delegate}`,
        ),
        ...(run.research.noteGated() ? { gated: { toolName, idleTokens: idle } } : {}),
      };
    }

    // Storm guard by what the tool is: paging one file's content. Past the
    // limit the read is answered, not run (P5); only a loop past twice the
    // limit stops the run.
    const traits = traitsOf(toolName);
    const readPath = traits?.lineRange ? (traits.file?.(args) ?? null) : null;
    if (readPath !== null) {
      const attempts = (this.readsByPath.get(readPath) ?? 0) + 1;
      this.readsByPath.set(readPath, attempts);
      const limit = GUARD_LIMITS.readsPerPath;
      const action = readStormAction({ attempts, limit });
      if (action === 'answer') {
        return {
          kind: 'answer',
          text: readStormAnswered(readPath, limit),
          decision: {
            ids: [`read_storm_answered:${toolName}`],
            reason: 'read of one file past the per-path limit',
            inputs: { path: readPath, reads: attempts - 1, limit },
          },
        };
      }
      if (action === 'halt') {
        return {
          kind: 'halt',
          reason: 'limit',
          limit: limitMessage('limit.read_storm', `read_file path storm blocked (${limit * 2} reads of one path)`),
        };
      }
    }

    if (maxToolCalls !== undefined && run.toolCalls >= maxToolCalls) {
      return { kind: 'halt', reason: 'limit', limit: limitMessage('limit.tools', `max tool calls exceeded (${maxToolCalls})`) };
    }

    // Exact repeats: run, answer from earlier, or halt (policy/guards repeatAction).
    const key = toolCallKey(toolName, args);
    const count = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, count);
    // A workspace-dependent result is fresh again after a change (`settled`).
    if (traits?.dependsOn === 'workspace') this.workspaceReadKeys.add(key);
    const repeat = repeatAction({ count, limit: maxRepeatedToolCalls, stage: toolStage(tool) });
    if (repeat === 'answer') {
      return {
        kind: 'answer',
        text: repeatAnswered(count - 1),
        decision: {
          ids: [`repeat_answered:${toolName}`],
          reason: 'identical call past the repeat limit',
          inputs: { repeats: count - 1, limit: maxRepeatedToolCalls },
        },
      };
    }
    if (repeat === 'halt') {
      return { kind: 'halt', reason: 'repeat', limit: limitMessage('limit.repeat', `repeated tool call blocked: ${toolName}`) };
    }

    return { kind: 'run', toolName, tool, args };
  }

  /**
   * After a turn's calls were admitted. A child that keeps calling other
   * tools after the report-only refusal would spin until its iteration cap:
   * past `reportOnlyTurns` such turns, end it on the tool limit.
   */
  endTurn(halted: boolean): string | null {
    const onlyRefused = !halted && this.turnRan === 0 && this.turnReportOnly > 0;
    this.reportOnlyTurns = onlyRefused ? this.reportOnlyTurns + 1 : 0;
    this.turnRan = 0;
    this.turnReportOnly = 0;
    if (this.reportOnlyTurns < GUARD_LIMITS.reportOnlyTurns) return null;
    return limitMessage('limit.tools', `max tool calls exceeded (${this.limits.maxToolCalls})`);
  }

  /**
   * A call returned. Mutate and exec: the same call with the same result
   * again is stuck (write theater, or the same exit with no edit between);
   * `nearStuck` is the one before the limit. `changed`: the call changed the
   * workspace, so earlier exits and workspace reads are stale and the
   * changed file's read count starts again (a read of it must run).
   */
  settled(input: {
    toolName: string;
    tool: Tool;
    args: Record<string, unknown>;
    result: string;
    changed: boolean;
  }): { nearStuck: boolean; halt: string | null } {
    const { toolName, tool, args, result } = input;
    const stage = toolStage(tool);
    const traits = this.limits.traitsOf(toolName);
    const file = traits?.file?.(args) ?? null;
    if (stage === 'mutate' || stage === 'exec') {
      const key = outcomeKey(toolName, args, result, {
        ...(traits?.effect ? { effect: traits.effect } : {}),
        file,
      });
      const count = (this.outcomeCounts.get(key) ?? 0) + 1;
      this.outcomeCounts.set(key, count);
      if (stage === 'exec') this.execOutcomeKeys.add(key);
      if (count >= GUARD_LIMITS.identicalOutcomes) {
        return {
          nearStuck: false,
          halt: limitMessage('limit.outcome', `repeated identical tool outcome blocked: ${toolName}`),
        };
      }
      if (count === GUARD_LIMITS.identicalOutcomes - 1) return this.afterChange(input.changed, file, true);
    }
    return this.afterChange(input.changed, file, false);
  }

  private afterChange(changed: boolean, file: string | null, nearStuck: boolean): { nearStuck: boolean; halt: null } {
    if (changed) {
      if (file !== null) this.readsByPath.delete(file);
      for (const key of this.execOutcomeKeys) this.outcomeCounts.delete(key);
      this.execOutcomeKeys.clear();
      for (const key of this.workspaceReadKeys) this.callCounts.delete(key);
      this.workspaceReadKeys.clear();
    }
    return { nearStuck, halt: null };
  }

  /**
   * flags.windowGuard: a result that never reached the model (stored as a
   * window card) was not a use of the call. Asking for it again is not a
   * repeat, and a read of its file is not one more read of that path.
   */
  forgetDeferredCall(toolName: string, args: Record<string, unknown>): void {
    const key = toolCallKey(toolName, args);
    const count = this.callCounts.get(key);
    if (count !== undefined) {
      if (count <= 1) this.callCounts.delete(key);
      else this.callCounts.set(key, count - 1);
    }
    const traits = this.limits.traitsOf(toolName);
    const readPath = traits?.lineRange ? (traits.file?.(args) ?? null) : null;
    const reads = readPath === null ? undefined : this.readsByPath.get(readPath);
    if (readPath !== null && reads !== undefined) {
      if (reads <= 1) this.readsByPath.delete(readPath);
      else this.readsByPath.set(readPath, reads - 1);
    }
  }

  /** A retired skill body may be loaded again: that is not a repeat. */
  forgetSkillLoads(): void {
    for (const key of [...this.callCounts.keys()]) {
      if (key.startsWith('load_skill:')) this.callCounts.delete(key);
    }
  }
}
