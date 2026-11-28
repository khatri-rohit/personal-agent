import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type {
  ContextBudget,
  ContextReport,
  HarnessFlags,
  LedgerEnvelope,
  MemoryFiles,
  ModeName,
  RunPosture,
  Snapshot,
  ThreadLastRun,
  ThreadPlan,
} from '@agent/agent-models';
import {
  CHARS_PER_TOKEN,
  compactionMarks,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_HARNESS_FLAGS,
  envelopeToChatMessage,
  formatThreadPlanForPrompt,
  imageAttachments,
  isResumableStop,
  threadMentions,
  isThreadPlanEmpty,
} from '@agent/agent-models';

import { buildSystemPrompt } from '../prompts/system-prompt';
import {
  formatSkillsCatalog,
  isSkillBody,
  listSkills,
  skillAlreadyLoadedNote,
  skillLoadFromArgs,
  type SkillLoad,
} from '../tools/skills';
import type { ToolRegistry } from '../tools/types';
import { stubWebSourceCard } from '../tools/web/source';
import { hostListedWebUrls } from '../tools/web/trust';
import { liveResultCapChars } from '../tools/workspace/tools';
import { estimatePromptTokens } from '../model/estimate-prompt-tokens';
import {
  ATTACHMENTS_CLOSE,
  ATTACHMENTS_OPEN,
  HARNESS_CONTEXT_CLOSE,
  HARNESS_CONTEXT_OPEN,
} from './message-origin';
import { outcomeCard, toolCallIndex, type ToolCallInfo } from './outcome-card';
import { MIN_EVICT_CHARS } from './residency';
import { traitsResolver } from '../tools/traits';
import { buildEvidenceLog, buildSituationCard } from './situation';

export type AssembleContextInput = {
  tools: ToolRegistry;
  memory: MemoryFiles;
  snapshot: Snapshot | null;
  /** Hydrated ledger (blob bodies inlined). Assembler never reads disk. */
  envelopes: LedgerEnvelope[];
  /** Drives home vs workspace system-prompt behavior. */
  mode?: ModeName;
  /** Workspace Ask vs Agent; ignored for Home. Default agent. */
  posture?: RunPosture;
  /** Thread-scoped plan journal + todos. Injected when non-empty. */
  plan?: ThreadPlan | null;
  /** Prior run summary for resume; incomplete/cancelled inject a system note. */
  lastRun?: ThreadLastRun | null;
  /** Harness switches for this run. Defaults to DEFAULT_HARNESS_FLAGS. */
  flags?: HarnessFlags;
  /**
   * The task record earlier runs of this thread left (findings, open
   * questions), rendered by the host with prepareCarriedRecord. Goes in the
   * stable prefix after the conversation summary.
   */
  carriedRecord?: string | null;
};

/** Prompt-only fill for ledger orphans (pre-I1 / crash). Does not rewrite disk. */
const INTERRUPTED_TOOL_RESULT = 'Skipped: interrupted before result.';

function fillOrphanToolResults(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      answered.add(message.tool_call_id);
    }
  }
  const out: ChatCompletionMessageParam[] = [];
  for (const message of messages) {
    out.push(message);
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      if (answered.has(call.id)) continue;
      out.push({
        role: 'tool',
        tool_call_id: call.id,
        content: INTERRUPTED_TOOL_RESULT,
      });
      answered.add(call.id);
    }
  }
  return out;
}

function formatLastRunPrompt(lastRun: ThreadLastRun): string | null {
  if (!lastRun.incomplete && lastRun.status === 'completed') return null;
  const reason =
    lastRun.limitReason ??
    (lastRun.status === 'error'
      ? 'Run ended with an error'
      : 'Run stopped early');
  // Budget, wall-clock, iteration, tool and capacity stops leave a handoff
  // (or the plan) to continue from; re-exploring would re-spend the budget.
  const resumable = isResumableStop(reason);
  return [
    '# Last run',
    `The previous run on this thread ended early (status: ${lastRun.status}).`,
    `Reason: ${reason}`,
    ...(resumable
      ? [
          'If the user asks to continue: pick up from the last assistant message (the handoff) and the plan. Do not redo finished steps or repeat research already done.',
        ]
      : []),
    'Workspace files may have changed since any tool results below. Re-read before editing or relying on those results.',
  ].join('\n');
}

export type AssembleContextResult = {
  messages: ChatCompletionMessageParam[];
  report: ContextReport;
};

function charsToTokens(length: number): number {
  if (length <= 0) return 0;
  return Math.ceil(length / CHARS_PER_TOKEN);
}

