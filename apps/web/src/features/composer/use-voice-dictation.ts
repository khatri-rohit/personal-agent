'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MicVAD } from '@ricky0123/vad-web';
import { transcribeAudio } from '@/api/voice-client';
import { isUsableTranscript } from '@/features/composer/voice-transcript';

/** vad-web joins base + filename, so a base must end in "/". Empty → unset. */
function assetBase(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  return v.endsWith('/') ? v : `${v}/`;
}

/**
 * Silero VAD assets: AudioWorklet + ONNX model. Pinned to the installed
 * @ricky0123/vad-web version (bump with package.json). Env override points at
 * a self-hosted copy for offline use. Inlined at build time (VITE_).
 */
const VAD_ASSET_BASE =
  assetBase(import.meta.env.VITE_VAD_ASSET_BASE) ??
  'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/';
/**
 * onnxruntime wasm must match the bundled onnxruntime-web JS exactly, so the
 * default is built from the runtime's own version (see start()).
 */
const ORT_WASM_BASE_OVERRIDE = assetBase(import.meta.env.VITE_ORT_WASM_BASE);

/** Silero speech probability that opens an utterance. */
const POSITIVE_SPEECH = 0.5;
/** Probability under which a frame counts as silence (Silero: positive − 0.15). */
const NEGATIVE_SPEECH = 0.35;
/** Silence that ends an utterance. */
const END_SILENCE_MS = 800;
/** Audio kept from before speech was detected, so the first word survives. */
const PRE_SPEECH_PAD_MS = 300;
/** Shorter "speech" is a cough / click — dropped without calling STT. */
const MIN_SPEECH_MS = 400;
/** Cut a long monologue so text keeps arriving and stays inside Whisper's 30 s window. */
const MAX_UTTERANCE_MS = 25_000;
/** Tail of this session's text sent as the Whisper prompt. */
const CONTEXT_CHARS = 400;

const SAMPLE_RATE = 16_000;

type MicSession = {
  vad: MicVAD;
  stream: MediaStream;
  cutTimer: ReturnType<typeof setInterval> | null;
};

function frameLevel(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] ?? 0;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, frame.length)) * 6);
}

/**
 * AGC off: in a quiet room it lifts the noise floor until fans and keys look
 * like speech. Noise suppression stays on; echo cancellation keeps speaker
 * playback out of the mic.
 */
function openMic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    },
  });
}

function releaseSession(session: MicSession) {
  if (session.cutTimer) clearInterval(session.cutTimer);
  // destroy() pauses first, which flushes in-progress speech (submitUserSpeechOnPause).
  void session.vad
    .destroy()
    .catch(() => undefined)
    .finally(() => session.stream.getTracks().forEach((t) => t.stop()));
}

type VoiceDictationOptions = {
  onTranscript: (text: string) => void;
  /** When false, hook is idle (no mic, no Alt+A). */
  enabled?: boolean;
};

/**
 * Speaches dictation: Silero VAD in the browser cuts whole utterances
 * (speech → silence), each is sent as 16 kHz WAV to /api/voice/transcribe.
 * Silence never reaches Whisper. Stop ends listening only (STT still drains).
 */
