'use client';

import { useSyncExternalStore } from 'react';
import { DIAGNOSTICS_KEY, TEXT_SIZE_KEY } from './reading-prefs-init';

/**
 * Reading preferences that the browser cannot infer: a 32" 4K panel at 150%
 * and a 27" 1440p panel at 100% both report a 2560px viewport, so text size
 * is the reader's call, not a breakpoint guess. Both prefs live on <html> as
 * data attributes so CSS reads them without a React render.
 */

export type TextSize = 'sm' | 'md' | 'lg';

export const TEXT_SIZES: { value: TextSize; label: string; hint: string }[] = [
  { value: 'sm', label: 'Compact', hint: 'More on screen' },
  { value: 'md', label: 'Default', hint: 'Scales with the window' },
  { value: 'lg', label: 'Large', hint: 'Big or far-away displays' },
];


function isTextSize(value: string | null): value is TextSize {
  return value === 'sm' || value === 'md' || value === 'lg';
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode: the pref lasts for this page only */
  }
}


const listeners = new Set<() => void>();
function emit() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readTextSize(): TextSize {
  const stored = read(TEXT_SIZE_KEY);
  return isTextSize(stored) ? stored : 'md';
}

export function setTextSize(size: TextSize): void {
  write(TEXT_SIZE_KEY, size);
  const root = document.documentElement;
  if (size === 'md') delete root.dataset.textSize;
  else root.dataset.textSize = size;
  emit();
}

export function useTextSize(): TextSize {
  return useSyncExternalStore(subscribe, readTextSize, () => 'md');
}

/**
 * Run diagnostics: seq numbers, token counts, per-call timings and System 1
 * fallback notes. Off by default — product view stays plain language; the
 * harness developer turns it on to judge rollouts.
 */
export function readDiagnostics(): boolean {
  return read(DIAGNOSTICS_KEY) === '1';
}

export function setDiagnostics(on: boolean): void {
  write(DIAGNOSTICS_KEY, on ? '1' : '0');
  emit();
}

export function useDiagnostics(): boolean {
  return useSyncExternalStore(subscribe, readDiagnostics, () => false);
}
