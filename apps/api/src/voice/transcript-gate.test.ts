import { describe, expect, it } from 'vitest';

import { MAX_CONTEXT_CHARS, buildPrompt, gatedText } from './transcript-gate';

describe('gatedText', () => {
  it('keeps confident speech segments', () => {
    expect(
      gatedText({
        segments: [
          { text: ' Open the voice routes. ', no_speech_prob: 0.05, avg_logprob: -0.2 },
          { text: 'Then run the tests.', no_speech_prob: 0.1, avg_logprob: -0.3 },
        ],
      }),
    ).toBe('Open the voice routes. Then run the tests.');
  });

  it('drops a silence hallucination (high no-speech AND low confidence)', () => {
    expect(
      gatedText({
        segments: [{ text: 'Thank you.', no_speech_prob: 0.9, avg_logprob: -1.4 }],
      }),
    ).toBe('');
  });

  it('keeps quiet but confident speech even with high no-speech probability', () => {
    expect(
      gatedText({
        segments: [{ text: 'quietly said', no_speech_prob: 0.8, avg_logprob: -0.4 }],
      }),
    ).toBe('quietly said');
  });

  it('drops a decoder loop by compression ratio', () => {
    expect(
      gatedText({
        segments: [
          { text: 'real words', no_speech_prob: 0.1, avg_logprob: -0.3 },
          {
            text: 'thank you thank you thank you thank you',
            no_speech_prob: 0.1,
            avg_logprob: -0.3,
            compression_ratio: 3.1,
          },
        ],
      }),
    ).toBe('real words');
  });

  it('falls back to plain text when there are no segments', () => {
    expect(gatedText({ text: '  plain json  ' })).toBe('plain json');
    expect(gatedText({})).toBe('');
  });
});

describe('buildPrompt', () => {
  it('puts the vocabulary hint before the decoded context', () => {
    expect(buildPrompt('Nx, Speaches', encodeURIComponent('fix the hook'))).toBe(
      'Nx, Speaches. fix the hook',
    );
  });

  it('keeps only the tail of long context', () => {
    const long = `${'a'.repeat(50)}${'b'.repeat(MAX_CONTEXT_CHARS)}`;
    expect(buildPrompt('', encodeURIComponent(long))).toBe('b'.repeat(MAX_CONTEXT_CHARS));
  });

  it('ignores a malformed or missing header', () => {
    expect(buildPrompt('hint', '%E0%A4%A')).toBe('hint');
    expect(buildPrompt('hint', undefined)).toBe('hint');
    expect(buildPrompt('', undefined)).toBe('');
  });
});