function buildMemoryPrompt(memory: MemoryFiles): string {
  const user = memory.user.trim();
  const notes = memory.notes.trim();
  const parts: string[] = [];
  if (user) {
    parts.push(
      [
        '# User profile (USER.md)',
        'Durable facts. Adapt tone and working style. Do not recite unless asked.',
        'Do not invent a biography beyond this block.',
        '',
        user,
      ].join('\n'),
    );
  } else {
    parts.push(
      [
        '# User profile (USER.md)',
        'Empty. Do not invent a biography, job title, or preferences.',
      ].join('\n'),
    );
  }
  if (notes) {
    const notesTitle =
      memory.agentsMd || memory.project
        ? '# Workspace notes (this folder)'
        : '# Agent notes (MEMORY.md)';
    parts.push([notesTitle, notes].join('\n'));
  }
  return parts.join('\n\n');
}

function buildRulesPrompt(memory: MemoryFiles): string {
  const parts: string[] = [];
  const agents = memory.agentsMd?.trim() ?? '';
  const project = memory.project?.trim() ?? '';
  if (agents) {
    parts.push(['# Project instructions (AGENTS.md)', agents].join('\n'));
  }
  if (project) {
    parts.push(['# Project notes (PROJECT.md)', project].join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * The references a user message carries: the skills the user named (`/`
 * picks) and the threads they attached. Only names and ids: the model loads
 * a skill with load_skill and reads a thread with read_thread. Built from
 * the ledger row, so it never changes once sent. A mention of the thread
 * itself is skipped.
 */
function referencesBlock(envelope: LedgerEnvelope): string {
  const lines: string[] = [];
  for (const name of envelope.skills?.selected ?? []) lines.push(`- Skill: ${name}`);
  for (const mention of threadMentions(envelope.attachments)) {
    if (mention.threadId === envelope.threadId) continue;
    const source = mention.workspaceRoot ?? (mention.kind === 'workspace' ? 'Workspace' : 'Home');
    lines.push(`- Thread: "${mention.title}" (thread_id ${mention.threadId}, ${source})`);
  }
  if (lines.length === 0) return '';
  return [ATTACHMENTS_OPEN, ...lines, ATTACHMENTS_CLOSE].join('\n');
}

function toolCallsFromMessage(
  item: LedgerEnvelope | ChatCompletionMessageParam,
): ChatCompletionMessageToolCall[] | undefined {
  if ('record' in item) {
    return item.record.role === 'assistant' ? item.record.tool_calls : undefined;
  }
  return item.role === 'assistant' ? item.tool_calls : undefined;
}

function loadSkillCallIds(
  source: LedgerEnvelope[] | ChatCompletionMessageParam[],
): Set<string> {
  const ids = new Set<string>();
  for (const item of source) {
    const calls = toolCallsFromMessage(item);
    if (!calls) continue;
    for (const call of calls) {
      const name = 'function' in call ? call.function.name : undefined;
      if (name === 'load_skill') ids.add(call.id);
    }
  }
  return ids;
}

/** Tokens of load_skill results in the conversation. */
function loadSkillTokensFromMessages(
  messages: ChatCompletionMessageParam[],
): number {
  const ids = loadSkillCallIds(messages);
  if (ids.size === 0) return 0;
  let chars = 0;
  for (const message of messages) {
    if (message.role !== 'tool' || !ids.has(message.tool_call_id)) continue;
    chars += String(message.content ?? '').length;
  }
  return charsToTokens(chars);
}

const PREFIX_LAYER_IDS = new Set([
  'system',
  'tools',
  'skills_catalog',
  'memory',
  'rules',
  'plan',
  'brief',
  'record',
  'last_run',
  'situation',
]);

/**
 * Rebuild conversation / loaded-skill layers after a model turn.
 * Prefix layer sizes stay the assemble-time estimates; occupied follows
 * provider promptTokens when present.
 */
export function refreshContextReport(
  report: ContextReport,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  usage?: { promptTokens: number },
): ContextReport {
  const prefix = report.layers.filter((layer) =>
    PREFIX_LAYER_IDS.has(layer.id),
  );
  const prefixSum = prefix.reduce((sum, layer) => sum + layer.tokens, 0);
  const skillsLoaded = loadSkillTokensFromMessages(messages);
  const occupied =
    usage?.promptTokens ?? layerTokens(messages, tools.definitions);
  const conversation = Math.max(0, occupied - prefixSum - skillsLoaded);
  const layers = [
    ...prefix,
    { id: 'conversation', label: 'Conversation', tokens: conversation },
    { id: 'skills_loaded', label: 'Loaded skills', tokens: skillsLoaded },
  ];
  return {
    ...report,
    layers,
    occupiedTokens: occupied,
    needsCompaction: occupied > compactionMarks(report.budget).at,
  };
}

function userSeqs(envelopes: LedgerEnvelope[]): number[] {
  return envelopes
    .filter((envelope) => envelope.record.role === 'user')
    .map((envelope) => envelope.seq);
}

function stubToolContent(
  envelope: LedgerEnvelope,
  info: ToolCallInfo | undefined,
  outcomeCards: boolean,
): string {
  if (envelope.record.role !== 'tool') return '';
  const card = stubWebSourceCard(
    envelope.record.content,
    envelope.record.tool_call_id,
  );
  if (card) return card;
  const listed = hostListedWebUrls(envelope.record.content);
  const urlTail =
    listed.length > 0
      ? `\n${listed.map((url) => `URL: ${url}`).join('\n')}`
      : '';
  if (outcomeCards) {
    return outcomeCard({
      toolCallId: envelope.record.tool_call_id,
      info,
      content: envelope.record.content,
      ...(envelope.contentBlob ? { blobSha: envelope.contentBlob } : {}),
      tail: urlTail,
    });
  }
  if (envelope.contentBlob) {
    return `(stub) tool ${envelope.record.tool_call_id} full result in blob sha256:${envelope.contentBlob}${urlTail}`;
  }
  const n = envelope.record.content.length;
  return `(stub) tool ${envelope.record.tool_call_id} omitted (${n} chars)${urlTail}`;
}

/**
 * Recent oversized tool rows keep a prefix (and host-listed URLs) so research
 * can continue. Silent "omitted" is only for old turns.
 */
export function capRecentToolContent(
  content: string,
  maxChars: number,
  /**
   * flags.carryWholeReads: cut at the last line break that fits (a cut
   * mid-line reads as a line of the file), and name the stored full result
   * by its sha so `recall` can bring it back.
   */
  options: { lineBoundary?: boolean; blobSha?: string } = {},
): string {
  if (content.length <= maxChars) return content;
  const listed = hostListedWebUrls(content);
  const listing =
    listed.length > 0
      ? `${listed.map((url) => `URL: ${url}`).join('\n')}\n\n`
      : '';
  const footer = options.blobSha
    ? `\n\n(live prompt capped at ${maxChars} chars of ${content.length}; full result: recall sha256:${options.blobSha})`
    : `\n\n(live prompt capped at ${maxChars} chars; full tool result remains in the ledger)`;
  const budget = maxChars - listing.length - footer.length;
  const cutAt = (text: string, room: number): number => {
    if (!options.lineBoundary) return room;
    const lineEnd = text.lastIndexOf('\n', room);
    return lineEnd >= room / 2 ? lineEnd : room;
  };
  if (budget < 256) {
    const end = options.lineBoundary ? cutAt(content, Math.max(0, maxChars - footer.length)) : maxChars;
    return `${content.slice(0, end)}${footer}`;
  }
  return `${listing}${content.slice(0, cutAt(content, budget))}${footer}`;
}

/** 0 = keep all (not enough turns yet). Else seq/index of the first kept user turn. */
function keepFromNthLast(markers: number[], keepTurns: number): number {
  if (markers.length <= keepTurns) return 0;
  return markers[markers.length - keepTurns] ?? 0;
}

function stubbedImageNote(imageCount: number): string {
  const noun = imageCount === 1 ? 'attachment' : 'attachments';
  return `(stub) ${imageCount} image ${noun} omitted`;
}

function stubbedUserText(text: string, imageCount: number): string {
  const note = stubbedImageNote(imageCount);
  const trimmed = text.trim();
  return trimmed ? `${trimmed}\n${note}` : note;
}

function imagePartCount(
  content: ChatCompletionMessageParam['content'],
): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part.type === 'image_url').length;
}

/**
 * In-loop sibling of assembleContext stubbing. Mutates live Chat Completions
 * messages so a long tool turn does not keep every result at full size, and
 * so old vision parts drop the same way as assemble-time attachment stubs.
 * Ledger rows stay full; the next assembleContext pass stubs from seq.
 */
export function stubLiveToolResults(
  messages: ChatCompletionMessageParam[],
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
  /**
   * Index of the first message the running loop appended. Turns are counted
   * only before it: the loop's own nudges are `role: 'user'` but are not user
   * turns, and current-run results shrink only through eviction (which keeps
   * a sha). Omitted at assemble time, where every message is from the ledger.
   */
  liveFrom: number = messages.length,
  flags: HarnessFlags = DEFAULT_HARNESS_FLAGS,
  /**
   * Told each tool result this replaced, so whatever tracks what is still in
   * the prompt (the loop's read dedupe) stops pointing at it.
   */
  onStubbed?: (toolCallId: string) => void,
): number {
  const maxToolChars = budget.toolResultMaxTokens * CHARS_PER_TOKEN;
  let callInfo: Map<string, ToolCallInfo> | null = null;
  const userIndexes: number[] = [];
  for (let i = 0; i < Math.min(liveFrom, messages.length); i++) {
    if (messages[i]?.role === 'user') userIndexes.push(i);
  }
  const keepToolsFrom = keepFromNthLast(
    userIndexes,
    budget.keepToolResultsForTurns,
  );
  const keepImagesFrom = keepFromNthLast(
    userIndexes,
    budget.keepAttachmentsForTurns,
  );

  let stubbed = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === 'user' && i < keepImagesFrom) {
      const n = imagePartCount(message.content);
      if (n === 0) continue;
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text ?? '')
              .join('\n');
      messages[i] = { role: 'user', content: stubbedUserText(text, n) };
      continue;
    }
    if (message.role !== 'tool') continue;
    const content = typeof message.content === 'string' ? message.content : '';
    // Already a stub or a residency card (which carries the sha to recall).
    if (/^\((stub|evicted|skill card|unchanged)/.test(content)) continue;
    // A loaded skill is part of the conversation for the whole thread: never cut.
    callInfo ??= toolCallIndex(messages);
    if (callInfo.get(message.tool_call_id)?.name === 'load_skill') continue;
    const old = i < keepToolsFrom;
    // A tool that sizes its own window (read_file, grep) keeps that window in
    // the live prompt; only results past it are cut here.
    let cap = maxToolChars;
    if (!old && content.length > maxToolChars) {
      cap = liveResultCapChars(callInfo.get(message.tool_call_id)?.name, maxToolChars);
    }
    const overCap = content.length > cap;
    if (!old && !overCap) continue;
    if (old) {
      const card = stubWebSourceCard(content, message.tool_call_id);
      let stub = card;
      if (!stub && flags.outcomeCards) {
        callInfo ??= toolCallIndex(messages);
        stub = outcomeCard({
          toolCallId: message.tool_call_id,
          info: callInfo.get(message.tool_call_id),
          content,
        });
      }
      messages[i] = {
        role: 'tool',
        tool_call_id: message.tool_call_id,
        content:
          stub ??
          `(stub) tool ${message.tool_call_id} omitted (${content.length} chars)`,
      };
    } else {
      messages[i] = {
        role: 'tool',
        tool_call_id: message.tool_call_id,
        content: capRecentToolContent(content, cap),
      };
    }
    onStubbed?.(message.tool_call_id);
    stubbed++;
  }
  return stubbed;
}

