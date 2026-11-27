import {
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  invalidateSkillCatalog,
  isSpecSkillName,
  listSkillCatalogs,
  parseSkillMarkdown,
  readSkillFile,
  SKILL_DESCRIPTION_MAX,
  standardUserSkillRoots,
  type SkillCatalogEntry,
} from '@agent/agent-core';

export class SkillError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SkillError';
  }
}

/** Hand-written skills stay small: they are prompt text, not archives. */
const MAX_SKILL_BYTES = 64 * 1024;

/** Removed packs are kept this long in `$AGENT_HOME/.trash/skills`, then swept. */
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The root this panel owns: hand-written packs. `~/.agents/skills` belongs to installers. */
const OWN_ROOT = 'agent-home';
const SHARED_ROOT = 'agents';

/** Refused on every OS, so a pack written here stays portable to Windows. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

export type SkillDocument = SkillCatalogEntry & {
  content: string;
};

function assertFolderSegment(folder: string): void {
  if (
    !folder ||
    folder === '.' ||
    folder === '..' ||
    folder.includes('/') ||
    folder.includes('\\') ||
    folder.includes('\0')
  ) {
    throw new SkillError('Invalid skill folder.', 400);
  }
}

function withFolderName(content: string, folder: string): string {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) {
    throw new SkillError(
      'Start the skill with a --- frontmatter block that has name: and description:.',
      400,
    );
  }
  const end = text.indexOf('\n---', 3);
  if (end < 0) {
    throw new SkillError(
      'Start the skill with a --- frontmatter block that has name: and description:.',
      400,
    );
  }
  let fm = text.slice(3, end);
  if (/^name\s*:/m.test(fm)) {
    fm = fm.replace(/^name\s*:.*$/m, `name: ${folder}`);
  } else {
    fm = `\nname: ${folder}${fm.startsWith('\n') ? '' : '\n'}${fm}`;
  }
  return `---${fm}\n---${text.slice(end + 4)}`;
}

/** The two user folders by role: shared (`~/.agents/skills`) and own (`$AGENT_HOME/skills`). */
function userFolders(agentHome: string, homedir: string) {
  const roots = standardUserSkillRoots(agentHome, homedir);
  const shared = roots.find((root) => root.id === SHARED_ROOT);
  const own = roots.find((root) => root.id === OWN_ROOT);
  if (!shared || !own) throw new Error('User skill roots are misconfigured.');
  return { shared: shared.path, own: own.path, all: roots.map((root) => root.path) };
}

function allListings(): SkillCatalogEntry[] {
  const catalogs = listSkillCatalogs();
  return [...catalogs.user, ...catalogs.workspace, ...catalogs.builtin];
}

/**
 * The listing for `folder`: the one in `root` when given; otherwise the
 * loadable one, else any (an invalid or shadowed pack is still readable).
 */
function listingFor(
  folder: string,
  root?: string,
): SkillCatalogEntry | undefined {
  const matches = allListings().filter(
    (skill) =>
      skill.folder === folder && (root === undefined || skill.root === root),
  );
  return matches.find((skill) => !skill.issue) ?? matches[0];
}

/** Read SKILL.md for a listed folder, from the same root as the listing returned. */
export async function readSkillDocument(input: {
  folder: string;
  root?: string;
}): Promise<SkillDocument> {
  const folder = input.folder.trim();
  assertFolderSegment(folder);
  const root = input.root?.trim() || undefined;
  const listing = listingFor(folder, root);
  if (!listing) {
    throw new SkillError(`Skill "${folder}" was not found.`, 404);
  }
  const content = readSkillFile(folder, listing.root);
  if (content === null) {
    // Listed but unreadable (too large, or removed a moment ago): say why.
    if (listing.issue === 'invalid' && listing.reason) {
      throw new SkillError(`Skill "${folder}" cannot be shown: ${listing.reason}.`, 422);
    }
    throw new SkillError(`Skill "${folder}" was not found.`, 404);
  }
  return { ...listing, content };
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file); // a broken symlink still counts as present
    return true;
  } catch {
    return false;
  }
}

/** Move `from` to `to`; across volumes, copy then remove. Links move as links. */
async function moveDir(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
}

async function sweepTrash(
  trash: string,
  now: number,
  keep: string,
): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(trash);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keep) continue; // the entry this removal just made
    const entry = path.join(trash, name);
    try {
      const stat = await lstat(entry);
      if (now - stat.mtimeMs > TRASH_RETENTION_MS) {
        await rm(entry, { recursive: true, force: true });
      }
    } catch {
      /* best effort */
    }
  }
}

