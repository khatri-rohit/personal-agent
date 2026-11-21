import {
  parseSubagentHeader,
  type Message,
  type PendingToolCall,
} from '@agent/agent-models';

import {
  toolStatusOf,
  type AssistantSnippet,
  type CompactionNotice,
  type SubagentActivity,
  type ToolActivity,
  type ToolStatus,
} from './chat-store';

export type ToolCallRow = {
  toolCallId: string;
  toolName: string;
  args?: string;
  result?: string;
  status: ToolStatus;
  durationMs?: number;
  /**
   * Which model step issued the call. A merged group can span several steps;
   * the expanded view draws a hairline where the step changes. Live rows
   * have no step id until the ledger lands.
   */
  batch?: string;
};

export type TimelineStep =
  | { type: 'assistant'; message: Message }
  | { type: 'snippet'; messageId: string; content: string }
  | { type: 'tools'; key: string; rows: ToolCallRow[] }
  | { type: 'choice'; key: string; row: ToolCallRow }
  | { type: 'compaction'; notice: CompactionNotice }
  | { type: 'subagent'; activity: SubagentActivity }
  | { type: 'stream'; messageId: string; content: string };

/**
 * The one grouping rule, shared by the live and the ledger path:
 * consecutive tool calls form one group until something the reader should
 * see breaks it — assistant prose, a sub-agent, a question to the user, or
 * compaction. Parallel calls and back-to-back tool-only model steps land in
 * the same group, so a finished run reads exactly like it did live.
 *
 * Groups are keyed by their first tool call id: the live group and the
 * ledger group that replaces it at settle are the same React element, so
 * nothing remounts and a group the user opened stays open.
 */
function groupKey(rows: ToolCallRow[]): string {
  return `tools-${rows[0]?.toolCallId ?? 'empty'}`;
}

/** A settled delegate with a digest header renders as its own card. */
function isSubagentRow(row: ToolCallRow): boolean {
  return (
    row.toolName === 'delegate' && parseSubagentHeader(row.result ?? '') !== null
  );
}