function withLeadingText(
  content: ChatCompletionMessageParam['content'],
  lead: string,
): ChatCompletionMessageParam['content'] {
  if (!lead) return content;
  if (typeof content === 'string') return content ? `${lead}\n\n${content}` : lead;
  return [{ type: 'text', text: lead }, ...(content ?? [])] as ChatCompletionMessageParam['content'];
}

function toParam(
  envelope: LedgerEnvelope,
  stubContent: string | null,
  stubImages: boolean,
  /** The user message's references block (named skills, attached threads), or ''. */
  attachments = '',
): ChatCompletionMessageParam | null {
  if (stubContent !== null && envelope.record.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: envelope.record.tool_call_id,
      content: stubContent,
    };
  }
  if (stubImages && envelope.record.role === 'user') {
    const n = imageAttachments(envelope.attachments).length;
    if (n > 0) {
      return {
        role: 'user',
        content: withLeadingText(stubbedUserText(envelope.record.content, n), attachments),
      } as ChatCompletionMessageParam;
    }
  }
  const chat = envelopeToChatMessage(envelope);
  if (!chat) return null;
  if (chat.role === 'user') {
    return { role: 'user', content: withLeadingText(chat.content, attachments) } as ChatCompletionMessageParam;
  }
  if (chat.role === 'assistant') {
    return {
      role: 'assistant',
      content: chat.content,
      ...(chat.tool_calls?.length ? { tool_calls: chat.tool_calls } : {}),
    };
  }
  if (chat.role !== 'tool') return null;
  return {
    role: 'tool',
    tool_call_id: chat.tool_call_id,
    content: chat.content,
  };
}

