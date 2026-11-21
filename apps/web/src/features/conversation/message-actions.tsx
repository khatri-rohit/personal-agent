'use client';

import { useCallback, useState } from 'react';
import {
  Check,
  Copy,
  Loader2,
  Pencil,
  RotateCcw,
  Square,
  Volume2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { toastError } from '@/hooks/use-toast';
import { copyText } from '@/lib/copy-text';
import { cn } from '@/lib/utils';
import { useReadAloudEnabled } from '@/lib/voice-prefs';
import { useReadAloud } from './read-aloud';

const ACTION_BUTTON =
  'type-caption h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground';

/** Play / stop this reply aloud. Rendered only when read-aloud is enabled. */
function ReadAloudButton({ id, content }: { id: string; content: string }) {
  const { status, toggle } = useReadAloud(id, content);
  const busy = status !== 'idle';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(ACTION_BUTTON, busy && 'text-foreground')}
          onClick={toggle}
          disabled={!content.trim()}
          aria-pressed={busy}
        >
          {status === 'loading' ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : status === 'playing' ? (
            <Square className="size-3 fill-current" aria-hidden />
          ) : (
            <Volume2 className="size-3.5" aria-hidden />
          )}
          {busy ? 'Stop' : 'Listen'}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {busy ? 'Stop reading aloud' : 'Read this reply aloud'}
      </TooltipContent>
    </Tooltip>
  );
}

export function MessageActions({
  content,
  readAloudId,
  align = 'start',
  showRetry = false,
  onRetry,
  showEdit = false,
  onEdit,
  disabled = false,
  className,
}: {
  content: string;
  /** Message id; when set and read-aloud is on, a Listen button appears. */
  readAloudId?: string;
  align?: 'start' | 'end';
  showRetry?: boolean;
  onRetry?: () => void | Promise<void>;
  showEdit?: boolean;
  onEdit?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const readAloudOn = useReadAloudEnabled();
  const [copied, setCopied] = useState(false);
  const [confirmRetry, setConfirmRetry] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!content) return;
    const ok = await copyText(content);
    if (!ok) {
      toastError(
        "Couldn't copy — your browser blocked clipboard access",
        'Copy failed',
      );
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [content]);

  const handleConfirmRetry = useCallback(async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry();
      setConfirmRetry(false);
    } catch {
      toastError('The retry request failed — nothing was changed', 'Retry failed');
    } finally {
      setRetrying(false);
    }
  }, [onRetry]);

  return (
    <div
      className={cn(
        'mt-1 flex flex-wrap items-center gap-0.5',
        align === 'end' ? 'justify-end' : 'justify-start',
        className,
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="type-caption h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
            onClick={() => void handleCopy()}
            disabled={!content.trim()}
          >
            {copied ? (
              <Check className="size-3.5" aria-hidden />
            ) : (
              <Copy className="size-3.5" aria-hidden />
            )}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy message</TooltipContent>
      </Tooltip>

      {readAloudOn && readAloudId ? (
        <ReadAloudButton id={readAloudId} content={content} />
      ) : null}

      {showEdit && onEdit && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="type-caption h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
              onClick={onEdit}
              disabled={disabled}
            >
              <Pencil className="size-3.5" aria-hidden />
              Edit
            </Button>
          </TooltipTrigger>
          <TooltipContent>Edit and resend this prompt</TooltipContent>
        </Tooltip>
      )}

      {showRetry && !confirmRetry && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="type-caption h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
              onClick={() => setConfirmRetry(true)}
              disabled={disabled || retrying}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Retry
            </Button>
          </TooltipTrigger>
          <TooltipContent>Regenerate this response</TooltipContent>
        </Tooltip>
      )}

      {showRetry && confirmRetry && (
        <div
          className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1"
          role="status"
        >
          <span className="text-xs text-muted-foreground">
            Retry this response?
          </span>
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={retrying}
            onClick={() => void handleConfirmRetry()}
          >
            {retrying ? 'Retrying…' : 'Yes, retry'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={retrying}
            onClick={() => setConfirmRetry(false)}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
