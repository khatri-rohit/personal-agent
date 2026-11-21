'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { synthesizeSpeech } from '@/api/voice-client';
import { toastError } from '@/hooks/use-toast';
import {
  onVoicePrefsChange,
  readReadAloudPref,
  voiceCapabilities,
} from '@/lib/voice-prefs';
import { chunkSpeech, toSpeechText } from './speech-text';

/**
 * One read-aloud player for the whole page. Interface: `useReadAloud(id, md)`
 * for a reply's button, `stopReadAloud()` for whoever owns a lifecycle (the
 * thread page). Everything else stays inside:
 * - starting a reply stops the one playing;
 * - turning the setting off, or the page going away, stops playback;
 * - Speaches (Kokoro) when configured, browser speechSynthesis as fallback;
 * - failures end playback with a toast — never anything else.
 */

export type ReadAloudStatus = 'idle' | 'loading' | 'playing';

type Snapshot = { id: string | null; status: ReadAloudStatus };

let snapshot: Snapshot = { id: null, status: 'idle' };
let current: { id: string; abort: AbortController } | null = null;

const listeners = new Set<() => void>();
function setSnapshot(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const IDLE: Snapshot = { id: null, status: 'idle' };

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

/** Play one audio blob to the end; resolves early (quietly) on abort. */
function playBlob(blob: Blob, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const done = (err?: unknown) => {
      signal.removeEventListener('abort', onAbort);
      audio.pause();
      URL.revokeObjectURL(url);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => done(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    audio.onended = () => done();
    audio.onerror = () => done(new Error('Audio playback failed'));
    audio.play().catch((err: unknown) => done(err));
  });
}

/** Kokoro via the API; the next chunk is synthesised while this one plays. */
async function playSpeaches(
  chunks: string[],
  signal: AbortSignal,
  onPlaying: () => void,
): Promise<number> {
  const fetchChunk = (i: number) => {
    const p = synthesizeSpeech(chunks[i] ?? '', signal);
    p.catch(() => undefined); // awaited below; avoid an unhandled rejection
    return p;
  };
  let next = fetchChunk(0);
  for (let i = 0; i < chunks.length; i++) {
    let blob: Blob;
    try {
      blob = await next;
    } catch (err) {
      if (isAbort(err)) throw err;
      return i; // hand the rest to the browser voice
    }
    if (i + 1 < chunks.length) next = fetchChunk(i + 1);
    onPlaying();
    await playBlob(blob, signal);
  }
  return chunks.length;
}

function pickBrowserVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  return (
    english.find((v) => /natural|neural|online/i.test(v.name)) ??
    english.find((v) => v.default) ??
    english[0] ??
    null
  );
}

/**
 * Browser voice, one utterance per chunk: Chrome stops a single long
 * utterance after ~15 s, short ones avoid that.
 */
async function playBrowser(
  chunks: string[],
  signal: AbortSignal,
  onPlaying: () => void,
): Promise<void> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    throw new Error('This browser cannot read text aloud');
  }
  const synth = window.speechSynthesis;
  const voice = pickBrowserVoice();
  const onAbort = () => synth.cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (const chunk of chunks) {
      if (signal.aborted) throw abortError();
      await new Promise<void>((resolve, reject) => {
        const u = new SpeechSynthesisUtterance(chunk);
        if (voice) u.voice = voice;
        u.onstart = () => onPlaying();
        u.onend = () => resolve();
        u.onerror = (e) =>
          e.error === 'canceled' || e.error === 'interrupted'
            ? reject(abortError())
            : reject(new Error(`Speech failed (${e.error})`));
        synth.speak(u);
      });
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function stopReadAloud(): void {
  current?.abort.abort();
  current = null;
  setSnapshot(IDLE);
}

async function startReadAloud(id: string, markdown: string): Promise<void> {
  stopReadAloud();
  const chunks = chunkSpeech(toSpeechText(markdown));
  if (chunks.length === 0) return;

  const abort = new AbortController();
  const mine = { id, abort };
  current = mine;
  setSnapshot({ id, status: 'loading' });
  const onPlaying = () => {
    if (current === mine && snapshot.status !== 'playing') {
      setSnapshot({ id, status: 'playing' });
    }
  };

  try {
    let from = 0;
    if (voiceCapabilities().tts === 'speaches') {
      from = await playSpeaches(chunks, abort.signal, onPlaying);
      if (from < chunks.length) {
        toastError(
          'Speaches did not answer, so the browser voice is reading instead.',
          'Read-aloud fallback',
        );
      }
    }
    if (from < chunks.length) {
      await playBrowser(chunks.slice(from), abort.signal, onPlaying);
    }
  } catch (err) {
    if (!isAbort(err)) {
      toastError(
        err instanceof Error ? err.message : 'Read-aloud failed',
        'Read-aloud failed',
      );
    }
  } finally {
    if (current === mine) {
      current = null;
      setSnapshot(IDLE);
    }
  }
}

// Stop rules the module owns, so no caller has to remember them. Browser
// speechSynthesis even survives a reload in Chrome, hence pagehide.
if (typeof window !== 'undefined') {
  onVoicePrefsChange(() => {
    if (current && !readReadAloudPref()) stopReadAloud();
  });
  window.addEventListener('pagehide', () => stopReadAloud());
}

/** Status for one message plus a play/stop toggle. */
export function useReadAloud(id: string, markdown: string) {
  const state = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => IDLE,
  );
  const status: ReadAloudStatus = state.id === id ? state.status : 'idle';
  const toggle = useCallback(() => {
    if (snapshot.id === id) stopReadAloud();
    else void startReadAloud(id, markdown);
  }, [id, markdown]);
  return { status, toggle };
}
