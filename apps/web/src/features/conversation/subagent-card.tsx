'use client';

import { Link } from 'react-router';
import { AlertCircle, Check, XCircle } from 'lucide-react';

import type { SubagentActivity } from './chat-store';
import { TrailLine } from './trail-line';
import { useDiagnostics } from '@/lib/reading-prefs';

const PROFILE_LABELS: Record<string, string> = {
  explore: 'Explore',
  review: 'Review',
  advisor: 'Advisor',
};

export function profileLabel(profile: string): string {
  return PROFILE_LABELS[profile] ?? profile;
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k tokens` : `${tokens} tokens`;
}

/** Settled statuses in words; unknown values fall back to the raw status. */
const SETTLED_STATUS_LABELS: Record<string, string> = {
  completed: 'Done',
  incomplete: 'Stopped early',
  error: 'Failed',
  cancelled: 'Cancelled',
};

/** Live counter for a running delegate ('starting…' until the first tool). */
export function liveCounter(item: SubagentActivity): string {
  const calls = item.toolCalls ?? 0;
  return calls > 0
    ? `${calls} tool${calls === 1 ? '' : 's'}${item.lastTool ? ` · ${item.lastTool}` : ''}`
    : 'starting…';
}

/**
 * Settled delegation in the reading flow: one trail line ("Explore · find
 * the auth seam — Done"), expanding to the digest and a link to the child
 * thread. Plain words by default; iteration/tool/token counts only with run
 * diagnostics on.
 */
export function SubagentCard({ activity }: { activity: SubagentActivity }) {
  const diagnostics = useDiagnostics();
  const icon =
    activity.status === 'completed' ? (
      <Check className="size-3.5 text-subtle-foreground" />
    ) : activity.status === 'cancelled' ? (
      <XCircle className="size-3.5 text-subtle-foreground" />
    ) : (
      <AlertCircle className="size-3.5 text-destructive" />
    );
  const statusLabel = SETTLED_STATUS_LABELS[activity.status] ?? activity.status;
  const detail: string[] = [];
  if (activity.toolCalls !== undefined) {
    detail.push(
      `${activity.toolCalls} tool call${activity.toolCalls === 1 ? '' : 's'}`,
    );
  }
  if (diagnostics && activity.iterations !== undefined) {
    detail.push(`${activity.iterations} steps`);
  }
  if (diagnostics && activity.tokens !== undefined) {
    detail.push(formatTokens(activity.tokens));
  }

  return (
    <TrailLine
      icon={icon}
      ariaLabel={`Sub-agent ${activity.profile}: ${activity.task}`}
      label={
        <>
          <span className="text-foreground/80">
            {profileLabel(activity.profile)}
          </span>
          {' · '}
          {activity.task}
        </>
      }
      meta={
        <>
          <span>{statusLabel}</span>
          {detail.length > 0 ? <span>{detail.join(' · ')}</span> : null}
        </>
      }
    >
      {activity.summary ? (
        <pre className="type-ui max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans leading-relaxed text-[var(--reading-foreground)]">
          {activity.summary}
        </pre>
      ) : (
        <p className="type-ui text-subtle-foreground">No summary returned.</p>
      )}
      {activity.subThreadId ? (
        <Link
          to={`/chat/${activity.subThreadId}`}
          className="type-ui mt-1 inline-block text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
        >
          View conversation <span aria-hidden="true">→</span>
        </Link>
      ) : null}
    </TrailLine>
  );
}

/**
 * Live delegate in the reading flow: a still line marking where the
 * delegation happened. Progress (counter, link to the live thread) and the
 * one spinner live in the dock above the composer, not here.
 */
export function SubagentLiveLine({ activity }: { activity: SubagentActivity }) {
  return (
    <TrailLine
      icon={<span className="size-1.5 rounded-full bg-muted-foreground" />}
      ariaLabel={`Sub-agent ${activity.profile} running: ${activity.task}`}
      label={
        <>
          <span className="text-foreground/80">
            {profileLabel(activity.profile)}
          </span>
          {' · '}
          {activity.task}
        </>
      }
      meta={
        <>
          {activity.model ? (
            <span title={`Model: ${activity.model}`}>{activity.model}</span>
          ) : null}
          <span>Running</span>
        </>
      }
    />
  );
}

/** Running delegates as rows inside the expanded live dock. */
export function SubagentDockRows({
  activities,
}: {
  activities: SubagentActivity[];
}) {
  if (activities.length === 0) return null;
  return (
    <ul className="space-y-1">
      {activities.map((item) => (
        <li
          key={item.subRunId}
          className="type-ui flex min-w-0 items-center gap-2"
        >
          <span className="shrink-0 text-foreground/85">
            {profileLabel(item.profile)}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {item.task}
          </span>
          {item.model ? (
            <span
              className="type-caption max-w-48 shrink-0 truncate text-subtle-foreground"
              title={`Model: ${item.model}`}
            >
              {item.model}
            </span>
          ) : null}
          <span className="type-caption shrink-0 tabular-nums text-subtle-foreground">
            {liveCounter(item)}
          </span>
          {item.subThreadId ? (
            <Link
              to={`/chat/${item.subThreadId}`}
              className="type-caption shrink-0 text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
            >
              View live <span aria-hidden="true">→</span>
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
