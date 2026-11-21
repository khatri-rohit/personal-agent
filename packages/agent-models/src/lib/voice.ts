/**
 * Voice add-on wire shapes. The API is the one place that decides which
 * voice backends exist (VOICE_STT_PROVIDER / VOICE_TTS_PROVIDER); the web
 * reads them from GET /api/voice/capabilities instead of keeping its own copy.
 */

/**
 * - `browser`  — the browser's own engine (Web Speech / speechSynthesis)
 * - `speaches` — local Speaches through /api/voice (Whisper / Kokoro)
 * - `off`      — feature and its setting are hidden
 */
export type VoiceProvider = 'browser' | 'speaches' | 'off';

export type VoiceCapabilities = {
  /** Speech → text (dictation). */
  stt: VoiceProvider;
  /** Text → speech (read-aloud). */
  tts: VoiceProvider;
};

/** Everything hidden: what the web assumes until (or unless) the API answers. */
export const VOICE_OFF: VoiceCapabilities = { stt: 'off', tts: 'off' };

/** Env / wire value → provider. Unknown or missing means `fallback`. */
export function parseVoiceProvider(
  raw: unknown,
  fallback: VoiceProvider = 'browser',
): VoiceProvider {
  if (typeof raw !== 'string') return fallback;
  const v = raw.trim().toLowerCase();
  return v === 'browser' || v === 'speaches' || v === 'off' ? v : fallback;
}

/** Validates an untrusted capabilities payload; anything malformed is `off`. */
export function parseVoiceCapabilities(raw: unknown): VoiceCapabilities {
  if (!raw || typeof raw !== 'object') return VOICE_OFF;
  const r = raw as Record<string, unknown>;
  return {
    stt: parseVoiceProvider(r['stt'], 'off'),
    tts: parseVoiceProvider(r['tts'], 'off'),
  };
}