// Who wrote a user-role message, and the user's own words of one, live in
// message-origin.ts; re-exported for the callers that already import it here.
export { currentUserRequest } from './message-origin';

/**
 * Put per-send context at the top of the current user message. Assembly-time
 * only: the ledger keeps the user's words as sent, so an edit, retry or a
 * later turn never carries an old card. Null when the turn does not start
 * with a user message (the caller keeps system-message placement).
 */
function withHarnessContext(
  turn: ChatCompletionMessageParam[],
  blocks: string[],
): ChatCompletionMessageParam[] | null {
  if (blocks.length === 0) return turn;
  const first = turn[0];
  if (!first || first.role !== 'user') return null;
  const header = [HARNESS_CONTEXT_OPEN, ...blocks, HARNESS_CONTEXT_CLOSE].join('\n\n');
  const content: ChatCompletionMessageParam['content'] =
    typeof first.content === 'string'
      ? `${header}\n\n${first.content}`
      : [{ type: 'text', text: header }, ...first.content];
  return [{ role: 'user', content } as ChatCompletionMessageParam, ...turn.slice(1)];
}

/** A string argument value kept in full in an earlier turn's call; longer ones are cut. */
const EARLIER_ARG_VALUE_MAX_CHARS = 300;

/**
 * Earlier turns' tool calls with long string argument values cut, for the
 * calls `trim` picks. The arguments stay valid JSON with the same keys, so
 * the call still reads as what it was; a value that is not a string, or a
 * call that does not parse, is left as it is.
 */
