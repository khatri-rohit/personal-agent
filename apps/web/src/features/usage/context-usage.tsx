'use client';

import { cn, formatCount } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type {
  ContextReportLayer,
  ContextWindowSource,
} from '@agent/agent-models';
import type { ContextMeterSource } from '@/features/usage/use-context-meter';

const BUCKETS: {
  id: string;
  label: string;
  layerIds: readonly string[];
  barClass: string;
}[] = [
  {
    id: 'system',
    label: 'System',
    layerIds: ['system'],
    barClass: 'bg-foreground/80',
  },
  {
    id: 'tools',
    label: 'Tools',
    layerIds: ['tools'],
    barClass: 'bg-foreground/55',
  },
  {
    id: 'rules',
    label: 'Rules & memory',
    layerIds: [
      'skills_catalog',
      'skills_bodies',
      'memory',
      'rules',
      'plan',
      'mentions',
      'brief',
      'record',
      'last_run',
      'situation',
    ],
    barClass: 'bg-foreground/35',
  },
  {
    id: 'conversation',
    label: 'Conversation',
    layerIds: ['conversation', 'skills_loaded'],
    barClass: 'bg-foreground',
  },
];

function tokensFor(
  layers: ContextReportLayer[],
  ids: readonly string[],
): number {
  const idSet = new Set(ids);
  return layers.reduce(
    (sum, layer) => (idSet.has(layer.id) ? sum + layer.tokens : sum),
    0,
  );
}

export function ContextUsage({
  used,
  limit,
  source,
  approximate,
  layers = [],
  reserve = 0,
  windowSource,
  runPromptTokens,
  runPromptCap,
  runUsageEstimated,
}: {
  used: number;
  limit: number | null;
  source: ContextMeterSource;
  approximate: boolean;
  layers?: ContextReportLayer[];
  reserve?: number;
  windowSource?: ContextWindowSource;
  /** Prompt tokens billed so far this run: every call re-sends the context. */
  runPromptTokens?: number;
  runPromptCap?: number;
  runUsageEstimated?: boolean;
}) {
  if (limit == null || limit <= 0) return null;

  const ratio = Math.min(1, Math.max(0, used / limit));
  const percent = Math.round(ratio * 100);
  const usedLabel = formatCount(used);
  const limitLabel = formatCount(limit);
  const showTilde = source === 'estimate' || approximate;
  const defaultWindow = windowSource === 'fallback';
  const free = Math.max(0, limit - used - reserve);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="meter"
          aria-label={`${showTilde ? 'About ' : ''}${percent}% context used, ${usedLabel} of ${limitLabel} tokens, ${source}${defaultWindow ? ', default window' : ''}${windowSource === 'served' ? ', limited by local Ollama' : ''}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="inline-flex h-7 items-center justify-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {/* A short bar, not a ring: a partial ring reads as a loading
              spinner, a bar reads as "how full". */}
          <span
            className="relative h-1.5 w-7 overflow-hidden rounded-full bg-muted-foreground/20"
            aria-hidden
          >
            <span
              className={cn(
                'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out',
                ratio >= 0.92
                  ? 'bg-destructive'
                  : ratio >= 0.75
                    ? 'bg-[var(--warning)]'
                    : 'bg-foreground/60',
              )}
              style={{ width: `${Math.max(ratio * 100, ratio > 0 ? 6 : 0)}%` }}
            />
          </span>
          <span className="type-caption tabular-nums" aria-hidden>
            {percent}%
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-64 p-2.5">
        <p className="type-caption mb-2 font-medium text-muted-foreground">
          Context
        </p>
        {ratio >= 0.92 ? (
          <p className="type-caption mb-2 rounded-md bg-[var(--warning)]/10 px-2 py-1 text-[var(--warning)]">
            Context nearly full — the next run may compact or trim history.
          </p>
        ) : null}
        <div
          className="mb-2 flex h-1.5 overflow-hidden rounded-full bg-muted"
          aria-hidden
        >
          {BUCKETS.map((bucket) => {
            const tokens = tokensFor(layers, bucket.layerIds);
            if (tokens <= 0) return null;
            return (
              <div
                key={bucket.id}
                className={bucket.barClass}
                style={{ width: `${(tokens / limit) * 100}%` }}
              />
            );
          })}
          {reserve > 0 ? (
            <div
              className="bg-muted-foreground/25"
              style={{ width: `${(reserve / limit) * 100}%` }}
            />
          ) : null}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Used</dt>
          <dd className="text-right font-medium tabular-nums">
            {showTilde ? '~' : ''}
            {usedLabel}
          </dd>
          {BUCKETS.map((bucket) => {
            const tokens = tokensFor(layers, bucket.layerIds);
            if (tokens <= 0) return null;
            const kids = layers.filter(
              (layer) =>
                bucket.layerIds.includes(layer.id) && layer.tokens > 0,
            );
            return (
              <div key={bucket.id} className="contents">
                <dt className="text-muted-foreground">{bucket.label}</dt>
                <dd className="text-right tabular-nums">
                  {formatCount(tokens)}
                </dd>
                {kids.length > 1
                  ? kids.map((layer) => (
                      <div key={layer.id} className="contents">
                        <dt className="pl-2 text-muted-foreground">
                          {layer.label}
                        </dt>
                        <dd className="text-right tabular-nums text-muted-foreground">
                          {formatCount(layer.tokens)}
                        </dd>
                      </div>
                    ))
                  : null}
              </div>
            );
          })}
          {reserve > 0 ? (
            <>
              <dt className="text-muted-foreground">Reserve</dt>
              <dd className="text-right tabular-nums">
                {formatCount(reserve)}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Free</dt>
          <dd className="text-right tabular-nums">{formatCount(free)}</dd>
          <dt className="text-muted-foreground">Limit</dt>
          <dd className="text-right font-medium tabular-nums">{limitLabel}</dd>
          {runPromptTokens !== undefined ? (
            <>
              <dt className="text-muted-foreground">Run spend</dt>
              <dd className="text-right tabular-nums">
                {runUsageEstimated ? '~' : ''}
                {formatCount(runPromptTokens)}
                {runPromptCap ? ` of ${formatCount(runPromptCap)}` : ''}
              </dd>
            </>
          ) : null}
        </dl>
        {defaultWindow ? (
          <p className="type-caption mt-2 text-muted-foreground">
            Using the 260K fallback window: the model's size is unavailable
          </p>
        ) : null}
        {windowSource === 'served' ? (
          <p className="type-caption mt-2 text-muted-foreground">
            Limited to the context local Ollama loaded this model with. Raise
            OLLAMA_CONTEXT_LENGTH on the daemon for more.
          </p>
        ) : null}
        <p className="type-caption mt-2 text-muted-foreground tabular-nums">
          {showTilde ? '~' : ''}
          {percent}% of window
        </p>
      </PopoverContent>
    </Popover>
  );
}
