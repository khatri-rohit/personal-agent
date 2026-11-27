import {
  parseVoiceCapabilities,
  type VoiceCapabilities,
} from '@agent/agent-models';

import { api } from './client';

/** Which voice backends this deployment serves (decided by the API's env). */
export async function fetchVoiceCapabilities(): Promise<VoiceCapabilities> {
  const res = await api.request('voice.capabilities', {
    init: { cache: 'no-store', signal: AbortSignal.timeout(5_000) },
  });
  if (!res.ok) throw new Error(`Voice capabilities failed (${res.status})`);
  return parseVoiceCapabilities(await res.json());
}

/**
 * Transcribe a recorded audio blob via apps/api → Speaches.
 * `context` is text already dictated this session; the server uses its tail
 * as the Whisper prompt so each utterance continues the last one.
 */
export async function transcribeAudio(
  blob: Blob,
  context = '',
): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': blob.type || 'audio/webm',
  };
  const tail = context.trim().slice(-400);
  if (tail) headers['X-Voice-Context'] = encodeURIComponent(tail);

  const res = await api.request('voice.transcribe', {
    init: { headers, body: blob, signal: AbortSignal.timeout(30_000) },
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(err?.error ?? `Transcription failed (${res.status})`);
  }

  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}

/** Synthesise one chunk of plain speech text via apps/api → Speaches (Kokoro). */
export async function synthesizeSpeech(
  text: string,
  signal: AbortSignal,
): Promise<Blob> {
  const res = await api.request('voice.speak', {
    init: {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    },
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(err?.error ?? `Speech failed (${res.status})`);
  }

  return res.blob();
}
