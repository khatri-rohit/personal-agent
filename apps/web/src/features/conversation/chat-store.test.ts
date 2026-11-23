import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agent/agent-models';
import { applyChatEvent, initialChatState } from './chat-store';

const runStarted: AgentEvent = {
  seq: 1,
  type: 'run.started',
  runId: 'parent-run',
  threadId: 'parent-thread',
  mode: 'workspace',
  model: 'parent-model',
  posture: 'agent',
};

describe('sub-agent activity', () => {
  it('keeps the resolved child model from subrun.started', () => {
    const running = applyChatEvent(initialChatState(), runStarted);
    const state = applyChatEvent(running, {
      seq: 2,
      type: 'subrun.started',
      runId: 'parent-run',
      subRunId: 'child-run',
      parentRunId: 'parent-run',
      subThreadId: 'child-thread',
      profile: 'explore',
      model: 'child-model',
      task: 'Find the model wiring',
    });

    expect(state.activeRun?.subagentActivity[0]).toMatchObject({
      subRunId: 'child-run',
      model: 'child-model',
      status: 'running',
    });
  });
});
