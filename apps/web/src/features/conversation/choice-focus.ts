/**
 * The open choice card's handle, so the composer and the type-to-focus
 * listener can route text into the card's note field instead of queuing a
 * separate message while the agent is paused on a question. Same pattern as
 * composer-focus: one module-level slot, set by the mounted card.
 */
export type ChoiceHandle = {
  /** Append text to the card's note field and focus it. */
  addNote: (text: string) => void;
  /** Toggle option `index` (0-based); false when there is no such option. */
  toggleOption: (index: number) => boolean;
};

let current: ChoiceHandle | null = null;

export function setChoiceHandle(handle: ChoiceHandle | null): void {
  current = handle;
}

export function getChoiceHandle(): ChoiceHandle | null {
  return current;
}
