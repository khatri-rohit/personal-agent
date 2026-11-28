import type { ToolStage } from '@agent/agent-models';

import { pathFromToolArgs } from '../loop/call-identity';
import type { Tool } from './types';

/**
 * How the harness treats a tool's calls: what the task state counts them as
 * (evidence, the working set, the done check) and how long their results
 * stay in the prompt. A tool declares these (`Tool.traits`); the task state
 * and the working set read them, so adding a tool does not mean editing the
 * core, and a tool that declares nothing gets the generic treatment.
 *
 * The built-in tools' traits are the table at the end of this file. It is
 * also what a reader without a registry falls back to (tests, a trace read
 * offline), by tool name.
 */

/** What a call does for the task. */
export type ToolEffect =
  /** Looks at something (a file, a search, the web). */
  | 'read'
  /** Changes the workspace: counts as an edit, and needs a check after it. */
  | 'change'
  /** Runs something; a call that `isCheck` verifies the edits before it. */
  | 'command'
  /** Records a finding (the task record). */
  | 'record'
  /** Hands work to a sub-agent; its report cost a whole run. */
  | 'subagent';

export type ToolArgs = Record<string, unknown>;

export type ToolTraits = {
  effect?: ToolEffect;
  /** The workspace file a call is about (canonical path), or null. */
  file?: (args: ToolArgs) => string | null;
  /** `command` tools: this call is a project check (build, typecheck, test, lint). */
  isCheck?: (args: ToolArgs) => boolean;
  /**
   * What identifies the call for "the same thing again": a later result with
   * the same key replaces this one in the prompt (the same command re-run,
   * the same file's diff taken again). For a `command` it is also the text
   * the task state records.
   */
  repeatKey?: (args: ToolArgs) => string | null;
  /** With `repeatKey`: the result is from a call that ran (a refused or blocked call replaces nothing). Default: it ran. */
  ran?: (result: string) => boolean;
  /**
   * The lines of the file a result shows, for tools that return a window of
   * a file's own content. A later window that covers this one replaces it,
   * and only these results count as the file being read.
   */
  lineRange?: (result: string) => { from: number; to: number; of?: number } | null;
  /**
   * How results leave the prompt. By default a result stays until the whole
   * prompt passes the in-run high mark, then leaves in value order (other
   * results, then file views, then files read back), or when superseded.
   * - `never`: live state (the plan, todos, a loaded skill) or a sub-agent
   *   report; the working set does not remove them.
   * - `no_aging`: material under judgement (a diff). Past the mark it leaves
   *   after other results and file views read once; or when the same call
   *   is made again.
   */
  residency?: 'never' | 'no_aging';
  /**
   * `workspace`: the result changes only when the workspace does (a file
   * read, a search). An identical call is answered with a pointer to the
   * result already in the prompt, and a successful change makes it a fresh
   * call again.
   */
  dependsOn?: 'workspace';
  /** The stored result a call brings back (its sha256), for a tool that restores removed results. */
  restores?: (args: ToolArgs) => string | null;
};

export type TraitsOf = (toolName: string) => ToolTraits | undefined;

/** Tool call arguments as an object; anything else reads as no arguments. */
export function toolArgs(args: unknown): ToolArgs {
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as ToolArgs) : {};
}

