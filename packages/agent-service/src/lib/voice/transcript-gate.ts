/**
 * Decides what part of a Whisper transcription is real speech, and what the
 * decoder is primed with. Pure: no HTTP, no env — the voice routes pass the
 * configured vocabulary hint in.
 */

/**
 * Whisper's own silence rule (openai/whisper transcribe.py): a segment is
 * silence when the no-speech probability is high AND the decode was unsure.
 * Either alone is too eager — real quiet speech can score high no_speech.
 */
const NO_SPEECH_PROB = 0.6;
const LOW_AVG_LOGPROB = -1.0;
/** Above this the decoder looped ("thank you thank you thank you…"). */
const MAX_COMPRESSION_RATIO = 2.4;
/** Whisper's prompt window is ~224 tokens; keep context well inside it. */
export const MAX_CONTEXT_CHARS = 400;

export type WhisperSegment = {
  text?: string;
  no_speech_prob?: number;
  avg_logprob?: number;
  compression_ratio?: number;
};

/** Speaches `verbose_json` response (OpenAI-compatible). */
export type VerboseTranscription = {
  text?: string;
  segments?: WhisperSegment[];
};

function isSpeechSegment(seg: WhisperSegment): boolean {
  const noSpeech = seg.no_speech_prob ?? 0;
  const logprob = seg.avg_logprob ?? 0;
  if (noSpeech > NO_SPEECH_PROB && logprob < LOW_AVG_LOGPROB) return false;
  if ((seg.compression_ratio ?? 0) > MAX_COMPRESSION_RATIO) return false;
  return true;
}

/**
 * Text of the segments that pass the silence / loop gates; '' when the clip
 * held no speech. Without segments (plain `json`), the text passes as-is.
 */
export function gatedText(data: VerboseTranscription): string {
  if (!Array.isArray(data.segments)) return (data.text ?? '').trim();
  return data.segments
    .filter(isSpeechSegment)
    .map((s) => (s.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

/**
 * Whisper prompt: vocabulary hint first, then the tail of what was dictated
 * so far (URI-encoded in the X-Voice-Context header), so the decoder
 * continues the sentence instead of starting cold.
 */
export function buildPrompt(vocabulary: string, contextHeader: unknown): string {
  let context = '';
  if (typeof contextHeader === 'string' && contextHeader) {
    try {
      context = decodeURIComponent(contextHeader).trim();
    } catch {
      context = '';
    }
  }
  if (context.length > MAX_CONTEXT_CHARS) {
    context = context.slice(-MAX_CONTEXT_CHARS);
  }
  return [vocabulary.trim(), context].filter(Boolean).join('. ');
}
