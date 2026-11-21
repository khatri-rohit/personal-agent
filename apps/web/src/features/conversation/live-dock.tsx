'use client';

import { useEffect, useState } from 'react';
import { ChevronUp, Loader2 } from 'lucide-react';
import type { ThreadPlan } from '@agent/agent-models';
import { isThreadPlanEmpty } from '@agent/agent-models';

import type { SubagentActivity } from './chat-store';
import { PlanDetail, planProgressLabel } from './thread-plan-card';
import { SubagentDockRows } from './subagent-card';
import { cn } from '@/lib/utils';

export type LivePhase = 'working' | 'compacting' | 'waiting';

/** Elapsed run time at a 5s cadence: the number is useful, the flicker isn't. */
function coarseElapsed(ms: number): string | null {
  const secs = Math.floor(ms / 5000) * 5;
  if (secs < 5) return null;
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${String(secs % 60).padStart(2, '0')}s`;
}

function useCoarseNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Zone 2: the live dock. One fixed-height line above the composer, aligned
 * to the reading column, and the only element that moves during a run (one
 * spinner). It says the run's phase, elapsed time, plan progress and how
 * many sub-agents are out — never the current tool step, which the newest
 * tool line in the conversation already reads in place.
 *
 * It sits in flow above the composer at a constant height, so it never
 * covers the transcript and never resizes mid-run. Detail (plan, live
 * sub-agents with links) opens upward only on click.
 */
export function LiveDock({
  phase,
  plan,
  subagents,
  runStartedAt,
}: {
  phase: LivePhase;
  plan: ThreadPlan | null;
  subagents: SubagentActivity[];
  runStartedAt?: string;
}) {
  const [open, setOpen] = useState(false);
  const waiting = phase === 'waiting';
  const now = useCoarseNow(!waiting);
  const started = runStartedAt ? Date.parse(runStartedAt) : NaN;
  const elapsed =
    !waiting && Number.isFinite(started)
      ? coarseElapsed(Math.max(0, now - started))
      : null;

  const running = subagents.filter((item) => item.status === 'running');
  const planLabel = planProgressLabel(plan);
  const hasPlan = Boolean(plan && !isThreadPlanEmpty(plan));
  const expandable = hasPlan || running.length > 0;

  const phaseLabel =
    phase === 'compacting'
      ? 'Compacting context'
      : waiting
        ? 'Waiting for your answer'
        : 'Working';

  const parts = [
    elapsed,
    planLabel,
    running.length > 0
      ? `${running.length} sub-agent${running.length === 1 ? '' : 's'}`
      : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <div className="relative">
      {open && expandable ? (
        <div
          className="absolute inset-x-0 bottom-full mb-1.5 max-h-[50vh] space-y-3 overflow-y-auto rounded-lg border border-border/60 bg-popover px-3.5 py-3 shadow-sm"
          role="region"
          aria-label="Run details"
        >
          {running.length > 0 ? <SubagentDockRows activities={running} /> : null}
          {hasPlan && plan ? <PlanDetail plan={plan} /> : null}
        </div>
      ) : null}
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'type-ui flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-card px-3 text-left text-muted-foreground',
          expandable && 'hover:text-foreground',
        )}
        role="status"
        aria-live="polite"
      >
        {waiting ? (
          // Needs-you state: the agent is paused, so nothing moves; the
          // accent marks that the next move is the reader's.
          <span className="size-1.5 shrink-0 rounded-full bg-primary" />
        ) : (
          <Loader2 className="live-spinner size-3.5 shrink-0 animate-spin" />
        )}
        <span className={cn('shrink-0', waiting && 'text-foreground')}>
          {phaseLabel}
        </span>
        {parts.length > 0 ? (
          <span className="type-caption min-w-0 flex-1 truncate tabular-nums text-subtle-foreground">
            {parts.join(' · ')}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {expandable ? (
          <ChevronUp
            className={cn(
              'size-3.5 shrink-0 transition-transform',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        ) : null}
      </button>
    </div>
  );
}