function previewToArgs(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function liveById(liveActivity: ToolActivity[]): Map<string, ToolActivity> {
  const map = new Map<string, ToolActivity>();
  for (const activity of liveActivity) {
    map.set(activity.toolCallId, activity);
  }
  return map;
}

function rowFromCall(
  call: PendingToolCall,
  toolMessage: Message | undefined,
  activity: ToolActivity | undefined,
): ToolCallRow {
  // Settled ledger with no tool row = interrupted (pre-I1 / crash), not in-flight.
  let status: ToolStatus = 'failed';
  if (activity) {
    status = activity.status;
  } else if (toolMessage && toolMessage.status !== 'interrupted') {
    status = toolStatusOf(toolMessage.toolOutcome ?? 'ok');
  }

  const liveArgs = previewToArgs(activity?.argsPreview);
  const liveResult = previewToArgs(activity?.resultPreview);

  return {
    toolCallId: call.id,
    toolName: call.function.name,
    args: call.function.arguments || liveArgs,
    result:
      toolMessage?.content ??
      liveResult ??
      (status === 'failed' ? 'Skipped: interrupted before result.' : undefined),
    status,
    durationMs: activity?.durationMs,
  };
}

function rowFromLive(activity: ToolActivity): ToolCallRow {
  return {
    toolCallId: activity.toolCallId,
    toolName: activity.toolName,
    args: previewToArgs(activity.argsPreview),
    result: previewToArgs(activity.resultPreview),
    status: activity.status,
    durationMs: activity.durationMs,
  };
}

/**
 * Ordered turn steps: assistant → tools → assistant → live tools → stream →
 * compaction (host post-loop step, same visual column as tools).
 *
 * Mid-run, the ledger is stale until `run.settled`, so `replies` holds only
 * messages from prior runs. Settled assistant messages from the active run
 * arrive as `snippets` (from `assistant.completed`), and in-flight tools
 * arrive as `liveActivity`. We merge snippets and not-yet-ledgered live tools
 * by event `seq` to reconstruct the true interleaved order, then append the
 * active stream and compaction.
 *
 * Ledger dedup: assistant rows in `replies` whose `runId` matches the active
 * run are skipped in the walk — snippets are the sole renderer of active-run
 * prose during the run, so a mid-run ledger refetch (context.compacted bumps
 * the epoch) cannot double-render. At `run.settled` the active run is nulled
 * and the ledger takes over as the only source.
 */
export function buildTurnTimeline(input: {
  replies: Message[];
  liveActivity: ToolActivity[];
  snippets?: AssistantSnippet[];
  activeRunId?: string;
  streaming?: { id: string; content: string } | null;
  compaction?: CompactionNotice | null;
  subagentActivity?: SubagentActivity[];
}): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const activityMap = liveById(input.liveActivity);
  const seenToolIds = new Set<string>();
  const replies = input.replies;
  let index = 0;
  const snippets = input.snippets ?? [];

  // The open group collects tool rows until something breaks it.
  let openRows: ToolCallRow[] = [];
  const flushTools = () => {
    if (openRows.length === 0) return;
    steps.push({ type: 'tools', key: groupKey(openRows), rows: openRows });
    openRows = [];
  };
  const pushRow = (row: ToolCallRow) => {
    if (row.toolName === 'offer_choice') {
      flushTools();
      steps.push({ type: 'choice', key: `choice-${row.toolCallId}`, row });
      return;
    }
    openRows.push(row);
  };

  while (index < replies.length) {
    const message = replies[index];

    if (message.role === 'tool') {
      index += 1;
      continue;
    }

    if (message.role !== 'assistant') {
      index += 1;
      continue;
    }

    // Skip assistant rows the ledger already has for the active run; they are
    // represented by snippets below, merged in seq order with live tools.
    if (input.activeRunId && message.runId === input.activeRunId) {
      index += 1;
      continue;
    }

    if (message.content.trim()) {
      flushTools();
      steps.push({ type: 'assistant', message });
    }

    const calls = message.toolCalls ?? [];
    if (calls.length > 0) {
      const results = new Map<string, Message>();
      let cursor = index + 1;
      while (cursor < replies.length && replies[cursor].role === 'tool') {
        const toolMessage = replies[cursor];
        if (toolMessage.toolCallId) {
          results.set(toolMessage.toolCallId, toolMessage);
        }
        cursor += 1;
      }

      const rows = calls.map((call) => {
        seenToolIds.add(call.id);
        return {
          ...rowFromCall(call, results.get(call.id), activityMap.get(call.id)),
          batch: message.id,
        };
      });
      // Same order the live path shows: the batch's ordinary tools join the
      // open group, then each settled delegate follows as its own card
      // (live, the sub-agent step arrives after the batch's tool.started).
      const delegates: ToolCallRow[] = [];
      for (const row of rows) {
        if (isSubagentRow(row)) delegates.push(row);
        else pushRow(row);
      }
      if (delegates.length > 0) {
        flushTools();
        steps.push({ type: 'tools', key: groupKey(delegates), rows: delegates });
      }
      index = cursor;
      continue;
    }

    index += 1;
  }

  // Merge settled snippets and not-yet-ledgered live tools by event seq, so
  // mid-run the timeline reads assistant → tools → assistant → tools in the
  // order events actually arrived.
  type PendingItem =
    | { kind: 'snippet'; seq: number; snippet: AssistantSnippet }
    | { kind: 'tool'; seq: number; activity: ToolActivity }
    | { kind: 'subagent'; seq: number; activity: SubagentActivity };
  const pending: PendingItem[] = [];

  for (const snippet of snippets) {
    pending.push({ kind: 'snippet', seq: snippet.seq, snippet });
  }

  const liveOnly = input.liveActivity.filter((activity) => {
    if (seenToolIds.has(activity.toolCallId)) return false;
    // Delegates are rendered by subagent steps instead (lean line while
    // running, digest card once settled) — keeping the tool row would show
    // the same delegate twice in the reading path. A refused spawn has no
    // subrun event, so its failed row still renders.
    if (activity.toolName === 'delegate') {
      if (activity.status === 'running') return false;
      const text = previewToArgs(activity.resultPreview);
      if (parseSubagentHeader(text ?? '')) return false;
    }
    return true;
  });
  for (const activity of liveOnly) {
    pending.push({ kind: 'tool', seq: activity.seq, activity });
  }
  for (const activity of input.subagentActivity ?? []) {
    pending.push({ kind: 'subagent', seq: activity.seq, activity });
  }

  pending.sort((a, b) => a.seq - b.seq);

  // Live items continue the same open group the ledger walk left (a run
  // that resumes mid-turn keeps one group), under the same rule.
  for (const item of pending) {
    if (item.kind === 'snippet') {
      flushTools();
      if (item.snippet.content.trim()) {
        steps.push({
          type: 'snippet',
          messageId: item.snippet.messageId,
          content: item.snippet.content,
        });
      }
    } else if (item.kind === 'subagent') {
      flushTools();
      steps.push({ type: 'subagent', activity: item.activity });
    } else {
      pushRow(rowFromLive(item.activity));
    }
  }

  const stream = input.streaming;
  const streamContent = stream?.content.trim();
  if (stream && streamContent) {
    flushTools();
    steps.push({ type: 'stream', messageId: stream.id, content: streamContent });
  }
  flushTools();

  if (input.compaction) {
    steps.push({ type: 'compaction', notice: input.compaction });
  }

  return steps;
}

/**
 * One-line account of what a turn did ("Edited 3 files · 12 tool calls ·
 * 1 failed"). Built from timeline steps, so it rebuilds from the ledger.
 * Undefined for pure chat turns, where it would be noise.
 */
export function summarizeTurnWork(steps: TimelineStep[]): string | undefined {
  const rows = steps.flatMap((step) =>
    step.type === 'tools' ? step.rows : [],
  );
  if (rows.length === 0) return undefined;
  const files = new Set<string>();
  let failed = 0;
  for (const row of rows) {
    if (row.status === 'failed') failed += 1;
    if (row.toolName !== 'edit_file' || row.status === 'failed') continue;
    try {
      const path = (JSON.parse(row.args ?? '{}') as { path?: unknown }).path;
      if (typeof path === 'string' && path) files.add(path);
    } catch {
      /* partial args while streaming */
    }
  }
  const parts: string[] = [];
  if (files.size > 0) {
    parts.push(`Edited ${files.size} file${files.size === 1 ? '' : 's'}`);
  }
  parts.push(`${rows.length} tool call${rows.length === 1 ? '' : 's'}`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(' · ');
}
