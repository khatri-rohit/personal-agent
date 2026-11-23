'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, MessageCircleQuestion } from 'lucide-react';
import { MAX_CHOICE_TEXT_CHARS } from '@agent/agent-models';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { PendingChoice } from './chat-store';
import type { ToolCallRow } from './turn-timeline';
import { TrailLine } from './trail-line';
import { setChoiceHandle } from './choice-focus';

/**
 * Zone 3 — needs you. The agent is paused on a question, so this is the
 * one card in the conversation and one of the few places the accent shows.
 * It sits inline at the end of the turn, right under the agent's
 * explanation the reader needs while choosing; nothing overlays it and the
 * composer never resizes. Once answered, the turn shows a ChoiceRecord line
 * in the same spot.
 *
 * Keys (focus inside the card, not in the note): 1–9 toggle options;
 * Ctrl/⌘+Enter continues from anywhere in the card. No single-key Skip —
 * Skip ends the run, so it stays a deliberate click.
 */
export function ChoiceCard({
  choice,
  onResolve,
}: {
  choice: PendingChoice | null;
  onResolve: (
    choiceId: string,
    body: { skipped: true } | { optionIds: string[]; text?: string },
  ) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'skip' | 'continue' | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const choiceId = choice?.choiceId ?? '';

  useEffect(() => {
    setSelected(new Set());
    setText('');
    setBusy(null);
  }, [choiceId]);

  // While mounted, text typed into the composer (or anywhere) lands in the
  // note instead of becoming a queued message. Focus moves only when text
  // actually arrives — the card never steals focus on its own.
  const optionIdsRef = useRef<string[]>([]);
  optionIdsRef.current = choice?.options.map((option) => option.id) ?? [];

  useEffect(() => {
    if (!choiceId) return;
    setChoiceHandle({
      toggleOption: (index) => {
        const id = optionIdsRef.current[index];
        if (!id) return false;
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        return true;
      },
      addNote: (incoming) => {
        setText((prev) =>
          `${prev}${prev && !prev.endsWith(' ') && incoming.length > 1 ? ' ' : ''}${incoming}`.slice(
            0,
            MAX_CHOICE_TEXT_CHARS,
          ),
        );
        requestAnimationFrame(() => {
          const el = noteRef.current;
          if (!el) return;
          el.focus({ preventScroll: true });
          el.setSelectionRange(el.value.length, el.value.length);
        });
      },
    });
    return () => setChoiceHandle(null);
  }, [choiceId]);

  if (!choice) return null;

  const extra = text.trim();
  const canContinue = selected.size > 0 || extra.length > 0;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const act = async (
    body: { skipped: true } | { optionIds: string[]; text?: string },
    kind: 'skip' | 'continue',
  ) => {
    if (busy) return;
    setBusy(kind);
    try {
      await onResolve(choice.choiceId, body);
    } finally {
      // answerChoice owns the error toast; this only releases the busy state,
      // on success and failure alike.
      setBusy(null);
    }
  };

  const submit = () => {
    if (!canContinue || busy) return;
    void act(
      { optionIds: [...selected], ...(extra ? { text: extra } : {}) },
      'continue',
    );
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
      return;
    }
    const inNote = event.target instanceof HTMLTextAreaElement;
    if (inNote || event.altKey || event.ctrlKey || event.metaKey) return;
    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choice.options.length) {
      event.preventDefault();
      toggle(choice.options[index].id);
    }
  };

  return (
    <section
      className="min-w-0 overflow-hidden rounded-lg border border-primary/40 bg-card"
      aria-label="The agent is asking you"
      aria-live="polite"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-start gap-2.5 px-4 pt-3.5 pb-2">
        <MessageCircleQuestion
          className="mt-0.5 size-4 shrink-0 text-primary"
          strokeWidth={1.75}
        />
        <p className="min-w-0 flex-1 text-[length:var(--text-body)] font-medium leading-relaxed text-foreground">
          {choice.question}
        </p>
      </div>
      <fieldset
        className="flex flex-col gap-1.5 px-4 pb-3"
        disabled={Boolean(busy)}
      >
        <legend className="sr-only">Options — pick any</legend>
        {choice.options.map((option, i) => {
          const checked = selected.has(option.id);
          return (
            <label
              key={option.id}
              className={cn(
                'type-ui flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 leading-relaxed transition-colors focus-within:ring-2 focus-within:ring-ring',
                checked
                  ? 'border-primary/50 bg-primary/5 text-foreground'
                  : 'border-border/60 text-[var(--reading-foreground)] hover:border-border hover:bg-accent/40',
              )}
              // Keep native label activation, but do not focus the hidden input
              // on pointer down: focus would scroll the transcript to the input.
              onMouseDown={(event) => event.preventDefault()}
            >
              <input
                type="checkbox"
                className="peer sr-only"
                checked={checked}
                onChange={() => toggle(option.id)}
              />
              <span
                className={cn(
                  'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
                  checked
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border/70 bg-background',
                )}
                aria-hidden
              >
                {checked ? <Check className="size-3" strokeWidth={2.5} /> : null}
              </span>
              <span className="min-w-0 flex-1">{option.label}</span>
              {i < 9 ? (
                <span
                  className="type-caption hidden size-5 shrink-0 items-center justify-center rounded border border-border/60 font-mono text-subtle-foreground sm:inline-flex"
                  aria-hidden
                >
                  {i + 1}
                </span>
              ) : null}
            </label>
          );
        })}
        <Textarea
          ref={noteRef}
          value={text}
          maxLength={MAX_CHOICE_TEXT_CHARS}
          placeholder="Add a note (optional) — typing in the composer lands here too"
          rows={2}
          className="type-ui mt-1 min-h-12 border-border/60 bg-background"
          onChange={(event) => setText(event.target.value)}
        />
      </fieldset>
      <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          disabled={Boolean(busy)}
          onClick={() => void act({ skipped: true }, 'skip')}
        >
          {busy === 'skip' ? 'Skipping…' : 'Skip and stop'}
        </Button>
        <div className="flex items-center gap-2">
          <span className="type-caption hidden text-subtle-foreground sm:inline">
            Ctrl+Enter
          </span>
          <Button
            type="button"
            size="sm"
            disabled={Boolean(busy) || !canContinue}
            onClick={submit}
          >
            {busy === 'continue' ? 'Continuing…' : 'Continue'}
          </Button>
        </div>
      </div>
    </section>
  );
}

