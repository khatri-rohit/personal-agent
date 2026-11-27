'use client';

import { Link, useNavigate } from 'react-router';
import { useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  Link2,
  MoreHorizontal,
  Pencil,
  Pin,
  Trash2,
} from 'lucide-react';
import { type ThreadDetail } from '@agent/agent-models';
import { clampChatTitle } from '@/features/threads/thread-title';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { copyText } from '@/lib/copy-text';
import { toastError, toastSuccess } from '@/hooks/use-toast';
import { fetchThread } from '../../api/thread-client';
import {
  getThreadsSnapshot,
  removeThread,
  subscribeThreads,
  updateThread,
} from '../threads/thread-cache';
import { folderNameFromRoot, setWorkspaceRoot } from '../threads/space-store';

/** How often a running parent is re-checked, so its dot clears when it ends. */
const PARENT_POLL_MS = 5000;

/**
 * Thread header as one breadcrumb line: Space / [Parent ●] / [profile] Thread ⋯
 *
 * Ancestors are quiet links; the current thread is the h1. A sub-agent
 * thread names its profile and shows whether its parent is still running
 * (sub-agents cannot nest, so there is at most one parent). The menu holds
 * the thread actions that otherwise live only in the sidebar.
 */
export function ChatHeader({ threadId }: { threadId: string }) {
  const [thread, setThread] = useState<ThreadDetail | undefined>();
  const [parentThread, setParentThread] = useState<ThreadDetail | undefined>();
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Catalog updates carry the plain row; keep the detail fields
    // (profile, running) the single-thread fetch added.
    const apply = (next: ThreadDetail | undefined) => {
      if (cancelled || !next) return;
      setThread((prev) => (prev?.id === next.id ? { ...prev, ...next } : next));
    };

    void fetchThread(threadId).then(apply);
    const unsub = subscribeThreads(() => {
      apply(getThreadsSnapshot().find((item) => item.id === threadId));
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [threadId]);

  // Parent of a sub-agent thread: fetched once, then re-checked only while
  // it is running, so the live dot clears when the parent run ends.
  const parentId = thread?.parentThreadId;
  useEffect(() => {
    if (!parentId) {
      setParentThread(undefined);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      const parent = await fetchThread(parentId).catch(() => undefined);
      if (cancelled) return;
      if (parent) setParentThread(parent);
      if (parent?.running) timer = window.setTimeout(load, PARENT_POLL_MS);
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [parentId]);

  const title = thread?.title ?? 'New Chat';
  const isPending = title === 'New Chat';
  const display = isPending ? title : clampChatTitle(title);

  // The space comes from the thread, or from its parent for a sub-agent
  // thread (children run in the parent's workspace).
  const spaceThread = parentId ? (parentThread ?? thread) : thread;
  const workspaceRoot =
    spaceThread?.kind === 'workspace' ? (spaceThread.workspaceRoot ?? null) : null;
  const spaceName = workspaceRoot ? folderNameFromRoot(workspaceRoot) : 'Home';

  // Dynamic browser tab title so each open tab identifies its thread.
  useEffect(() => {
    if (!thread) return;
    document.title = isPending
      ? 'New Chat · Personal Assistant'
      : `${clampChatTitle(title)} · Personal Assistant`;
    return () => {
      document.title = 'Personal Assistant';
    };
  }, [thread, isPending, title]);

  return (
    <header className="shrink-0 border-b border-border/40 px-5 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-body)] leading-snug">
            <li className="max-w-[14rem] shrink-0 truncate">
              <Link
                to="/"
                title={workspaceRoot ?? 'Home'}
                onClick={() => setWorkspaceRoot(workspaceRoot)}
                className="crumb-link"
              >
                {spaceName}
              </Link>
            </li>
            {parentId ? (
              <>
                <CrumbSeparator />
                <li className="flex min-w-0 max-w-[40%] shrink items-center gap-1.5">
                  <Link
                    to={`/chat/${parentId}`}
                    title={parentThread?.title}
                    className="crumb-link truncate"
                  >
                    {parentThread ? clampChatTitle(parentThread.title) : 'Parent thread'}
                  </Link>
                  {parentThread?.running ? (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-primary"
                      role="img"
                      aria-label="Parent run in progress"
                      title="Parent run in progress"
                    />
                  ) : null}
                </li>
              </>
            ) : null}
            <CrumbSeparator />
            <li className="flex min-w-0 flex-1 items-center gap-2" aria-current="page">
              {thread?.subagentProfile ? (
                <span
                  className="type-caption shrink-0 rounded-md border border-border/60 px-1.5 py-0.5 font-medium text-muted-foreground"
                  title={`Sub-agent profile: ${thread.subagentProfile}`}
                >
                  {thread.subagentProfile}
                </span>
              ) : null}
              {isEditing && thread ? (
                <RenameField
                  initial={display}
                  onDone={async (next) => {
                    setIsEditing(false);
                    if (next && next !== display) {
                      await updateThread(thread.id, { title: next });
                    }
                  }}
                />
              ) : (
                <h1
                  className="truncate font-semibold tracking-tight text-foreground"
                  title={isPending ? undefined : title}
                >
                  {isPending ? (
                    <span className="font-normal text-muted-foreground">Untitled</span>
                  ) : (
                    display
                  )}
                </h1>
              )}
            </li>
          </ol>
        </nav>
        {thread ? (
          <ThreadMenu
            thread={thread}
            canRename={!isPending}
            onRename={() => setIsEditing(true)}
          />
        ) : null}
      </div>
    </header>
  );
}

function CrumbSeparator() {
  return (
    <li aria-hidden className="shrink-0 select-none text-subtle-foreground/70">
      /
    </li>
  );
}

/** Inline title edit in place of the h1. Enter or blur saves, Escape cancels. */
function RenameField({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (next: string | null) => void | Promise<void>;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    void onDone(next?.trim() || null);
  };

  return (
    <input
      ref={ref}
      value={value}
      aria-label="Rename chat"
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(value);
        if (event.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(value)}
      className="min-w-0 flex-1 rounded-md border border-border/60 bg-background px-1.5 py-0.5 font-semibold tracking-tight text-foreground outline-none focus-visible:border-ring/60"
    />
  );
}

/** Thread actions that otherwise live only in the sidebar row menu. */
function ThreadMenu({
  thread,
  canRename,
  onRename,
}: {
  thread: ThreadDetail;
  canRename: boolean;
  onRename: () => void;
}) {
  const navigate = useNavigate();
  const isPinned = Boolean(thread.pinned);
  const href = `/chat/${thread.id}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Thread options"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent/70 data-[state=open]:text-foreground"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" className="w-48">
        <DropdownMenuItem
          onSelect={() => void updateThread(thread.id, { pinned: !isPinned })}
        >
          <Pin className="size-4" />
          {isPinned ? 'Unpin' : 'Pin'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRename} disabled={!canRename}>
          <Pencil className="size-4" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            void copyText(new URL(href, window.location.origin).toString()).then(
              (ok) => ok
                ? toastSuccess('The thread link is on your clipboard.', 'Link copied')
                : toastError('Could not copy the link.'),
            );
          }}
        >
          <Link2 className="size-4" />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => window.open(href, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink className="size-4" />
          Open in new tab
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            void removeThread(thread.id).then(() => navigate('/'));
          }}
        >
          <Trash2 className="size-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
