'use client';

import { useBrowserSpeechDictation } from '@/features/composer/use-browser-speech-dictation';
import { useVoiceDictation } from '@/features/composer/use-voice-dictation';
import {
  useVoiceCapabilities,
  useVoiceInputEnabled,
  type VoiceProvider,
} from '@/lib/voice-prefs';

export type VoiceInputController = {
  enabled: boolean;
  provider: VoiceProvider;
  active: boolean;
  level: number;
  transcribing: boolean;
  error: string | null;
  toggle: () => void;
  stop: () => void;
};

const idleToggle = () => undefined;
const idleStop = () => undefined;

type Options = {
  onTranscript: (text: string) => void;
};

/**
 * Composer voice entrypoint. Live only when the deployment provides a backend
 * (API capabilities: stt browser | speaches) AND the reader turned
 * "Voice input" on in Settings. Otherwise both hooks stay idle: no mic,
 * no Alt+A listener, no VAD download.
 */
export function useVoiceInput({ onTranscript }: Options): VoiceInputController {
  const provider = useVoiceCapabilities().stt;
  const on = useVoiceInputEnabled();

  const speaches = useVoiceDictation({
    onTranscript,
    enabled: on && provider === 'speaches',
  });

  const browser = useBrowserSpeechDictation({
    onTranscript,
    enabled: on && provider === 'browser',
  });

  if (!on || provider === 'off') {
    return {
      enabled: false,
      provider,
      active: false,
      level: 0,
      transcribing: false,
      error: null,
      toggle: idleToggle,
      stop: idleStop,
    };
  }

  const live = provider === 'browser' ? browser : speaches;
  return {
    enabled: true,
    provider,
    active: live.active,
    level: live.level,
    transcribing: live.transcribing,
    error: live.error,
    toggle: live.toggle,
    stop: live.stop,
  };
}
