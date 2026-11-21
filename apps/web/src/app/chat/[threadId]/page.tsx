'use client';

import { useCallback, use, useEffect, useRef } from 'react';
import { normalizeRunPosture } from '@agent/agent-models';
import { ChatHeader } from '@/features/conversation/chat-header';
import { MessageList } from '@/features/conversation/message-list';
import { ChatInput } from '@/features/composer/chat-input';
import { LiveDock } from '@/features/conversation/live-dock';
import { stopReadAloud } from '@/features/conversation/read-aloud';
import { ChatShell } from '@/components/shell/chat-shell';
import { useAgentRun } from '@/features/conversation/use-agent-run';
import { takePendingMessage } from '@/api/agent-client';
import { resolveOllamaModel } from '@/features/composer/ollama-models';

export default function ChatThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = use(params);
  const {
    messages,
    chatState,
    sendMessage,
    sendQueuedNow,
    editQueuedMessage,
    queuedMessage,
    composerOptions,
    setComposerOptions,
    isRunning,
    stopGeneration,
    resolvePendingChoice,
    retryLastResponse,
    editLastUserMessage,
    threadKind,
    isSubagentThread,
  } = useAgentRun(threadId);
  const sentPendingRef = useRef(false);

  // Read-aloud follows the thread: leaving it removes the Stop button, so the
  // page stops playback rather than leaving audio nobody can reach.
  useEffect(() => () => stopReadAloud(), [threadId]);

  useEffect(() => {
    if (sentPendingRef.current) return;
    const pending = takePendingMessage();
    if (!pending) return;
    sentPendingRef.current = true;
    const local = pending.local === true;
    const model = resolveOllamaModel(pending.model ?? '', local);
    setComposerOptions({
      webSearch: pending.webSearch ?? true,
      local,
      model,
      thinking: pending.thinking,
      posture: normalizeRunPosture(pending.posture),
      contextWindowMode: pending.contextWindowMode ?? 'default',
    });
    void sendMessage(
      pending.content,
      {
        webSearch: pending.webSearch ?? true,
        local,
        model,
        thinking: pending.thinking,
        posture: normalizeRunPosture(pending.posture),
        ...(pending.skills ? { skills: pending.skills } : {}),
        contextWindowMode: pending.contextWindowMode ?? 'default',
      },
      pending.attachments,
    );
  }, [sendMessage, setComposerOptions]);

  const onContinue = useCallback(
    () => sendMessage('Continue from where the last run stopped.'),
    [sendMessage],
  );

  return (
    <ChatShell
      header={<ChatHeader threadId={threadId} />}
      footer={
        <div className="relative flex min-w-0 flex-col">
          {/* Zone 2 — the live dock: one fixed-height line in flow above
              the composer. In flow, not overlaid: an overlay covers whatever
              the reader has open at the bottom of the transcript (an
              expanded tool group). The transcript shortens by one line when
              a run starts and grows back when it ends. The open question is
              Zone 3 and lives inline in the conversation (MessageList). */}
          {isRunning ? (
            <div className="relative z-10 px-4 pt-2 sm:px-6">
              <div className="reading-text-width">
                <LiveDock
                  phase={
                    chatState.pendingChoices.length > 0
                      ? 'waiting'
                      : chatState.compactionNotice?.status === 'running'
                        ? 'compacting'
                        : 'working'
                  }
                  plan={chatState.plan}
                  subagents={chatState.activeRun?.subagentActivity ?? []}
                  {...(chatState.activeRun?.runStartedAt
                    ? { runStartedAt: chatState.activeRun.runStartedAt }
                    : {})}
                />
              </div>
            </div>
          ) : null}
          {isSubagentThread ? (
            <div className="px-4 py-3 text-center text-xs text-muted-foreground">
              Sub-agent thread — read-only
            </div>
          ) : (
          <ChatInput
            key={threadId}
            draftScope={threadId}
            threadId={threadId}
            onSend={sendMessage}
            isRunning={isRunning}
            queuedMessage={queuedMessage}
            onSendQueuedNow={() => void sendQueuedNow()}
            onEditQueued={editQueuedMessage}
            composerOptions={composerOptions}
            showPostureChips={threadKind === 'workspace'}
            onComposerOptionsChange={setComposerOptions}
            onStop={() => void stopGeneration()}
            activeRun={chatState.activeRun}
            choicePending={chatState.pendingChoices.length > 0}
          />
          )}
        </div>
      }
    >
      <MessageList
        messages={messages}
        chatState={chatState}
        isRunning={isRunning}
        threadKind={threadKind}
        onRetryLastResponse={retryLastResponse}
        onEditLastUserMessage={editLastUserMessage}
        onResolveChoice={resolvePendingChoice}
        {...(isSubagentThread
          ? {}
          : { onContinue })}
      />
    </ChatShell>
  );
}