function text(args: ToolArgs, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Words that make a command a project check. */
const CHECK_RE =
  /\b(test|tests|typecheck|type-check|tsc|lint|eslint|build|compile|check|vet|clippy|vitest|jest|pytest|mocha)\b/i;
/** Commands that only look around, whatever their arguments contain. */
const LOOK_ONLY_RE = /^(ls|dir|cat|type|head|tail|echo|pwd|cd|find|git|which|where|tree)\b/i;

/**
 * A project check: build, typecheck, test, lint or compile. Only a check
 * that ran verifies edits; `git status` or `nx show project` do not.
 * Heuristic by design (word match on the command), kept in one place.
 */
export function isCheckCommand(command: string): boolean {
  return namesCheck(command) && !exitCodeMasked(command.trim());
}

/** The command names a check (build, test, …), whether or not its exit code can be trusted. */
export function namesCheck(command: string): boolean {
  const trimmed = command.trim();
  return trimmed.length > 0 && !LOOK_ONLY_RE.test(trimmed) && CHECK_RE.test(trimmed);
}

/** Appended to a check whose exit code is masked, so the model knows why it did not count. */
export const MASKED_CHECK_NOTE =
  '(note) This does not count as a check: `||`, `;`, `&` or `|` can hide the check\'s own exit code. Run the check command on its own.';

/** Redirections whose `&` is not a command separator: `2>&1`, `>&2`, `&>`, `&>>`. */
const AMPERSAND_REDIRECT_RE = /\d*>&\d*|&>>?/g;

/**
 * The command's exit code may not be the check's: `npm test || echo FAIL`
 * exits 0 on a failing test, as do `npm test; echo done`, cmd's
 * `npm test & echo done` and a pipe into another command (the pipe's exit is
 * the last command's in cmd and /bin/sh). Such a command is not a check, so
 * its edits stay unchecked and the card keeps asking for the plain command.
 * `&&` is fine: it stops at the first failure and exits with its code.
 * Quoted text is ignored (`--grep "a|b"`).
 */
export function exitCodeMasked(command: string): boolean {
  const unquoted = command.replace(/"[^"]*"|'[^']*'/g, '""').replace(AMPERSAND_REDIRECT_RE, ' ');
  return /\|\||;|\|/.test(unquoted) || /(^|[^&])&([^&]|$)/.test(unquoted);
}

/** The window a file read shows, from its `[lines a–b of N]` header. */
export function fileLineRange(result: string): { from: number; to: number; of?: number } | null {
  const match = /^\[lines (\d+)–(\d+) of (\d+)/.exec(result);
  return match ? { from: Number(match[1]), to: Number(match[2]), of: Number(match[3]) } : null;
}

/** A terminal result from a command that executed: `cwd: …` then `exit <n>` or `signal <name>`. */
export function terminalRan(result: string): boolean {
  const [first = '', second = ''] = result.split('\n', 2);
  return first.startsWith('cwd:') && /^(exit|signal) /.test(second.trim());
}

const READ: ToolTraits = { effect: 'read' };
const SEARCH: ToolTraits = { effect: 'read', dependsOn: 'workspace' };
const LIVE_STATE: ToolTraits = { residency: 'never' };

/** Traits of the built-in tools, by name. */
const BUILTIN_TOOL_TRAITS: Record<string, ToolTraits> = {
  read_file: { effect: 'read', file: pathFromToolArgs, lineRange: fileLineRange, dependsOn: 'workspace' },
  grep: SEARCH,
  glob: SEARCH,
  web_search: READ,
  web_fetch: READ,
  session_search: READ,
  // The same page of the same thread read again replaces the earlier copy.
  read_thread: {
    effect: 'read',
    repeatKey: (args) => {
      const id = text(args, 'thread_id');
      return id ? `${id}|${String(args.from ?? 1)}|${String(args.part ?? 1)}` : null;
    },
    ran: (result) => !result.startsWith('Error:'),
  },
  recall: {
    effect: 'read',
    restores: (args) => text(args, 'sha256').toLowerCase() || null,
  },
  // A diff is what a review judges and what an edit is checked against: past
  // the high mark it leaves late, and a later diff of the same file (or of
  // the whole tree) replaces it.
  diff: {
    effect: 'read',
    file: (args) => pathFromToolArgs(args),
    repeatKey: (args) => pathFromToolArgs(args) ?? '*',
    residency: 'no_aging',
  },
  edit_file: { effect: 'change', file: pathFromToolArgs },
  run_terminal: {
    effect: 'command',
    isCheck: (args) => isCheckCommand(text(args, 'command')),
    repeatKey: (args) => text(args, 'command') || null,
    ran: terminalRan,
  },
  record_finding: { effect: 'record' },
  delegate: { effect: 'subagent', residency: 'never' },
  plan: LIVE_STATE,
  todo: LIVE_STATE,
  load_skill: LIVE_STATE,
};

/** The built-in traits for a tool name; undefined for a tool the harness does not ship. */
export function builtinToolTraits(toolName: string): ToolTraits | undefined {
  return Object.hasOwn(BUILTIN_TOOL_TRAITS, toolName) ? BUILTIN_TOOL_TRAITS[toolName] : undefined;
}

/** Names the built-in table covers (for the contract test). */
export function builtinTraitNames(): string[] {
  return Object.keys(BUILTIN_TOOL_TRAITS);
}

/**
 * Traits for the tools of one run: what a tool declares on itself wins, then
 * the built-in table. `declared` is the run's registry lookup.
 */
export function traitsResolver(declared: (toolName: string) => ToolTraits | undefined): TraitsOf {
  return (toolName) => declared(toolName) ?? builtinToolTraits(toolName);
}

/** What a run can do, from what its tools declare (not from their names). */
export type RunCapabilities = {
  /** A tool changes the workspace. */
  edit: boolean;
  /** A tool runs commands, so edits can be checked. */
  check: boolean;
  /** A tool records findings. */
  record: boolean;
  /** A tool hands work to a sub-agent. */
  delegate: boolean;
};

export function runCapabilities(toolNames: Iterable<string>, traitsOf: TraitsOf): RunCapabilities {
  const effects = new Set([...toolNames].map((name) => traitsOf(name)?.effect));
  return {
    edit: effects.has('change'),
    check: effects.has('command'),
    record: effects.has('record'),
    delegate: effects.has('subagent'),
  };
}

/** A tool without a declared stage (e.g. a future MCP tool) is scheduled as mutate, the strictest class. */
export function toolStage(tool: Pick<Tool, 'stage'>): ToolStage {
  return tool.stage ?? 'mutate';
}
