/**
 * The harness's writing rules, as data and one checker. They follow the
 * ASD-STE100 (Simplified Technical English) writing rules, adapted for text a
 * model reads: one instruction per sentence, one term per concept, active
 * voice, short sentences, no hedges. The goal is precision: an instruction
 * with one meaning keeps the model on the request.
 *
 * The rules cover prose only. Code, commands, paths, quoted text and tool
 * names keep their exact form, so the checker skips fenced code, inline code
 * and quoted strings.
 */

/** Longest sentence the harness writes, in words. */
export const STYLE_MAX_SENTENCE_WORDS = 25;

/**
 * One term per concept in text the harness writes to the model. `avoid`
 * lists the words that name the same concept and must not be used for it.
 */
export const GLOSSARY: ReadonlyArray<{ term: string; meaning: string; avoid: readonly string[] }> = [
  {
    term: 'thread',
    meaning: 'One line of messages between the user and the agent, stored as one ledger.',
    avoid: ['chat', 'session'],
  },
  {
    term: 'run',
    meaning: 'One agent loop started by one user message: model calls and tool calls until it ends.',
    avoid: [],
  },
  {
    term: 'step',
    meaning: 'One model call and the tool calls it makes.',
    avoid: ['iteration'],
  },
  {
    term: 'tool result',
    meaning: 'What a tool call returns to the model.',
    avoid: ['tool output'],
  },
  {
    term: 'skill',
    meaning: 'A SKILL.md folder of instructions the model loads with load_skill.',
    avoid: ['skill pack', 'procedure pack'],
  },
  {
    term: 'sub-agent',
    meaning: 'A child run started with delegate; it reads and reports, and never writes.',
    avoid: ['subagent', 'child agent'],
  },
  {
    term: 'folder',
    meaning: 'The workspace folder a Workspace thread is bound to.',
    avoid: ['repo', 'repository'],
  },
  {
    term: 'check',
    meaning: 'A project command that verifies edits: build, typecheck, test or lint.',
    avoid: [],
  },
];

/**
 * Words that make an instruction weaker or vaguer without adding a fact.
 * "may" and "might" are on the list because each has two meanings
 * (permission and possibility); write "can" or state the condition.
 */
export const HEDGE_WORDS: readonly string[] = [
  'perhaps',
  'maybe',
  'might',
  'may',
  'possibly',
  'probably',
  'ideally',
  'basically',
  'simply',
  'actually',
  'really',
  'very',
  'quite',
  'somewhat',
  'feel free',
  'try to',
  'you may want to',
  'it is recommended',
  'make sure to',
];

/** Openings and closings that carry no content in an answer. */
export const FILLER_PHRASES: readonly string[] = [
  'great question',
  "i'd be happy to",
  'i would be happy to',
  'certainly!',
  'absolutely!',
  'let me know if',
  'hope this helps',
  'feel free to ask',
  'in conclusion',
];

export type StyleIssue =
  | { kind: 'long_sentence'; words: number; sentence: string }
  | { kind: 'hedge'; word: string; sentence: string }
  | { kind: 'filler'; phrase: string; sentence: string }
  | { kind: 'term'; avoid: string; term: string; sentence: string };

/** Prose only: fenced code, inline code and quoted text become a placeholder word. */
export function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, 'X')
    .replace(/"[^"\n]*"/g, 'X')
    .replace(/“[^”\n]*”/g, 'X');
}

/**
 * The sentences of a text: each line is its own unit (a list item, a
 * heading), split again at a full stop, question mark or exclamation mark
 * followed by a space. Markdown list and heading markers are dropped.
 */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of proseOf(text).split('\n')) {
    const line = rawLine.replace(/^\s*(?:[-*]|\d+\.|#+)\s+/, '').trim();
    if (!line) continue;
    for (const part of line.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/)) {
      const sentence = part.trim();
      if (sentence) out.push(sentence);
    }
  }
  return out;
}

function wordCount(sentence: string): number {
  return sentence.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length;
}

function containsPhrase(sentence: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Letters, digits, `_` and `'` join a word: `session_search` is a tool name, not "session".
  return new RegExp(`(^|[^A-Za-z0-9_'])${escaped}($|[^A-Za-z0-9_'])`, 'i').test(sentence);
}

/**
 * Check text against the writing rules. `glossary` is for text the harness
 * writes to the model (the terms must not change); leave it off for a
 * model's answer, where the user's own words are fine.
 */
export function checkStyle(
  text: string,
  options: { maxWords?: number; glossary?: boolean } = {},
): StyleIssue[] {
  const maxWords = options.maxWords ?? STYLE_MAX_SENTENCE_WORDS;
  const issues: StyleIssue[] = [];
  for (const sentence of sentencesOf(text)) {
    const words = wordCount(sentence);
    if (words > maxWords) issues.push({ kind: 'long_sentence', words, sentence });
    for (const word of HEDGE_WORDS) {
      if (containsPhrase(sentence, word)) issues.push({ kind: 'hedge', word, sentence });
    }
    for (const phrase of FILLER_PHRASES) {
      if (containsPhrase(sentence, phrase)) issues.push({ kind: 'filler', phrase, sentence });
    }
    if (options.glossary) {
      for (const entry of GLOSSARY) {
        for (const avoid of entry.avoid) {
          if (containsPhrase(sentence, avoid)) issues.push({ kind: 'term', avoid, term: entry.term, sentence });
        }
      }
    }
  }
  return issues;
}

/** Counts for a model's answer, for the eval: how far it is from the writing rules. */
export type AnswerStyleMetrics = {
  sentences: number;
  /** Mean words per sentence. */
  meanWords: number;
  longSentences: number;
  hedges: number;
  filler: number;
  /** The answer opens with filler or a restated plan instead of the result. */
  preamble: boolean;
};

const PREAMBLE_RE = /^(great question|sure[,!]|certainly|absolutely|of course|i'?ll |i will |let me |let's |okay[,!]|ok[,!]|alright)/i;

export function answerStyleMetrics(text: string): AnswerStyleMetrics {
  const sentences = sentencesOf(text);
  const issues = checkStyle(text);
  const totalWords = sentences.reduce((sum, sentence) => sum + wordCount(sentence), 0);
  return {
    sentences: sentences.length,
    meanWords: sentences.length > 0 ? Math.round((totalWords / sentences.length) * 10) / 10 : 0,
    longSentences: issues.filter((issue) => issue.kind === 'long_sentence').length,
    hedges: issues.filter((issue) => issue.kind === 'hedge').length,
    filler: issues.filter((issue) => issue.kind === 'filler').length,
    preamble: PREAMBLE_RE.test(text.trim()),
  };
}
