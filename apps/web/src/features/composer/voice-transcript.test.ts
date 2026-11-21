import { describe, expect, it } from 'vitest';

import { isUsableTranscript } from './voice-transcript';

describe('isUsableTranscript', () => {
  it.each(['Thank you.', 'you', 'Bye bye!', "I don't know.", 'Um.', 'Thanks for watching!'])(
    'drops the silence phrase %j',
    (text) => {
      expect(isUsableTranscript(text)).toBe(false);
    },
  );

  it.each([
    'Thank you for the fix, now run the tests.',
    'okay',
    'yes',
    'Open voice.routes.ts',
  ])('keeps real dictation %j', (text) => {
    expect(isUsableTranscript(text)).toBe(true);
  });

  it('drops empty, pipe spam, and letter-less output', () => {
    expect(isUsableTranscript('   ')).toBe(false);
    expect(isUsableTranscript('| | | |')).toBe(false);
    expect(isUsableTranscript('...')).toBe(false);
  });
});
