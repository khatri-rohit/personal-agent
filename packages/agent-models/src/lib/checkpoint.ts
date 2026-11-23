/**
 * Checkpoints (B3): what a workspace run changed on disk, and putting it
 * back. The host snapshots the folder before an Agent run and again when
 * it ends; these are the shapes the API returns about those snapshots.
 */

/** One file a run (or a set of runs) changed: added, modified or deleted. */
export type FileChange = {
  /** Workspace-relative, forward slashes. */
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** Lines added and removed; absent for binary files. */
  added?: number;
  removed?: number;
  /** A nested repository (its own `.git`): listed, never restored. */
  nestedRepo?: boolean;
};

/** `GET /threads/:id/changes?runIds=…`: the combined change of those runs. */
export type RunChanges = {
  /** False when no snapshot exists for one of the runs (Ask/Plan run, older run, snapshot failed). */
  available: boolean;
  files: FileChange[];
  /** What a snapshot never holds, so an undo cannot bring it back. */
  notCovered: string;
};

/** Outcome of putting files back (undo, or Restore on a retry or edit). */
export type RevertResult = {
  restored: string[];
  /** Changed again after the run (by you or a later run): left as they are. */
  conflicts: string[];
  /** Could not be written (locked by another program, permissions): left as they are. */
  failed: { path: string; error: string }[];
  /** Inside a nested repository: left as they are. */
  skipped: string[];
  /** Already as they were before the runs (undone earlier): nothing to do. */
  alreadyUndone: string[];
};

/** Paths the snapshot leaves out on purpose (besides the folder's own .gitignore). */
export const CHECKPOINT_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.next/', '.nx/'] as const;

export const CHECKPOINT_NOT_COVERED =
  "Files your .gitignore ignores, dependency and build folders (node_modules, .venv, .next, .nx), and anything outside this folder aren't snapshotted, so undo can't bring them back.";

/** One line for a toast after files were put back. */
export function revertSummary(result: RevertResult): string {
  const parts = [`${result.restored.length} file${result.restored.length === 1 ? '' : 's'} restored`];
  if (result.alreadyUndone.length > 0) parts.push(`${result.alreadyUndone.length} already undone`);
  if (result.conflicts.length > 0) {
    parts.push(`${result.conflicts.length} left as is because they changed since (${result.conflicts.slice(0, 3).join(', ')}${result.conflicts.length > 3 ? ', …' : ''})`);
  }
  if (result.failed.length > 0) {
    parts.push(`${result.failed.length} could not be written (${result.failed.slice(0, 3).map((f) => f.path).join(', ')})`);
  }
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} inside a nested repository skipped`);
  return `${parts.join('; ')}.`;
}
