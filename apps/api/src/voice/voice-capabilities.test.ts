import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseVoiceCapabilities, parseVoiceProvider } from '@agent/agent-models';

describe('parseVoiceProvider', () => {
  it('accepts the three providers, case- and space-insensitive', () => {
    expect(parseVoiceProvider(' Speaches ')).toBe('speaches');
    expect(parseVoiceProvider('OFF')).toBe('off');
    expect(parseVoiceProvider('browser')).toBe('browser');
  });

  it('falls back for missing or unknown values', () => {
    expect(parseVoiceProvider(undefined)).toBe('browser');
    expect(parseVoiceProvider('whisper')).toBe('browser');
    expect(parseVoiceProvider('', 'off')).toBe('off');
  });
});

describe('parseVoiceCapabilities', () => {
  it('reads a well-formed payload', () => {
    expect(parseVoiceCapabilities({ stt: 'speaches', tts: 'browser' })).toEqual({
      stt: 'speaches',
      tts: 'browser',
    });
  });

  it('hides anything malformed (off is the safe default for an add-on)', () => {
    expect(parseVoiceCapabilities(null)).toEqual({ stt: 'off', tts: 'off' });
    expect(parseVoiceCapabilities({ stt: 'x' })).toEqual({ stt: 'off', tts: 'off' });
  });
});

/** The voice module reads env at import, so each case imports a fresh copy. */
async function appWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  const { voiceRouter } = await import('./voice.routes');
  const app = express();
  app.use(express.json());
  app.use('/api/voice', voiceRouter);
  return app;
}

describe('GET /api/voice/capabilities', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports browser for both by default and mounts no Speaches routes', async () => {
    const app = await appWith({ VOICE_STT_PROVIDER: '', VOICE_TTS_PROVIDER: '' });
    const caps = await request(app).get('/api/voice/capabilities');
    expect(caps.status).toBe(200);
    expect(caps.body).toEqual({ stt: 'browser', tts: 'browser' });
    expect((await request(app).post('/api/voice/speak').send({ text: 'hi' })).status).toBe(404);
  });

  it('reports speaches and mounts only the matching routes', async () => {
    const app = await appWith({ VOICE_STT_PROVIDER: 'off', VOICE_TTS_PROVIDER: 'speaches' });
    expect((await request(app).get('/api/voice/capabilities')).body).toEqual({
      stt: 'off',
      tts: 'speaches',
    });
    // TTS route exists (400 = validation reached, no Speaches call needed).
    expect((await request(app).post('/api/voice/speak').send({})).status).toBe(400);
    // STT route does not.
    expect(
      (await request(app).post('/api/voice/transcribe').set('Content-Type', 'audio/wav').send(Buffer.from('x')))
        .status,
    ).toBe(404);
  });
});
