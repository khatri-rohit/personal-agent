'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Zone 1 primitive: one quiet line in the reading flow for anything that is
 * not prose — tool groups, sub-agents, questions, compaction, the plan.
 * Same height, same icon column, same muted type, no box, no motion. Open
 * state belongs to the reader: nothing opens or closes itself.
 *
 * Styles live in global.css (.trail-line / .trail-icon / .trail-chevron /
 * .trail-body) so every surface shares one definition.
 */
export function TrailLine({
  icon,
  label,
  meta,
  children,
  defaultOpen = false,
  ariaLabel,
  className,
}: {
  /** Glyph in the fixed 1rem icon column; omit for a bare line. */
  icon?: React.ReactNode;
  /** The line itself: what happened, in plain words. */
  label: React.ReactNode;
  /** Trailing detail (counts, +/−, status); subtle tier. */
  meta?: React.ReactNode;
  /** Expandable detail. Without it the line is static text. */
  children?: React.ReactNode;
  defaultOpen?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = children !== undefined && children !== null;

  const content = (
    <>
      <span className="trail-icon" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta ? (
        <span className="type-caption flex shrink-0 items-center gap-2 tabular-nums text-subtle-foreground">
          {meta}
        </span>
      ) : null}
      {expandable ? (
        <ChevronDown className="trail-chevron size-3.5" aria-hidden />
      ) : null}
    </>
  );

  return (
    <div className={cn('w-full min-w-0', className)}>
      {expandable ? (
        <button
          type="button"
          className="trail-line"
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={() => setOpen((value) => !value)}
        >
          {content}
        </button>
      ) : (
        <div className="trail-line" aria-label={ariaLabel}>
          {content}
        </div>
      )}
      {expandable && open ? <div className="trail-body">{children}</div> : null}
    </div>
  );
}

/** Small section heading inside an expanded trail body. */
export function TrailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 py-1">
      <p className="type-caption mb-1 font-medium text-subtle-foreground">
        {title}
      </p>
      {children}
    </section>
  );
}
