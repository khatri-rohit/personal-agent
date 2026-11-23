'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileDiff, Loader2, Undo2 } from 'lucide-react';
import type { FileChange, Message, RunChanges } from '@agent/agent-models';
import { fetchRunChanges, fetchRunFileDiff, undoRunChanges } from '@/api/thread-client';
import { Button } from '@/components/ui/button';
import { toastError } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { showRestoreResult } from './thread-session';

/** Tools that can change files on disk (sub-agents cannot). */
const WRITING_TOOLS = new Set(['edit_file', 'run_terminal']);

/** The turn's run ids in ledger order, and whether any of its calls could have written files. */
export function turnWriteRuns(replies: Message[]): { runIds: string[]; wrote: boolean } {
  const runIds: string[] = [];
  let wrote = false;
  for (const reply of replies) {
    if (reply.runId && !runIds.includes(reply.runId)) runIds.push(reply.runId);
    if (reply.toolCalls?.some((call) => WRITING_TOOLS.has(call.function.name))) wrote = true;
  }
  return { runIds, wrote };
}

const STATUS_MARK: Record<FileChange['status'], string> = { added: 'A', modified: 'M', deleted: 'D' };

/**
 * What a turn's runs changed on disk (B3): a chip under the reply that opens
 * the file list, each file's diff, and Undo. The last turn loads at once
 * (Retry and Edit need the count); older turns load when opened.
 */
export function TurnChanges({
  threadId,
  runIds,
  eager,
  disabled,
  onFilesChanged,
}: {
  threadId: string;
  runIds: string[];
  /** Load now instead of on first open. */
  eager: boolean;
  /** A run is live on this thread: Undo waits. */
  disabled: boolean;
  /** The number of changed files, once known (0 when none or no snapshot). */
  onFilesChanged?: (count: number) => void;
}) {
  const key = runIds.join(',');
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState<RunChanges | null>(null);
  const [loading, setLoading] = useState(false);
  /** The run set whose load failed: no retry loop, the chip says so. */
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [undoing, setUndoing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchRunChanges(threadId, key.split(','));
      setChanges(next);
      onFilesChanged?.(next.available ? next.files.filter((file) => !file.nestedRepo).length : 0);
    } catch {
      setFailedKey(key);
    } finally {
      setLoading(false);
    }
  }, [threadId, key, onFilesChanged]);

  // A new run set (the turn grew a run): forget the old answer.
  useEffect(() => {
    setChanges(null);
    setFailedKey(null);
  }, [key]);

  useEffect(() => {
    if ((eager || open) && changes === null && !loading && failedKey !== key) void load();
  }, [eager, open, changes, loading, failedKey, key, load]);

  const undo = useCallback(async () => {
    setUndoing(true);
    try {
      showRestoreResult(await undoRunChanges(threadId, key.split(',')));
      setConfirmUndo(false);
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Undo failed', 'Undo failed');
    } finally {
      setUndoing(false);
    }
  }, [threadId, key]);

  // Loaded and nothing to show: a reply that wrote nothing in the end.
  if (changes?.available && changes.files.length === 0) return null;

  const files = changes?.files ?? [];
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  const label = changes?.available ? `Changed ${files.length} file${files.length === 1 ? '' : 's'}` : 'File changes';

  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="type-caption flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        <FileDiff className="size-3.5" aria-hidden />
        <span>{label}</span>
        {changes?.available ? (
          <span className="tabular-nums">
            <span className="text-green-600 dark:text-green-500">+{added}</span>{' '}
            <span className="text-destructive">−{removed}</span>
          </span>
        ) : null}
        {loading ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
      </button>

      {open && failedKey === key ? (
        <p className="type-caption px-2.5 pb-2 text-muted-foreground">Could not load the changes. Reload to try again.</p>
      ) : null}

      {open && changes && !changes.available ? (
        <p className="type-caption px-2.5 pb-2 text-muted-foreground">
          No snapshot exists for this reply (it ran before checkpoints, or the snapshot failed), so its file changes
          can&apos;t be listed or undone here.
        </p>
      ) : null}

      {open && changes?.available ? (
        <div className="flex flex-col gap-1 px-2.5 pb-2.5">
          <ul className="flex flex-col">
            {files.map((file) => (
              <ChangedFile key={file.path} threadId={threadId} runIds={runIds} file={file} />
            ))}
          </ul>
          <p className="type-caption text-muted-foreground">{changes.notCovered}</p>
          {confirmUndo ? (
            <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-background/60 px-2 py-1.5 ring-1 ring-border/50" role="alertdialog">
              <span className="text-xs text-foreground/90">
                Put these files back as they were before this reply? Files changed since stay as they are.
              </span>
              <Button type="button" size="sm" className="h-6 px-2 text-xs" disabled={undoing} onClick={() => void undo()}>
                {undoing ? 'Undoing…' : 'Undo changes'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={undoing}
                onClick={() => setConfirmUndo(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                disabled={disabled}
                onClick={() => setConfirmUndo(true)}
              >
                <Undo2 className="size-3" aria-hidden />
                Undo these changes
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ChangedFile({ threadId, runIds, file }: { threadId: string; runIds: string[]; file: FileChange }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<{ diff: string; truncated: boolean } | null>(null);

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && !diff && !file.nestedRepo) {
      try {
        setDiff(await fetchRunFileDiff(threadId, runIds, file.path));
      } catch (error) {
        toastError(error instanceof Error ? error.message : 'Could not load the diff', 'Diff');
      }
    }
  }, [open, diff, file, threadId, runIds]);

  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => void toggle()}
        className="type-caption flex w-full min-w-0 items-center gap-2 py-0.5 text-left hover:text-foreground"
      >
        <span className="w-3 shrink-0 font-mono text-muted-foreground">{STATUS_MARK[file.status]}</span>
        <span className="min-w-0 truncate font-mono">{file.path}</span>
        {file.nestedRepo ? (
          <span className="shrink-0 text-muted-foreground">nested repository, not restorable</span>
        ) : file.added !== undefined ? (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            +{file.added} −{file.removed}
          </span>
        ) : (
          <span className="shrink-0 text-muted-foreground">binary</span>
        )}
      </button>
      {open && diff ? (
        <pre className="mt-1 max-h-80 overflow-auto rounded bg-background/70 p-2 font-mono text-[11px] leading-snug ring-1 ring-border/40">
          {diff.diff.split('\n').map((line, index) => (
            <div
              key={index}
              className={cn(
                line.startsWith('+') && !line.startsWith('+++') && 'bg-green-500/10',
                line.startsWith('-') && !line.startsWith('---') && 'bg-red-500/10',
                line.startsWith('@@') && 'text-muted-foreground',
              )}
            >
              {line || ' '}
            </div>
          ))}
          {diff.truncated ? <div className="text-muted-foreground">… diff cut at 200,000 characters</div> : null}
        </pre>
      ) : null}
    </li>
  );
}
