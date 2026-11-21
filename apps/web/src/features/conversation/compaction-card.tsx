'use client';

import { Layers } from 'lucide-react';

import type { CompactionNotice } from './chat-store';
import { TrailLine, TrailSection } from './trail-line';
import { useDiagnostics } from '@/lib/reading-prefs';

/**
 * Compaction in the reading flow: one trail line. While running it is a
 * still line (the dock carries the motion); once done it expands to the
 * brief and summary. The ledger seq is a diagnostic, not reader copy.
 */
export function CompactionCard({ notice }: { notice: CompactionNotice }) {
  const diagnostics = useDiagnostics();
  const running = notice.status === 'running';

  if (running) {
    return (
      <TrailLine
        icon={<Layers className="size-3.5" strokeWidth={1.75} />}
        label="Compacting context…"
        ariaLabel="Compacting context"
      />
    );
  }

  const hasBody = Boolean(notice.brief.trim() || notice.summary.trim());
  return (
    <TrailLine
      icon={<Layers className="size-3.5" strokeWidth={1.75} />}
      label="Context compacted"
      ariaLabel="Context compacted"
      meta={
        diagnostics && notice.throughSeq > 0 ? (
          <span>through seq {notice.throughSeq}</span>
        ) : null
      }
    >
      {hasBody ? (
        <>
          {notice.brief.trim() ? (
            <TrailSection title="Brief">
              <pre className="type-ui max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans leading-relaxed text-[var(--reading-foreground)]">
                {notice.brief}
              </pre>
            </TrailSection>
          ) : null}
          {notice.summary.trim() ? (
            <TrailSection title="Summary">
              <pre className="type-ui max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans leading-relaxed text-[var(--reading-foreground)]">
                {notice.summary}
              </pre>
            </TrailSection>
          ) : null}
        </>
      ) : null}
    </TrailLine>
  );
}
