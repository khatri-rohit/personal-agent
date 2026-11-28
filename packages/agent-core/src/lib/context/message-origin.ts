import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * Who wrote a user-role message of the prompt. The chat format has one
 * "user" role, and the harness speaks in it too: a note to the model, the
 * task record written into the history, the per-call card, and the context
 * it puts in front of the user's own message. A reader that needs "what the
 * user said" must not take a user-role message at its word, or harness text
 * is quoted as the user's request, trusted as the user's URLs, or read as a
 * new instruction.
 *
 * Every user-role message the harness writes is made by `harnessMessage`,
 * which records its kind here; `originOf` and `userTextOf` are how readers
 * ask. The record is by object identity (the provider never sees it): the
 * loop moves these objects between arrays, it does not copy them. A copy
 * (a future spread, a round-trip) would lose it, so `originOf` falls back to
 * the fixed header each kind starts with. The one kind without a header is a
 * note with `flags.harnessNotes` off (the A/B baseline); a copy of that reads
 * as the user's, as every note did before this module.
 *
 * Text a user types that starts with one of these headers is read as the
 * harness's. That errs the safe way: it is not trusted as the user's URLs
 * and not quoted as their request.
 */

/** A user-role message's writer: the user, or what the harness wrote. */
export type UserRoleOrigin =
  | 'user'
  /** Loop control the model must read as the harness speaking (a nudge, a limit handoff). */
  | 'note'
  /** The run's task record, written into the history at a prompt boundary. */
  | 'record'
  /** The per-call harness card (state, open items, advice). */
  | 'card';

type HarnessKind = Exclude<UserRoleOrigin, 'user'>;

/** Header of a harness note (when `flags.harnessNotes` is on). */
export const HARNESS_NOTE_PREFIX = '[Harness note, not from the user]';
/** Header of the task record message. */
export const RECORD_MESSAGE_PREFIX =
  "[Task record: this run's findings so far, written by the harness at its last prompt boundary, not from the user]";
/** Header of the harness card. */
export const CARD_HEADER = "[Harness card: this run's state, rebuilt every step by the harness, not from the user]";

const HEADERS: Array<[string, HarnessKind]> = [
  [CARD_HEADER, 'card'],
  [RECORD_MESSAGE_PREFIX, 'record'],
  [HARNESS_NOTE_PREFIX, 'note'],
];

const HARNESS_WRITTEN = new WeakMap<object, HarnessKind>();

/** A user-role message written by the harness, remembered as such. */
export function harnessMessage(kind: HarnessKind, content: string): ChatCompletionMessageParam {
  const message: ChatCompletionMessageParam = { role: 'user', content };
  HARNESS_WRITTEN.set(message, kind);
  return message;
}

/** Who wrote this message, for a user-role message; null for any other role. */
export function originOf(message: ChatCompletionMessageParam | undefined): UserRoleOrigin | null {
  if (message?.role !== 'user') return null;
  const recorded = HARNESS_WRITTEN.get(message);
  if (recorded) return recorded;
  if (typeof message.content === 'string') {
    for (const [header, kind] of HEADERS) if (message.content.startsWith(header)) return kind;
  }
  return 'user';
}

export const HARNESS_CONTEXT_OPEN =
  '[Context from the harness for this message. The user did not write it.]';
export const HARNESS_CONTEXT_CLOSE =
  "[End of harness context. The user's message follows.]";

/**
 * The skills a user named and the threads they attached lead the message's
 * text between these lines, as references (names and ids). They are not
 * the user's words.
 */
export const ATTACHMENTS_OPEN =
  "[The user attached these to this message (load a skill with load_skill, read a thread with read_thread). Not the user's own words.]";
export const ATTACHMENTS_CLOSE = "[End of attachments. The user's message follows.]";

function withoutBlock(text: string, open: string, close: string): string {
  if (!text.startsWith(open)) return text;
  const end = text.indexOf(close);
  return end < 0 ? text : text.slice(end + close.length).trimStart();
}

/** The user's own words of a text with the harness context header and/or attachments in front. */
export function withoutHarnessContext(text: string): string {
  return withoutBlock(
    withoutBlock(text, HARNESS_CONTEXT_OPEN, HARNESS_CONTEXT_CLOSE),
    ATTACHMENTS_OPEN,
    ATTACHMENTS_CLOSE,
  );
}

/**
 * What the user wrote in this message: its text without the harness context
 * header. Null for a message the user did not write (another role, or a
 * user-role message from the harness).
 */
export function userTextOf(message: ChatCompletionMessageParam | undefined): string | null {
  if (!message || originOf(message) !== 'user') return null;
  const text =
    typeof message.content === 'string'
      ? message.content
      : (message.content ?? [])
          .map((part) => (part.type === 'text' ? part.text : ''))
          .filter(Boolean)
          .join('\n\n');
  return withoutHarnessContext(text);
}

/**
 * What the user asked in the current turn: the newest message the user
 * wrote, in their own words. Harness-written user-role messages after it
 * (notes, the task record) are skipped.
 */
export function currentUserRequest(messages: ChatCompletionMessageParam[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = userTextOf(messages[i]);
    if (text !== null) return text;
  }
  return undefined;
}
