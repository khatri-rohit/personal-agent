const HALLUCINATION_RE =
  /\b(thanks for watching|thank you for watching|like and subscribe|subscribe)\b/i;

/**
 * Phrases Whisper emits on silence or noise. Matched only against the WHOLE
 * utterance (after normalising), so "thank you for the fix" still passes.
 */
const SILENCE_PHRASES = new Set([
  'you',
  'thank you',
  'thank you very much',
  'thank you so much',
  'thanks',
  'thanks a lot',
  'thank you bye',
  'bye',
  'bye bye',
  'goodbye',
  'oh',
  'uh',
  'um',
  'hmm',
  'mm',
  'i dont know',
  'the end',
  'see you next time',
  'see you in the next video',
  'please subscribe',
  'subtitles by the amaraorg community',
]);

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drop Whisper junk from silence / noise (pipe spam, YouTube-style captions). */
export function isUsableTranscript(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const compact = trimmed.replace(/\s+/g, '');
  const bars = (compact.match(/\|/g) ?? []).length;
  if (compact.length > 0 && bars / compact.length > 0.4) return false;

  const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 3) return false;

  if (SILENCE_PHRASES.has(normalise(trimmed))) return false;

  // Caption hallucinations are often the whole segment.
  if (HALLUCINATION_RE.test(trimmed) && letters < 80) return false;

  return true;
}
