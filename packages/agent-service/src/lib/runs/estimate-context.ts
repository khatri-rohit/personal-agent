import type { ContextReport, LedgerEnvelope, StartRunRequest } from '@agent/agent-models';
import {
  HOME_MODE,
  normalizeRunPosture,
  parseContextWindowMode,
  parseMessageAttachments,
  type RunPosture,
} from '@agent/agent-models';
import { extraSkillRoots, runWithSkillRoots } from '@agent/agent-core';

import { ServiceError } from '../errors';
import type { AgentService } from '../service';
import { endpointFromLocal, prepareRun, resolveRequestedSkills } from './run-context';

export type ContextEstimate = {
  estimatedPromptTokens: number;
  contextLength: number;
  source: 'estimate';
  contextReport: ContextReport;
};

/**
 * What a run would send, without starting one: the same assembler as a run
 * (host ledger, memory files, skills, the optional draft). `body` is the
 * request as sent; unknown thread → not_found, bad attachments → invalid.
 */
export async function estimateContext(service: AgentService, body: unknown): Promise<ContextEstimate> {
  const {
    threadId,
    draft,
    attachments,
    model,
    webSearch,
    local,
    posture,
    skills: rawSkills,
    contextWindowMode,
  } = body as {
    threadId?: string;
    draft?: string;
    attachments?: unknown;
    model?: string;
    webSearch?: boolean;
    local?: boolean;
    posture?: RunPosture;
    skills?: StartRunRequest['skills'];
    contextWindowMode?: unknown;
  };
  const previewWindowMode = parseContextWindowMode(contextWindowMode);
  const parsedAttachments = parseMessageAttachments(attachments);
  if (typeof parsedAttachments === 'string') {
    throw new ServiceError('invalid', parsedAttachments);
  }

  const store = await service.threads();
  let envelopes: LedgerEnvelope[] = [];
  const id =
    typeof threadId === 'string' && threadId.trim() ? threadId.trim() : 'draft';

  if (id !== 'draft') {
    const thread = store.getThread(id);
    if (!thread) throw new ServiceError('not_found', 'Thread not found');
    envelopes = await store.hydrateEnvelopes(id);
  }

  const estimateThread = id === 'draft' ? undefined : store.getThread(id);
  const useModel = model ?? estimateThread?.model ?? HOME_MODE.model;
  // Same skill roots a run in this thread sees (its workspace's packs).
  const skillRoots = extraSkillRoots(estimateThread?.workspaceRoot);
  const { report } = await runWithSkillRoots(skillRoots, () => {
    // The draft as the user row a send would write: its words, attachments
    // and named skills (references, as in a real send).
    const trimmed = typeof draft === 'string' ? draft.trim() : '';
    const selected = resolveRequestedSkills(rawSkills);
    if (trimmed || parsedAttachments.length > 0 || selected.length > 0) {
      envelopes = [
        ...envelopes,
        {
          v: 1,
          seq: (envelopes.at(-1)?.seq ?? 0) + 1,
          ts: new Date().toISOString(),
          threadId: id,
          runId: null,
          record: { role: 'user', content: trimmed },
          ...(parsedAttachments.length > 0 ? { attachments: parsedAttachments } : {}),
          ...(selected.length > 0 ? { skills: { selected } } : {}),
        },
      ];
    }
    return prepareRun(service, {
      threadId: id,
      thread: estimateThread,
      webSearch,
      posture: normalizeRunPosture(posture),
      lastUserSeq: store.lastUserSeq(envelopes) ?? 0,
      envelopes,
      model: useModel,
      endpoint: endpointFromLocal(local),
      ...(previewWindowMode ? { contextWindowMode: previewWindowMode } : {}),
    });
  });

  return {
    estimatedPromptTokens: report.occupiedTokens,
    contextLength: report.budget.windowTokens,
    source: 'estimate' as const,
    contextReport: report,
  };
}
