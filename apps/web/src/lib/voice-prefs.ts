'use client';

import { useSyncExternalStore } from 'react';
import {
  VOICE_OFF,
  type VoiceCapabilities,
  type VoiceProvider,
} from '@agent/agent-models';
import { fetchVoiceCapabilities } from '@/api/voice-client';

/**
 * Voice is an add-on, never part of the harness path. Two layers decide it:
 *
 * 1. Deployment — which backend exists. The API is the single source of
 *    truth (VOICE_STT_PROVIDER / VOICE_TTS_PROVIDER, read at API start) and
 *    reports it on GET /api/voice/capabilities. `off` hides the feature and
 *    its setting entirely. Until the API answers — or if it cannot — voice
 *    stays hidden; it never waits on or blocks anything else.
 * 2. Reader — a per-browser opt-in in Settings. Both default OFF: no mic
 *    button, no Alt+A listener, no speaker button, and the VAD / audio code is
 *    never loaded until the reader turns it on.
 */

export type { VoiceProvider };

/** Retry delay while the API is unreachable (voice stays hidden meanwhile). */
const CAPABILITIES_RETRY_MS = 30_000;

let capabilities: VoiceCapabilities = VOICE_OFF;
let capabilitiesState: 'idle' | 'loading' | 'ready' = 'idle';

function loadCapabilities(): void {
  if (capabilitiesState !== 'idle' || typeof window === 'undefined') return;
  capabilitiesState = 'loading';
  fetchVoiceCapabilities()
    .then((caps) => {
      capabilities = caps;
      capabilitiesState = 'ready';
      emit();
    })
    .catch(() => {
      capabilitiesState = 'idle';
      window.setTimeout(loadCapabilities, CAPABILITIES_RETRY_MS);
    });
}

/** Current deployment providers, for non-React callers (read-aloud player). */
export function voiceCapabilities(): VoiceCapabilities {
  return capabilities;
}

/** Deployment providers; `off` for both until the API answers. */
export function useVoiceCapabilities(): VoiceCapabilities {
  return useSyncExternalStore(
    subscribeCapabilities,
    () => capabilities,
    () => VOICE_OFF,
  );
}

function subscribeCapabilities(listener: () => void) {
  loadCapabilities();
  return subscribe(listener);
}

const VOICE_INPUT_KEY = 'desk-ui-voice-input';
const READ_ALOUD_KEY = 'desk-ui-read-aloud';

function read(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function write(key: string, on: boolean): void {
  try {
    window.localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* private mode: the pref lasts for this page only */
  }
  emit();
}

const listeners = new Set<() => void>();
function emit() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  // Keep tabs in sync: toggling in one tab updates the others.
  const onStorage = (e: StorageEvent) => {
    if (e.key === VOICE_INPUT_KEY || e.key === READ_ALOUD_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** Dictation (mic button + Alt+A). Off by default. */
export function setVoiceInputPref(on: boolean): void {
  write(VOICE_INPUT_KEY, on);
}

export function useVoiceInputPref(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => read(VOICE_INPUT_KEY),
    () => false,
  );
}

/** Read-aloud speaker button on agent replies. Off by default. */
export function readReadAloudPref(): boolean {
  return read(READ_ALOUD_KEY);
}

/** Change feed for both voice prefs (this tab and others). Returns unsubscribe. */
export function onVoicePrefsChange(listener: () => void): () => void {
  return subscribe(listener);
}

export function setReadAloudPref(on: boolean): void {
  write(READ_ALOUD_KEY, on);
}

export function useReadAloudPref(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => read(READ_ALOUD_KEY),
    () => false,
  );
}

/** Effective switches: deployment allows it AND the reader opted in. */
export function useVoiceInputEnabled(): boolean {
  const { stt } = useVoiceCapabilities();
  const pref = useVoiceInputPref();
  return stt !== 'off' && pref;
}

export function useReadAloudEnabled(): boolean {
  const { tts } = useVoiceCapabilities();
  const pref = useReadAloudPref();
  return tts !== 'off' && pref;
}