export function useVoiceDictation({
  onTranscript,
  enabled = true,
}: VoiceDictationOptions) {
  const [active, setActive] = useState(false);
  const [level, setLevel] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<MicSession | null>(null);
  const startingRef = useRef(false);
  /** Alt+A pressed again while the detector was still loading. */
  const cancelStartRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const mountedRef = useRef(true);
  const pendingRef = useRef(0);
  /** Text accepted this session — the prompt context for the next utterance. */
  const sessionTextRef = useRef('');
  /** Serial Speaches chain — one request at a time, so context stays ordered. */
  const sttChainRef = useRef(Promise.resolve());

  const enqueueTranscribe = useCallback((blob: Blob) => {
    pendingRef.current += 1;
    setTranscribing(true);

    const run = async () => {
      try {
        if (!mountedRef.current) return;
        const context = sessionTextRef.current.slice(-CONTEXT_CHARS);
        const text = await transcribeAudio(blob, context);
        if (!mountedRef.current) return;
        if (isUsableTranscript(text)) {
          sessionTextRef.current = `${sessionTextRef.current} ${text}`.trim();
          onTranscriptRef.current(text);
        }
        setError(null);
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : 'Transcription failed');
      } finally {
        pendingRef.current = Math.max(0, pendingRef.current - 1);
        if (mountedRef.current) setTranscribing(pendingRef.current > 0);
      }
    };

    // onRejected also runs so the queue continues after a failure.
    sttChainRef.current = sttChainRef.current.then(run, run);
  }, []);

  const stop = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    setActive(false);
    setLevel(0);
    releaseSession(session);
  }, []);

  const start = useCallback(async () => {
    if (!enabled || sessionRef.current || startingRef.current) return;
    startingRef.current = true;
    cancelStartRef.current = false;
    setError(null);
    sessionTextRef.current = '';

    let stream: MediaStream | null = null;
    let session: MicSession | null = null;
    try {
      stream = await openMic();
      const micStream = stream;
      const [{ MicVAD, utils }, ort] = await Promise.all([
        import('@ricky0123/vad-web'),
        // Same deduped copy vad-web runs (both resolve onnxruntime-web/wasm).
        import('onnxruntime-web/wasm'),
      ]);
      const ortWasmBase =
        ORT_WASM_BASE_OVERRIDE ??
        `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;

      let speechStartedAt: number | null = null;

      const vad = await MicVAD.new({
        model: 'v5',
        baseAssetPath: VAD_ASSET_BASE,
        onnxWASMBasePath: ortWasmBase,
        startOnLoad: false,
        positiveSpeechThreshold: POSITIVE_SPEECH,
        negativeSpeechThreshold: NEGATIVE_SPEECH,
        redemptionMs: END_SILENCE_MS,
        preSpeechPadMs: PRE_SPEECH_PAD_MS,
        minSpeechMs: MIN_SPEECH_MS,
        submitUserSpeechOnPause: true,
        // One mic stream for the whole session; pause/resume only rewire nodes.
        getStream: async () => micStream,
        pauseStream: async () => undefined,
        resumeStream: async () => micStream,
        onFrameProcessed: (_probs, frame) => {
          if (mountedRef.current) setLevel(frameLevel(frame));
        },
        onSpeechStart: () => {
          speechStartedAt = performance.now();
        },
        onVADMisfire: () => {
          speechStartedAt = null;
        },
        onSpeechEnd: (audio) => {
          speechStartedAt = null;
          const wav = utils.encodeWAV(audio, 1, SAMPLE_RATE, 1, 16);
          enqueueTranscribe(new Blob([wav], { type: 'audio/wav' }));
        },
      });

      const live: MicSession = { vad, stream: micStream, cutTimer: null };
      session = live;

      // Long monologue: pause (flushes the utterance) and resume on the same stream.
      live.cutTimer = setInterval(() => {
        if (speechStartedAt == null) return;
        if (performance.now() - speechStartedAt < MAX_UTTERANCE_MS) return;
        speechStartedAt = null;
        void vad
          .pause()
          .then(() => (sessionRef.current === live ? vad.start() : undefined))
          .catch(() => undefined);
      }, 500);

      if (!mountedRef.current || cancelStartRef.current) {
        releaseSession(live);
        return;
      }

      await vad.start();
      sessionRef.current = live;
      setActive(true);
    } catch (err: unknown) {
      if (session) releaseSession(session);
      else stream?.getTracks().forEach((t) => t.stop());
      const denied =
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'NotFoundError');
      setError(
        denied
          ? 'Microphone permission denied or unavailable'
          : 'Voice detector failed to load',
      );
      setActive(false);
      setLevel(0);
    } finally {
      startingRef.current = false;
    }
  }, [enabled, enqueueTranscribe]);

  const toggle = useCallback(() => {
    if (startingRef.current) cancelStartRef.current = true;
    else if (sessionRef.current) stop();
    else void start();
  }, [start, stop]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key !== 'a' && e.key !== 'A') return;
      if (e.repeat) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, toggle]);

  useEffect(() => {
    if (enabled) return;
    cancelStartRef.current = true;
    stop();
  }, [enabled, stop]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) releaseSession(session);
    };
  }, []);

  return { active, level, transcribing, error, toggle, stop };
}