function parseArgs(raw?: string): { question?: string } {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as { question?: string }) : {};
  } catch {
    return {};
  }
}

/**
 * What the reader answered, from the offer_choice result the tool wrote
 * ("User chose:\n- Label (id: x)\nAlso directed: …"). Live previews may be
 * clipped; whatever parses is shown.
 */
export function parseChoiceAnswer(row: ToolCallRow): {
  picked: string[];
  note?: string;
  skipped: boolean;
} {
  const result = row.result ?? '';
  if (row.status === 'skipped') return { picked: [], skipped: true };
  const picked: string[] = [];
  let note: string | undefined;
  for (const line of result.split('\n')) {
    const option = /^- (.*?)(?: \(id: [^)]*\))?$/.exec(line);
    if (option) {
      picked.push(option[1]);
      continue;
    }
    const directed = /^(?:Also|User) directed: (.*)$/.exec(line);
    if (directed) note = directed[1];
  }
  return { picked, ...(note ? { note } : {}), skipped: false };
}

/**
 * The question after it was answered: one trail line in the flow, so the
 * reader's decision stays where it happened instead of disappearing into a
 * tool group. Expands to the full question and answer.
 */
export function ChoiceRecord({ row }: { row: ToolCallRow }) {
  const question = parseArgs(row.args).question?.trim() || 'Question';
  if (row.status === 'running') return null; // the live card covers it
  const answer = parseChoiceAnswer(row);
  const failed = row.status === 'failed';
  const summary = answer.skipped
    ? 'Skipped'
    : failed
      ? 'Not answered'
      : [answer.picked.join(', '), answer.note ? `“${answer.note}”` : '']
          .filter(Boolean)
          .join(' · ') || 'Answered';

  return (
    <TrailLine
      icon={<MessageCircleQuestion className="size-3.5" strokeWidth={1.75} />}
      ariaLabel={`Asked: ${question}`}
      label={
        <>
          <span className="text-subtle-foreground">Asked</span> {question}
          <span className="text-subtle-foreground"> → </span>
          <span className="text-foreground/85">{summary}</span>
        </>
      }
    >
      <div className="type-ui space-y-1 leading-relaxed">
        <p className="text-[var(--reading-foreground)]">{question}</p>
        {answer.picked.length > 0 ? (
          <ul className="space-y-0.5">
            {answer.picked.map((label) => (
              <li key={label} className="flex items-start gap-2 text-foreground/85">
                <Check className="mt-1 size-3.5 shrink-0 text-subtle-foreground" />
                {label}
              </li>
            ))}
          </ul>
        ) : null}
        {answer.note ? (
          <p className="text-[var(--reading-foreground)]">Note: {answer.note}</p>
        ) : null}
        {answer.skipped ? (
          <p className="text-subtle-foreground">You skipped this question; the run stopped.</p>
        ) : null}
      </div>
    </TrailLine>
  );
}