function trimEarlierCallArguments(
  calls: ChatCompletionMessageToolCall[],
  trim: (call: { id: string; name: string }) => boolean,
): ChatCompletionMessageToolCall[] {
  return calls.map((call) => {
    if (call.type !== 'function' || call.function.arguments.length <= EARLIER_ARG_VALUE_MAX_CHARS) return call;
    if (!trim({ id: call.id, name: call.function.name })) return call;
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      return call;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return call;
    let cut = false;
    const shortened: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > EARLIER_ARG_VALUE_MAX_CHARS) {
        shortened[key] = `${value.slice(0, EARLIER_ARG_VALUE_MAX_CHARS)}… (${value.length.toLocaleString('en-US')} chars, cut in this earlier turn; the workspace or the result holds the rest)`;
        cut = true;
      } else {
        shortened[key] = value;
      }
    }
    return cut ? { ...call, function: { ...call.function, arguments: JSON.stringify(shortened) } } : call;
  });
}

function layerTokens(
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry['definitions'] = [],
): number {
  return estimatePromptTokens(messages, tools);
}

/**
 * What the compacted turns used that the model may need again: the skills
 * they loaded or named and the threads they attached, by name and id only.
 * The model loads or reads them again with its tools; skills the live part
 * still shows are left out. Computed from the ledger, so the same envelopes
 * give the same text.
 */