/**
 * Remove a hand-written pack from `$AGENT_HOME/skills`. It moves to
 * `$AGENT_HOME/.trash/skills/<folder>-<time>` (recoverable for 30 days),
 * never deleted outright.
 *
 * Never touches `~/.agents/skills`: other agents and `npx skills` (with its
 * lock file) own that folder, so removing there would break them or be
 * undone on their next restore.
 */
export async function deleteUserSkill(input: {
  agentHome: string;
  folderName: string;
  homedir?: string;
  now?: Date;
}): Promise<{ trashedTo: string }> {
  const folderName = input.folderName.trim();
  assertFolderSegment(folderName);
  const { shared, own } = userFolders(
    input.agentHome,
    input.homedir ?? os.homedir(),
  );
  const ownDir = path.join(own, folderName);

  if (await exists(ownDir)) {
    const now = input.now ?? new Date();
    const trash = path.join(input.agentHome, '.trash', 'skills');
    await mkdir(trash, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    let to = path.join(trash, `${folderName}-${stamp}`);
    // Two removals of one name inside the same millisecond must not collide.
    for (let n = 2; await exists(to); n++) {
      to = path.join(trash, `${folderName}-${stamp}-${n}`);
    }
    await moveDir(ownDir, to);
    invalidateSkillCatalog();
    await sweepTrash(trash, now.getTime(), path.basename(to));
    return { trashedTo: to };
  }

  if (await exists(path.join(shared, folderName))) {
    throw new SkillError(
      `"${folderName}" is installed in ${shared}, which other agents and npx skills share. Remove it there with: npx skills remove ${folderName} -g`,
      409,
    );
  }
  const listing = listingFor(folderName);
  if (listing?.source === 'builtin') {
    throw new SkillError('Built-in skills cannot be removed.', 403);
  }
  if (listing?.source === 'workspace') {
    throw new SkillError(
      'Workspace skills live in the project. Remove them from its .agents/skills folder.',
      403,
    );
  }
  throw new SkillError(`Skill "${folderName}" was not found.`, 404);
}

/**
 * Write a hand-authored skill to `$AGENT_HOME/skills/<name>/SKILL.md`.
 * Refuses a name that exists in either user root: an existing folder
 * may be an installed pack. A built-in of the same name is allowed and
 * is replaced by it (the panel shows the built-in as shadowed).
 */
export async function createUserSkill(input: {
  agentHome: string;
  name: string;
  content: string;
  homedir?: string;
}): Promise<{ folder: string }> {
  const name = input.name.trim();
  if (!isSpecSkillName(name)) {
    throw new SkillError(
      'Name must be 1–64 characters of lowercase letters, digits, and hyphens (e.g. my-skill).',
      400,
    );
  }
  // Spec-valid, but Windows cannot create a folder with a device name.
  if (WINDOWS_DEVICE_NAME.test(name)) {
    throw new SkillError(
      `"${name}" is a reserved device name on Windows; pick another name.`,
      400,
    );
  }
  const content = withFolderName(input.content, name);
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
    throw new SkillError('Skill is larger than 64 KB.', 413);
  }
  const parsed = parseSkillMarkdown(content, name);
  if (parsed.error) {
    throw new SkillError(`Frontmatter: ${parsed.error}.`, 400);
  }
  if (!parsed.name || !parsed.description) {
    throw new SkillError(
      'Start the skill with a --- frontmatter block that has name: and description:.',
      400,
    );
  }
  if (parsed.description.length > SKILL_DESCRIPTION_MAX) {
    throw new SkillError(
      `Description must be at most ${SKILL_DESCRIPTION_MAX} characters.`,
      400,
    );
  }

  const folders = userFolders(input.agentHome, input.homedir ?? os.homedir());
  for (const root of folders.all) {
    if (!(await exists(path.join(root, name)))) continue;
    throw new SkillError(`A skill named "${name}" already exists.`, 409);
  }
  const parent = folders.own;
  const dir = path.join(parent, name);
  await mkdir(parent, { recursive: true });
  try {
    // Non-recursive: two creates racing on one name cannot both win.
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SkillError(`A skill named "${name}" already exists.`, 409);
    }
    throw error;
  }
  const tmp = path.join(dir, `.SKILL.md.${process.pid}.tmp`);
  try {
    await writeFile(
      tmp,
      content.endsWith('\n') ? content : `${content}\n`,
      'utf8',
    );
    await rename(tmp, path.join(dir, 'SKILL.md'));
  } catch (error) {
    // An empty folder would block the name with a 409 and never list.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  invalidateSkillCatalog();
  return { folder: name };
}
