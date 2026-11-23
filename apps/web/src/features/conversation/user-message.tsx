'use client';

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Message } from '@agent/agent-models';
import { imageAttachments, threadMentions } from '@agent/agent-models';
import { ThreadMentionChip } from '@/features/composer/thread-mention-picker';
import { MessageActions } from '@/features/conversation/message-actions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { formatMessageTime } from '@/lib/format-relative-time';

const PROMPT_PREVIEW_LINES = 10;

export const UserMessage = memo(function UserMessage({
  message,
  canEdit,
  hasResponseBelow,
  changedFiles = 0,
  onEditSubmit,
}: {
  message: Message;
  canEdit: boolean;
  hasResponseBelow: boolean;
  /** Files the reply below changed (checkpoint): resending offers to put them back. */
  changedFiles?: number;
  onEditSubmit: (messageId: string, content: string, restoreFiles?: boolean) => void | Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [confirmClear, setConfirmClear] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [previewMaxHeight, setPreviewMaxHeight] = useState<number>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const promptRef = useRef<HTMLParagraphElement>(null);
  const promptId = `user-prompt-${message.id}`;

  useEffect(() => {
    if (!isEditing) setDraft(message.content);
  }, [message.content, isEditing]);

  useLayoutEffect(() => {
    const prompt = promptRef.current;
    if (!prompt || isEditing) return;

    setIsExpanded(false);
    const measurePrompt = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(prompt).lineHeight);
      const maxHeight = Number.isFinite(lineHeight)
        ? Math.ceil(lineHeight * PROMPT_PREVIEW_LINES)
        : undefined;
      setPreviewMaxHeight(maxHeight);
      setIsOverflowing(
        maxHeight !== undefined && prompt.scrollHeight > maxHeight + 1,
      );
    };

    measurePrompt();
    const observer = new ResizeObserver(measurePrompt);
    observer.observe(prompt);
    return () => observer.disconnect();
  }, [isEditing, message.content]);

  useEffect(() => {
    if (isEditing) textareaRef.current?.focus();
  }, [isEditing]);

  const startEdit = useCallback(() => {
    setDraft(message.content);
    setConfirmClear(false);
    setIsEditing(true);
  }, [message.content]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    setConfirmClear(false);
    setDraft(message.content);
  }, [message.content]);

  const hasAttachments = (message.attachments?.length ?? 0) > 0;
  const canResend = Boolean(draft.trim()) || hasAttachments;
  const sentAt = formatMessageTime(message.createdAt);

  const runSubmit = useCallback(async (restoreFiles = false) => {
    const trimmed = draft.trim();
    if ((!trimmed && !hasAttachments) || submitting) return;
    setSubmitting(true);
    try {
      await onEditSubmit(message.id, trimmed, restoreFiles);
      setIsEditing(false);
      setConfirmClear(false);
    } finally {
      setSubmitting(false);
    }
  }, [draft, hasAttachments, message.id, onEditSubmit, submitting]);

  const handleResend = useCallback(() => {
    if (!canResend) return;
    if (hasResponseBelow) {
      setConfirmClear(true);
      return;
    }
    void runSubmit();
  }, [canResend, hasResponseBelow, runSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleResend();
      }
    },
    [cancelEdit, handleResend],
  );

  return (
    <div
      className="min-w-0 max-w-full"
    >
      {isEditing ? (
        <div
          className="rounded-lg bg-muted/45 p-3 ring-1 ring-border/40"
          role="form"
          aria-label="Edit message"
        >
          {message.attachments && message.attachments.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5 px-0.5">
              {threadMentions(message.attachments).map((mention) => (
                <ThreadMentionChip key={mention.id} mention={mention} />
              ))}
              {imageAttachments(message.attachments).map((attachment) => (
                <img
                  key={attachment.id}
                  src={attachment.dataUrl}
                  alt={attachment.name ?? 'Attachment'}
                  className="size-14 rounded-lg object-cover ring-1 ring-border/40"
                />
              ))}
            </div>
          ) : null}
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={4}
            className="type-user h-24 min-h-24 resize-none border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0"
          />
          {confirmClear ? (
            <div
              className="mt-2 space-y-2 rounded-lg bg-background/60 px-3 py-2.5 ring-1 ring-border/50"
              role="alertdialog"
              aria-labelledby={`edit-clear-title-${message.id}`}
            >
              <p
                id={`edit-clear-title-${message.id}`}
                className="type-ui text-foreground/90"
              >
                Resending will remove the assistant response for this turn.
              </p>
              <p className="type-caption text-muted-foreground">
                {changedFiles > 0
                  ? `That response changed ${changedFiles} file${changedFiles === 1 ? '' : 's'}. Put them back as they were, or keep them as they are now?`
                  : 'Your edited prompt will be sent again from this point in the thread.'}
              </p>
              <div className="flex flex-wrap justify-end gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={submitting}
                  onClick={() => setConfirmClear(false)}
                >
                  Cancel
                </Button>
                {changedFiles > 0 ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={submitting || !canResend}
                      onClick={() => void runSubmit(false)}
                    >
                      Keep files and resend
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={submitting || !canResend}
                      onClick={() => void runSubmit(true)}
                    >
                      {submitting ? 'Sending…' : 'Restore files and resend'}
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={submitting || !canResend}
                    onClick={() => void runSubmit()}
                  >
                    {submitting ? 'Sending…' : 'Proceed'}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap justify-end gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={submitting}
                onClick={cancelEdit}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={submitting || !canResend}
                onClick={handleResend}
              >
                Resend
              </Button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* The user's prompt: a raised fill, full-strength text, no
              outline. The fill alone separates it from replies; a bright
              ring added a hard frame per turn that pulled the eye down the
              page. */}
          <div
            className={cn(
              'type-user min-w-0 max-w-full overflow-hidden rounded-lg bg-muted px-4 py-3 text-foreground',
            )}
          >
            {message.attachments && message.attachments.length > 0 ? (
              <div className="mb-2.5 flex flex-wrap gap-1.5">
                {threadMentions(message.attachments).map((mention) => (
                  <ThreadMentionChip key={mention.id} mention={mention} />
                ))}
                {imageAttachments(message.attachments).map((attachment) => (
                  <button
                    key={attachment.id}
                    type="button"
                    className="block size-20 overflow-hidden rounded-lg ring-1 ring-border/40 transition hover:ring-border"
                    aria-label={attachment.name ?? 'Open attached image'}
                    onClick={() => {
                      try {
                        const [header, data] = attachment.dataUrl.split(',');
                        const mime =
                          /data:([^;]+)/.exec(header)?.[1] ??
                          'application/octet-stream';
                        const binary = atob(data ?? '');
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) {
                          bytes[i] = binary.charCodeAt(i);
                        }
                        const url = URL.createObjectURL(
                          new Blob([bytes], { type: mime }),
                        );
                        window.open(url, '_blank', 'noopener,noreferrer');
                        setTimeout(() => URL.revokeObjectURL(url), 60_000);
                      } catch {
                        window.open(attachment.dataUrl, '_blank');
                      }
                    }}
                  >
                    <img
                      src={attachment.dataUrl}
                      alt={attachment.name ?? 'Attachment'}
                      className="size-full object-cover"
                    />
                  </button>
                ))}
              </div>
            ) : null}
            {message.content ? (
              <>
                <div className="relative">
                  <p
                    ref={promptRef}
                    id={promptId}
                    className="min-w-0 overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-[1.55]"
                    style={{
                      maxHeight:
                        isOverflowing && !isExpanded
                          ? previewMaxHeight
                          : undefined,
                    }}
                  >
                    {message.content}
                  </p>
                  {isOverflowing && !isExpanded ? (
                    <div
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-muted via-muted/80 to-transparent"
                      aria-hidden="true"
                    />
                  ) : null}
                </div>
                {isOverflowing ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="type-ui mt-1 h-8 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                    aria-expanded={isExpanded}
                    aria-controls={promptId}
                    onClick={() => setIsExpanded((expanded) => !expanded)}
                  >
                    {isExpanded ? 'Show less' : 'Show more'}
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
            {sentAt ? (
              <time
                dateTime={message.createdAt}
                className="type-caption text-subtle-foreground tabular-nums"
              >
                {sentAt}
              </time>
            ) : null}
            <div className="flex min-w-0 items-center">
              <MessageActions
                content={message.content}
                align="start"
                showEdit={canEdit}
                onEdit={startEdit}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
});