function compactedReferences(envelopes: LedgerEnvelope[], throughSeq: number): string | null {
  const liveSkills = new Set<string>();
  const foldedSkills: string[] = [];
  const threads: string[] = [];
  const seenThreads = new Set<string>();
  const loads = new Map<string, SkillLoad>();
  for (const envelope of envelopes) {
    const { record } = envelope;
    const folded = envelope.seq <= throughSeq;
    if (record.role === 'assistant') {
      for (const call of record.tool_calls ?? []) {
        if (call.type !== 'function' || call.function.name !== 'load_skill') continue;
        const load = skillLoadFromArgs(call.function.arguments);
        if (load && !load.file) loads.set(call.id, load);
      }
    } else if (record.role === 'tool') {
      const load = loads.get(record.tool_call_id);
      if (!load || !isSkillBody(record.content)) continue;
      if (folded) foldedSkills.push(load.name);
      else liveSkills.add(load.name.toLowerCase());
    } else if (record.role === 'user' && folded) {
      foldedSkills.push(...(envelope.skills?.selected ?? []));
      for (const mention of threadMentions(envelope.attachments)) {
        if (mention.threadId === envelope.threadId || seenThreads.has(mention.threadId)) continue;
        seenThreads.add(mention.threadId);
        threads.push(`"${mention.title}" (thread_id ${mention.threadId})`);
      }
    }
  }
  const skills: string[] = [];
  const seen = new Set<string>(liveSkills);
  for (let i = foldedSkills.length - 1; i >= 0; i--) {
    const name = foldedSkills[i]!;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    skills.push(name);
  }
  const lines: string[] = [];
  if (skills.length > 0) {
    lines.push(
      `Skills used in the compacted turns (their instructions are no longer above; load again with load_skill before relying on them): ${skills.join(', ')}`,
    );
  }
  if (threads.length > 0) {
    lines.push(`Threads attached in the compacted turns (read with read_thread): ${threads.join('; ')}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Pure assembler. Same envelopes + memory + snapshot → same messages.
 * Stubbing is free and deterministic; compaction is reported, not performed.
 * The ContextReport here is the measured “used” meter source after turns —
 * not a keystroke-hot estimate path (web must not spam assemble on typing).
 *
 * Cache contract: the returned messages are ordered stable-first (system,
 * memory, plan, mentions, brief) then volatile (tail, current turn). The
 * loop mutates this array in-place by appending tool results — it never
 * copies or reorders the prefix. Providers with prompt caching (OpenAI
 * automatic prefix cache, Ollama context reuse) can exploit this: the
 * frozen prefix is byte-stable across iterations within a run, so only the
 * growing tail is "new" work. The only per-run variance in the prefix is
 * `today()` in the system prompt, which is stable within a calendar day.
 */
export function assembleContext(
  input: AssembleContextInput,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): AssembleContextResult {
  const flags = input.flags ?? DEFAULT_HARNESS_FLAGS;
  const systemText = buildSystemPrompt(
    input.tools,
    input.mode,
    input.posture ?? 'agent',
    { compactHome: flags.compactHomePrompt, stateCard: flags.stateCard },
  );
  const systemMessage: ChatCompletionMessageParam = {
    role: 'system',
    content: systemText,
  };

  const hasLoadSkill = input.tools.byName.has('load_skill');
  const skillsText = hasLoadSkill ? formatSkillsCatalog(listSkills()) : '';
  const skillsMessage: ChatCompletionMessageParam | null = skillsText
    ? { role: 'system', content: skillsText }
    : null;
  const memoryText = buildMemoryPrompt(input.memory);
  const memoryMessage: ChatCompletionMessageParam = {
    role: 'system',
    content: memoryText,
  };

  const rulesText = buildRulesPrompt(input.memory);
  const rulesMessage: ChatCompletionMessageParam | null = rulesText
    ? { role: 'system', content: rulesText }
    : null;

  const plan = input.plan ?? null;
  const planText =
    plan && !isThreadPlanEmpty(plan) ? formatThreadPlanForPrompt(plan) : '';
  const planMessage: ChatCompletionMessageParam | null = planText
    ? { role: 'system', content: planText }
    : null;

  const afterSeq = input.snapshot?.throughSeq ?? 0;
  const live = input.envelopes.filter((envelope) => envelope.seq > afterSeq);

  const references = afterSeq > 0 ? compactedReferences(input.envelopes, afterSeq) : null;
  const briefParts: string[] = [];
  if (input.snapshot?.brief) {
    briefParts.push(`# Thread brief\n${input.snapshot.brief}`);
  }
  if (input.snapshot?.summary) {
    // The summary is lossy; the full folded turns are one recall away.
    const restore = input.snapshot.transcriptSha
      ? `\n(Full text of these turns, tool results included: recall sha256:${input.snapshot.transcriptSha})`
      : '';
    briefParts.push(`# Earlier turns (compacted)\n${input.snapshot.summary}${restore}`);
  }
  if (references) briefParts.push(references);
  // Conversation summary first, then the task record.
  const recordText = input.carriedRecord?.trim() ?? '';
  if (recordText) briefParts.push(recordText);
  const briefMessage: ChatCompletionMessageParam | null = briefParts.length
    ? { role: 'system', content: briefParts.join('\n\n') }
    : null;

  const lastRunText = input.lastRun ? formatLastRunPrompt(input.lastRun) : null;
  const lastRunMessage: ChatCompletionMessageParam | null = lastRunText
    ? { role: 'system', content: lastRunText }
    : null;

  const users = userSeqs(live);
  const keepToolsFrom = keepFromNthLast(users, budget.keepToolResultsForTurns);
  const keepImagesFrom = keepFromNthLast(users, budget.keepAttachmentsForTurns);

  const lastUserSeq = users.at(-1);
  const maxToolChars = budget.toolResultMaxTokens * CHARS_PER_TOKEN;
  const outcomeCards = flags.outcomeCards;
  const situationText = flags.situationCard
    ? [
        buildSituationCard({ envelopes: input.envelopes, lastUserSeq }),
        buildEvidenceLog(input.envelopes),
      ]
        .filter(Boolean)
        .join('\n\n')
    : '';

  let stubbedToolResults = 0;
  const tailMessages: ChatCompletionMessageParam[] = [];
  const turnMessages: ChatCompletionMessageParam[] = [];

  // load_skill calls by id: their results are part of the conversation and never stubbed.
  const skillCalls = new Map<string, SkillLoad>();
  // Name + args per call, for the outcome cards of old tool rows.
  const callInfo = new Map<string, ToolCallInfo>();
  for (const envelope of live) {
    if (envelope.record.role !== 'assistant') continue;
    for (const call of envelope.record.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      callInfo.set(call.id, {
        name: call.function.name,
        args: call.function.arguments,
      });
      if (call.function.name !== 'load_skill') continue;
      const load = skillLoadFromArgs(call.function.arguments);
      if (load) skillCalls.set(call.id, load);
    }
  }

  // Carry-over: every tool result here was made before this run starts (an
  // earlier turn inside the turn window, or an earlier run of the current
  // turn that is being resumed). They stay in full newest-first up to
  // `carryOverToolTokens`; once one does not fit, it and everything older
  // get the card old results get. Without this a "continue" turn re-sends
  // the whole previous run's results on every call.
  // The cap a recent tool row keeps. With flags.carryWholeReads it is the
  // same per-tool cap the row had inside its run (a whole read_file window),
  // so a follow-up turn sees what the last turn saw; otherwise the generic
  // tool-result cap.
  const recentCap = (toolCallId: string): number =>
    flags.carryWholeReads ? liveResultCapChars(callInfo.get(toolCallId)?.name, maxToolChars) : maxToolChars;
  const overCarryOver = new Set<number>();
  let carryOverLeft = budget.carryOverToolTokens * CHARS_PER_TOKEN;
  for (let i = live.length - 1; i >= 0; i--) {
    const envelope = live[i]!;
    if (envelope.record.role !== 'tool') continue;
    if (envelope.seq < keepToolsFrom) break;
    // Loaded skills stay whole and do not use the carry-over allowance.
    if (skillCalls.has(envelope.record.tool_call_id)) continue;
    const size = Math.min(envelope.record.content.length, recentCap(envelope.record.tool_call_id));
    // A card would not be smaller than a result this short.
    if (size < MIN_EVICT_CHARS) continue;
    if (size <= carryOverLeft) carryOverLeft -= size;
    else {
      carryOverLeft = 0;
      overCarryOver.add(envelope.seq);
    }
  }

  // Arguments of earlier turns' calls are re-sent on every call too. Where
  // what they carry is held elsewhere, long values are cut: a call whose
  // result is now a card (the card names the call), or a call that changed
  // the workspace (the file holds the change: an edit's oldText/newText).
  // Measured on a live migration thread: arguments at a run's start fell
  // from ~27k to ~21k tokens. Prompt-only: the ledger keeps them.
  const traitsOf = traitsResolver((name) => input.tools.byName.get(name)?.traits);
  const cardedCalls = new Set<string>();
  for (const envelope of live) {
    if (envelope.record.role !== 'tool') continue;
    if (envelope.seq < keepToolsFrom || overCarryOver.has(envelope.seq)) cardedCalls.add(envelope.record.tool_call_id);
  }
  const trimCall = (call: { id: string; name: string }) =>
    cardedCalls.has(call.id) || traitsOf(call.name)?.effect === 'change';

  // Skills whose instructions the conversation already shows: a later load
  // of the same skill (from before loads were deduped) becomes a pointer.
  const shownSkills = new Set<string>();
  for (const envelope of live) {
    const inTurn = lastUserSeq !== undefined && envelope.seq >= lastUserSeq;
    const skillLoad =
      envelope.record.role === 'tool' ? skillCalls.get(envelope.record.tool_call_id) : undefined;
    const oldTool =
      envelope.record.role === 'tool' &&
      !skillLoad &&
      (envelope.seq < keepToolsFrom || overCarryOver.has(envelope.seq));
    const overCap =
      envelope.record.role === 'tool' &&
      !skillLoad &&
      envelope.record.content.length > recentCap(envelope.record.tool_call_id);
    const stubTool = oldTool;
    if (oldTool) stubbedToolResults++;
    const stubImages =
      envelope.record.role === 'user' && envelope.seq < keepImagesFrom;

    // A second load of a skill already shown above gets a pointer, not a second copy.
    let skillContent: string | null = null;
    if (skillLoad && !skillLoad.file && envelope.record.role === 'tool' && isSkillBody(envelope.record.content)) {
      const key = skillLoad.name.toLowerCase();
      if (shownSkills.has(key)) skillContent = skillAlreadyLoadedNote(skillLoad.name);
      else shownSkills.add(key);
    }
    let message: ChatCompletionMessageParam | null = toParam(
      envelope,
      skillContent ??
        (stubTool && envelope.record.role === 'tool'
          ? stubToolContent(
              envelope,
              callInfo.get(envelope.record.tool_call_id),
              outcomeCards,
            )
          : null),
      stubImages,
      envelope.record.role === 'user' ? referencesBlock(envelope) : '',
    );
    if (
      message?.role === 'tool' &&
      overCap &&
      !oldTool &&
      typeof message.content === 'string'
    ) {
      message = {
        role: 'tool',
        tool_call_id: message.tool_call_id,
        content: flags.carryWholeReads
          ? capRecentToolContent(message.content, recentCap(message.tool_call_id), {
              lineBoundary: true,
              ...(envelope.contentBlob ? { blobSha: envelope.contentBlob } : {}),
            })
          : capRecentToolContent(message.content, maxToolChars),
      };
    }
    if (!message) continue;
    if (!inTurn && message.role === 'assistant' && message.tool_calls?.length) {
      message = { ...message, tool_calls: trimEarlierCallArguments(message.tool_calls, trimCall) };
    }
    if (inTurn) turnMessages.push(message);
    else tailMessages.push(message);
  }

  // Stable layers first, then history, then layers that change between sends
  // (plan edits, last-run note, situation). A plan edit then invalidates only
  // the tail of the prompt, not the whole history prefix. Named skills and
  // attached threads are references inside their user message, so they never move.
  const perSendTexts = [
    planText,
    lastRunText ?? '',
    situationText,
  ].filter((text) => text.length > 0);
  const tieredTurn = flags.promptTiers
    ? withHarnessContext(turnMessages, perSendTexts)
    : null;
  const messages: ChatCompletionMessageParam[] = fillOrphanToolResults(
    tieredTurn
      ? [
          // One leading system message: identity, tools, skills index,
          // memory, rules, brief. Per-send context rides in the user turn.
          {
            role: 'system',
            content: [
              systemText,
              skillsText,
              memoryText,
              rulesText,
              briefMessage ? String(briefMessage.content) : '',
            ]
              .filter((text) => text.length > 0)
              .join('\n\n'),
          },
          ...tailMessages,
          ...tieredTurn,
        ]
      : [
          systemMessage,
          ...(skillsMessage ? [skillsMessage] : []),
          memoryMessage,
          ...(rulesMessage ? [rulesMessage] : []),
          ...(briefMessage ? [briefMessage] : []),
          ...tailMessages,
          ...(planMessage ? [planMessage] : []),
          ...(lastRunMessage ? [lastRunMessage] : []),
          ...(situationText ? [{ role: 'system' as const, content: situationText }] : []),
          ...turnMessages,
        ],
  );

  // Use the assembled messages, not raw ledger content: a repeated load is a
  // pointer there, and conversationTokens subtracts this from a total built
  // from those same messages.
  const skillsLoadedTokens = loadSkillTokensFromMessages([
    ...tailMessages,
    ...turnMessages,
  ]);
  const conversationTokens = Math.max(
    0,
    layerTokens([...tailMessages, ...turnMessages]) - skillsLoadedTokens,
  );

  const layers = [
    {
      id: 'system',
      label: 'System',
      tokens: layerTokens([systemMessage]),
    },
    {
      id: 'tools',
      label: 'Tools',
      tokens: layerTokens([], input.tools.definitions),
    },
    {
      id: 'skills_catalog',
      label: 'Skill catalog',
      tokens: skillsText ? charsToTokens(skillsText.length) + 4 : 0,
    },
    {
      id: 'memory',
      label: 'Memory',
      tokens: charsToTokens(memoryText.length) + 4,
    },
    {
      id: 'rules',
      label: 'Rules',
      tokens: rulesText ? charsToTokens(rulesText.length) + 4 : 0,
    },
    {
      id: 'plan',
      label: 'Plan',
      tokens: planText ? charsToTokens(planText.length) + 4 : 0,
    },
    {
      id: 'brief',
      label: 'Thread brief',
      tokens: briefMessage
        ? charsToTokens(String(briefMessage.content).length - (recordText ? recordText.length + 2 : 0)) + 4
        : 0,
    },
    {
      id: 'record',
      label: 'Task record (earlier runs)',
      tokens: recordText ? charsToTokens(recordText.length) : 0,
    },
    {
      id: 'situation',
      label: 'Situation and evidence',
      tokens: situationText ? charsToTokens(situationText.length) + 4 : 0,
    },
    {
      id: 'last_run',
      label: 'Last run',
      tokens: lastRunText ? charsToTokens(lastRunText.length) + 4 : 0,
    },
    {
      id: 'conversation',
      label: 'Conversation',
      tokens: conversationTokens,
    },
    {
      id: 'skills_loaded',
      label: 'Loaded skills',
      tokens: skillsLoadedTokens,
    },
  ];

  const occupiedTokens = layers.reduce((sum, layer) => sum + layer.tokens, 0);
  const needsCompaction = occupiedTokens > compactionMarks(budget).at;

  const report: ContextReport = {
    budget,
    layers,
    occupiedTokens,
    stubbedToolResults,
    needsCompaction,
  };

  return { messages, report };
}
