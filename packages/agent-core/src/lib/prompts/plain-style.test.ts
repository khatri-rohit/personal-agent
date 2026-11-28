import { describe, expect, it } from 'vitest';

import { checkStyle, HOME_MODE, WORKSPACE_MODE, type StyleIssue } from '@agent/agent-models';

import {
  ATTACHMENTS_CLOSE,
  ATTACHMENTS_OPEN,
  CARD_HEADER,
  HARNESS_CONTEXT_CLOSE,
  HARNESS_CONTEXT_OPEN,
  HARNESS_NOTE_PREFIX,
  RECORD_MESSAGE_PREFIX,
} from '../context/message-origin';
import { ADVISOR_HINT, BUDGET_NUDGE, OPEN_PLAN_WORK_NUDGE } from '../loop/steering-notes';
import { failedCheckNote, STOP_CHECK_NOTE } from '../loop/turn-finish';
import { createDelegateTool } from '../subagent/delegate';
import { listSubagentProfiles } from '../subagent/profiles';
import { buildAdvisorQuestion, buildBrief, buildSubagentPrompt, createReportTool } from '../subagent/prompt';
import { createMemoryTool } from '../tools/memory';
import { createInMemoryPlanStore, createPlanTools } from '../tools/plan';
import { createReadThreadTool } from '../tools/read-thread';
import { createToolRegistry, listTools } from '../tools/registry';
import { createSessionSearchTool } from '../tools/session-search';
import { formatSkillsCatalog } from '../tools/skills';
import { MASKED_CHECK_NOTE } from '../tools/traits';
import type { Tool } from '../tools/types';
import { buildSystemPrompt } from './system-prompt';

/**
 * Every text the harness writes to the model follows the writing rules in
 * agent-models style.ts: sentences of at most 25 words, no hedges or filler,
 * and the glossary's one term per concept. A failure lists each sentence
 * and the rule it breaks.
 */

const hostTools: Tool[] = [
  ...createPlanTools(createInMemoryPlanStore('t1')),
  createSessionSearchTool(async () => []),
  createReadThreadTool({ read: async () => null }),
  createMemoryTool({
    read: async () => ({ user: '', notes: '' }),
    apply: async () => {
      throw new Error('not used');
    },
  } as unknown as Parameters<typeof createMemoryTool>[0]),
  createDelegateTool(listSubagentProfiles()),
  createDelegateTool(listSubagentProfiles(), { siblingBriefs: true }),
  createReportTool(() => undefined),
];

const allTools = [...listTools(), ...hostTools];

function descriptions(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) descriptions(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'description' && typeof item === 'string') out.push(item);
      else descriptions(item, out);
    }
  }
  return out;
}

function toolTexts(tool: Tool): string[] {
  return [
    ...descriptions(tool.definition),
    ...tool.guidance.whenToUse,
    ...tool.guidance.whenNotToUse,
    ...tool.guidance.usage,
  ];
}

function harnessTexts(): Map<string, string> {
  const texts = new Map<string, string>();
  const home = createToolRegistry(allTools, [...HOME_MODE.globalTools, ...HOME_MODE.allowedTools], 'agent');
  for (const posture of ['agent', 'ask', 'plan'] as const) {
    const workspace = createToolRegistry(allTools, [...WORKSPACE_MODE.globalTools, ...WORKSPACE_MODE.allowedTools], posture);
    for (const stateCard of [true, false]) {
      texts.set(`workspace ${posture} card=${stateCard}`, buildSystemPrompt(workspace, 'workspace', posture, { stateCard }));
    }
  }
  texts.set('home', buildSystemPrompt(home, 'home'));
  texts.set('home compact', buildSystemPrompt(home, 'home', 'agent', { compactHome: true }));
  texts.set('skills catalog', formatSkillsCatalog([]));
  for (const tool of allTools) {
    toolTexts(tool).forEach((text, index) => texts.set(`tool ${tool.definition.function.name} #${index}`, text));
  }
  const notes: Record<string, string> = {
    HARNESS_NOTE_PREFIX,
    RECORD_MESSAGE_PREFIX,
    CARD_HEADER,
    HARNESS_CONTEXT_OPEN,
    HARNESS_CONTEXT_CLOSE,
    ATTACHMENTS_OPEN,
    ATTACHMENTS_CLOSE,
    OPEN_PLAN_WORK_NUDGE,
    BUDGET_NUDGE,
    ADVISOR_HINT,
    STOP_CHECK_NOTE,
    MASKED_CHECK_NOTE,
    failedCheckNote: failedCheckNote('npm test', 1),
  };
  for (const [name, text] of Object.entries(notes)) texts.set(`note ${name}`, text);
  for (const profile of listSubagentProfiles()) {
    texts.set(`profile ${profile.name}`, profile.prompt);
    texts.set(
      `sub-agent prompt ${profile.name}`,
      buildSubagentPrompt({ profile, toolNames: ['read_file', 'record_finding', 'report'], workspaceRoot: '/w' }),
    );
  }
  const spec = { profile: 'explore', objective: 'Find X', scope: 'src/', thoroughness: 'medium' as const };
  texts.set('brief', buildBrief(spec, 'Fix the bug', undefined, [{ objective: 'Find Y', paths: ['a.ts'] }]));
  texts.set('advisor question', buildAdvisorQuestion(spec));
  return texts;
}

function describeIssue(issue: StyleIssue): string {
  switch (issue.kind) {
    case 'long_sentence':
      return `${issue.words} words: ${issue.sentence}`;
    case 'hedge':
      return `hedge "${issue.word}": ${issue.sentence}`;
    case 'filler':
      return `filler "${issue.phrase}": ${issue.sentence}`;
    case 'term':
      return `"${issue.avoid}" (use "${issue.term}"): ${issue.sentence}`;
  }
}

describe('harness text follows the writing rules', () => {
  it('has no long sentences, hedges, filler or off-glossary terms', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const [label, text] of harnessTexts()) {
      for (const issue of checkStyle(text, { glossary: true })) {
        const line = describeIssue(issue);
        if (seen.has(line)) continue;
        seen.add(line);
        problems.push(`[${label}] ${line}`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
