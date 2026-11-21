import express, { Router, type Request, type Response } from 'express';

const router = Router();

const SPEACHES_BASE_URL = (
  process.env.SPEACHES_BASE_URL ?? 'http://127.0.0.1:8000'
).replace(/\/$/, '');
const SPEACHES_STT_MODEL =
  process.env.SPEACHES_STT_MODEL ?? 'Systran/faster-distil-whisper-large-v3';
const VOICE_STT_LANGUAGE = process.env.VOICE_STT_LANGUAGE ?? 'en';
const VOICE_STT_PROMPT = (
  process.env.VOICE_STT_PROMPT ??
  'desk, Speaches, Nx monorepo, Ollama, agent-core, RunManager, ChatInput'
).trim();
const MAX_AUDIO_BYTES = Number(process.env.VOICE_MAX_AUDIO_BYTES ?? 10_485_760);
/** Server-side Silero VAD in faster-whisper: strips silence before decoding. */
const VOICE_STT_VAD_FILTER =
  (process.env.VOICE_STT_VAD_FILTER ?? 'true').trim().toLowerCase() !== 'false';

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
const MAX_CONTEXT_CHARS = 400;

type WhisperSegment = {
  text?: string;
  no_speech_prob?: number;
  avg_logprob?: number;
  compression_ratio?: number;
};

type VerboseTranscription = {
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

/** Keep only segments that pass the silence/loop gates. */
function gatedText(data: VerboseTranscription): string {
  if (!Array.isArray(data.segments)) return (data.text ?? '').trim();
  return data.segments
    .filter(isSpeechSegment)
    .map((s) => (s.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

/**
 * Vocabulary hint first, then the tail of what was dictated so far, so the
 * decoder continues the sentence instead of starting cold.
 */
function buildPrompt(contextHeader: unknown): string {
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
  return [VOICE_STT_PROMPT, context].filter(Boolean).join('. ');
}

/**
 * POST /api/voice/transcribe
 * Body: raw audio bytes (Content-Type: audio/webm, audio/wav, …)
 * Optional header X-Voice-Context: URI-encoded text dictated earlier this session.
 * Returns: { text: string } — empty when the clip held no speech.
 *
 * Proxies to Speaches OpenAI-compatible /v1/audio/transcriptions.
 * Does not touch Ollama or agent-core.
 */
router.post(
  '/transcribe',
  express.raw({
    type: (req) => {
      const ct = req.headers['content-type'] ?? '';
      return ct.startsWith('audio/') || ct === 'application/octet-stream';
    },
    limit: MAX_AUDIO_BYTES,
  }),
  async (req: Request, res: Response) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: 'audio body is required' });
    }
    if (body.length > MAX_AUDIO_BYTES) {
      return res.status(413).json({ error: 'audio too large' });
    }

    const contentType =
      typeof req.headers['content-type'] === 'string' &&
      req.headers['content-type'].startsWith('audio/')
        ? req.headers['content-type'].split(';')[0]?.trim()
        : 'audio/webm';
    const ext = contentType.includes('wav')
      ? 'wav'
      : contentType.includes('mpeg') || contentType.includes('mp3')
        ? 'mp3'
        : 'webm';

    try {
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(body)], { type: contentType }),
        `audio.${ext}`,
      );
      form.append('model', SPEACHES_STT_MODEL);
      // verbose_json carries per-segment no_speech_prob / avg_logprob for gating.
      form.append('response_format', 'verbose_json');
      form.append('language', VOICE_STT_LANGUAGE);
      form.append('temperature', '0');
      form.append('vad_filter', VOICE_STT_VAD_FILTER ? 'true' : 'false');
      const prompt = buildPrompt(req.headers['x-voice-context']);
      if (prompt) form.append('prompt', prompt);

      const upstream = await fetch(
        `${SPEACHES_BASE_URL}/v1/audio/transcriptions`,
        {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(30_000),
        },
      );

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        console.error(
          '[voice] speaches error',
          upstream.status,
          detail.slice(0, 500),
        );
        return res.status(502).json({
          error: 'Speech service failed',
          status: upstream.status,
        });
      }

      const data = (await upstream.json()) as VerboseTranscription;
      return res.json({ text: gatedText(data) });
    } catch (err) {
      console.error('[voice] speaches unreachable', err);
      return res.status(503).json({ error: 'Voice service unavailable' });
    }
  },
);

export { router as voiceRouter };
