'use client';

import { useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { requestReview, reviewerOptions } from './actions';
import type { Reviewer } from './models';

const PICK_KEY = 'eval:reviewer';

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="review-btn" disabled={pending} aria-busy={pending}>
      {pending ? 'Reviewing…' : label}
    </button>
  );
}

function thinkingLabel(value: string | boolean): string {
  if (value === true) return 'on';
  if (value === false) return 'off';
  return value;
}

/** The last pick, so the next review starts from it (per browser; harmless when storage is blocked). */
function readPick(): { model?: string; thinking?: string } {
  try {
    return JSON.parse(localStorage.getItem(PICK_KEY) ?? '{}') as { model?: string; thinking?: string };
  } catch {
    return {};
  }
}

function savePick(pick: { model: string; thinking: string }): void {
  try {
    localStorage.setItem(PICK_KEY, JSON.stringify(pick));
  } catch {
    // Storage blocked: the pick just is not remembered.
  }
}

/**
 * Posts the review action with the judge the user picked: a model from the
 * Ollama account and one of its thinking levels, the middle level by default
 * (as the chat composer offers models and thinking).
 */
export function ReviewButton({
  threadId,
  runId,
  homeFlag,
  label,
}: {
  threadId: string;
  runId?: string;
  homeFlag: string;
  label: string;
}) {
  const [reviewers, setReviewers] = useState<Reviewer[] | null>(null);
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('');

  useEffect(() => {
    let cancelled = false;
    void reviewerOptions()
      .then(({ reviewers: list, defaultModel }) => {
        if (cancelled) return;
        setReviewers(list);
        const pick = readPick();
        const chosen =
          list.find((r) => r.id === pick.model) ?? list.find((r) => r.id === defaultModel) ?? list[0];
        if (!chosen) return;
        setModel(chosen.id);
        const keep = pick.model === chosen.id && chosen.thinking.some((v) => String(v) === pick.thinking);
        setThinking(keep ? pick.thinking! : chosen.middle === null ? '' : String(chosen.middle));
      })
      .catch(() => {
        if (!cancelled) setReviewers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = reviewers?.find((r) => r.id === model);

  const onModel = (id: string) => {
    setModel(id);
    const next = reviewers?.find((r) => r.id === id);
    const level = next?.middle === null || next?.middle === undefined ? '' : String(next.middle);
    setThinking(level);
    savePick({ model: id, thinking: level });
  };

  return (
    <form action={requestReview} className="review-form">
      <input type="hidden" name="threadId" value={threadId} />
      {runId ? <input type="hidden" name="runId" value={runId} /> : null}
      {homeFlag ? <input type="hidden" name="home" value={homeFlag} /> : null}
      {reviewers && reviewers.length > 0 ? (
        <>
          <label className="review-pick">
            <span className="muted small">Reviewer</span>
            <select name="model" value={model} onChange={(event) => onModel(event.target.value)}>
              {reviewers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </select>
          </label>
          {current && current.thinking.length > 0 ? (
            <label className="review-pick">
              <span className="muted small">Thinking</span>
              <select
                name="thinking"
                value={thinking}
                onChange={(event) => {
                  setThinking(event.target.value);
                  savePick({ model, thinking: event.target.value });
                }}
              >
                {current.thinking.map((value) => (
                  <option key={String(value)} value={String(value)}>
                    {thinkingLabel(value)}
                    {String(value) === String(current.middle) ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <input type="hidden" name="thinking" value="" />
          )}
        </>
      ) : reviewers === null ? (
        <span className="muted small">Loading models…</span>
      ) : (
        <span className="muted small" title="Ollama did not list models (no OLLAMA_API_KEY, or offline)">
          No model list: reviewing with REVIEW_MODEL or the thread&apos;s model
        </span>
      )}
      <Submit label={label} />
    </form>
  );
}
