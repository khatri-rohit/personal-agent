const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3333';

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

  const res = await fetch(`${API_BASE}/api/voice/transcribe`, {
    method: 'POST',
    headers,
    body: blob,
    signal: AbortSignal.timeout(30_000),
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
