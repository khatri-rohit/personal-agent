import { describe, expect, it } from 'vitest';

import { answerStyleMetrics, checkStyle, sentencesOf } from './style';

describe('sentencesOf', () => {
  it('splits lines and sentences, and skips code and quotes', () => {
    expect(sentencesOf('- Run the check. Then report.\n```ts\nconst a = "x. y";\n```\nSay "may be. maybe" once.')).toEqual([
      'Run the check.',
      'Then report.',
      'Say X once.',
    ]);
  });
});

describe('checkStyle', () => {
  it('flags long sentences, hedges and filler', () => {
    const long = Array.from({ length: 26 }, () => 'word').join(' ');
    const kinds = checkStyle(`${long}. You may want to retry. Hope this helps.`).map((issue) => issue.kind);
    expect(kinds).toEqual(['long_sentence', 'hedge', 'hedge', 'filler']);
  });

  it('checks glossary terms only when asked, and not inside identifiers', () => {
    expect(checkStyle('Open a new chat.', { glossary: true })).toMatchObject([{ kind: 'term', avoid: 'chat', term: 'thread' }]);
    expect(checkStyle('Open a new chat.')).toEqual([]);
    expect(checkStyle('Call session_search first.', { glossary: true })).toEqual([]);
  });
});

describe('answerStyleMetrics', () => {
  it('counts sentences and spots a preamble', () => {
    const metrics = answerStyleMetrics("Let me check. The test fails at line 40. It is very flaky.");
    expect(metrics).toMatchObject({ sentences: 3, hedges: 1, preamble: true, longSentences: 0 });
  });
});
