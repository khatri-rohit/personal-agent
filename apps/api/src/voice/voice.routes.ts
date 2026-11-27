import express, { Router, type Request, type Response } from 'express';
import {
  parseVoiceProvider,
  type VoiceCapabilities,
} from '@agent/agent-models';
import {
  buildPrompt,
  gatedText,
  type VerboseTranscription,
} from '@agent/agent-service';

/**
 * Voice add-on: the API's one module for speech, and the single source of
 * truth for which voice backends exist. It owns every voice setting and
 * decides which routes exist; main.ts only mounts `voiceRouter`, and the web
 * learns the providers from GET /api/voice/capabilities. Nothing on the run
 * path calls it, and a missing or broken Speaches only fails the voice
 * request itself.
 */

/** Blank or non-numeric env falls back (Number('') is 0, not "unset"). */
function envNumber(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** browser | speaches | off (default browser). Speaches routes mount only for `speaches`. */
export const voiceProviders: VoiceCapabilities = {
  stt: parseVoiceProvider(process.env.VOICE_STT_PROVIDER),
  tts: parseVoiceProvider(process.env.VOICE_TTS_PROVIDER),
};

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
const MAX_AUDIO_BYTES = envNumber(process.env.VOICE_MAX_AUDIO_BYTES, 10_485_760);
/** Server-side Silero VAD in faster-whisper: strips silence before decoding. */
const VOICE_STT_VAD_FILTER =
  (process.env.VOICE_STT_VAD_FILTER ?? 'true').trim().toLowerCase() !== 'false';

/** Speech → text (Whisper). */
const sttRouter = Router();
/** Text → speech (Kokoro). */
const ttsRouter = Router();

/**
 * POST /api/voice/transcribe
 * Body: raw audio bytes (Content-Type: audio/webm, audio/wav, …)
 * Optional header X-Voice-Context: URI-encoded text dictated earlier this session.
 * Returns: { text: string } — empty when the clip held no speech.
 *
 * Proxies to Speaches OpenAI-compatible /v1/audio/transcriptions.
 * Does not touch Ollama or agent-core.
 */
sttRouter.post(
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
      const prompt = buildPrompt(
        VOICE_STT_PROMPT,
        req.headers['x-voice-context'],
      );
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

const SPEACHES_TTS_MODEL =
  process.env.SPEACHES_TTS_MODEL ?? 'speaches-ai/Kokoro-82M-v1.0-ONNX-fp16';
const VOICE_TTS_VOICE = process.env.VOICE_TTS_VOICE ?? 'af_heart';
const VOICE_TTS_SPEED = clampSpeed(envNumber(process.env.VOICE_TTS_SPEED, 1));
/** The web client sends sentence-sized chunks; this only stops abuse. */
const MAX_TTS_CHARS = 2_000;

function clampSpeed(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0.5, n));
}

/**
 * POST /api/voice/speak
 * Body: { text: string } — already plain speech text (markdown stripped client-side).
 * Returns: audio/mpeg bytes.
 *
 * Proxies to Speaches OpenAI-compatible /v1/audio/speech (Kokoro).
 * Does not touch Ollama or agent-core.
 */
ttsRouter.post('/speak', async (req: Request, res: Response) => {
  const text =
    typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (text.length > MAX_TTS_CHARS) {
    return res.status(413).json({ error: 'text too long' });
  }

  try {
    const upstream = await fetch(`${SPEACHES_BASE_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SPEACHES_TTS_MODEL,
        input: text,
        voice: VOICE_TTS_VOICE,
        response_format: 'mp3',
        speed: VOICE_TTS_SPEED,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.error(
        '[voice] speaches tts error',
        upstream.status,
        detail.slice(0, 500),
      );
      return res
        .status(502)
        .json({ error: 'Speech service failed', status: upstream.status });
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(audio);
  } catch (err) {
    console.error('[voice] speaches unreachable (tts)', err);
    return res.status(503).json({ error: 'Voice service unavailable' });
  }
});

/**
 * Mounted at /api/voice. `/capabilities` is always there (a browser-only or
 * voice-off deployment still has to say so); Speaches routes only when their
 * provider is `speaches`.
 */
export const voiceRouter = Router();
voiceRouter.get('/capabilities', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(voiceProviders);
});
if (voiceProviders.stt === 'speaches') voiceRouter.use(sttRouter);
if (voiceProviders.tts === 'speaches') voiceRouter.use(ttsRouter);
