import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isSpecSkillName,
  listSkillCatalogs,
  parseSkillMarkdown,
  readSkillFile,
  SKILL_DESCRIPTION_MAX,
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

export type SkillDocument = SkillCatalogEntry & {
  content: string;
};

/** Same user roots the host passes to core: shared ecosystem dir, then AGENT_HOME. */
export function userSkillDirectories(
  agentHome: string,
  homedir: string = os.homedir(),
): string[] {
  return [
    path.join(homedir, '.agents', 'skills'),
    path.join(agentHome, 'skills'),
  ];
}

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

function listingForFolder(folder: string): SkillCatalogEntry | undefined {
  const catalogs = listSkillCatalogs();
  const all = [
    ...catalogs.workspace,
    ...catalogs.user,
    ...catalogs.builtin,
  ];
  return (
    all.find((skill) => skill.folder === folder && !skill.issue) ??
    all.find((skill) => skill.folder === folder)
  );
}

/** Read SKILL.md for a listed folder. Built-ins are included; they cannot be deleted. */
export async function readSkillDocument(input: {
  folder: string;
}): Promise<SkillDocument> {
  const folder = input.folder.trim();
  assertFolderSegment(folder);
  const listing = listingForFolder(folder);
  if (!listing) {
    throw new SkillError(`Skill "${folder}" was not found.`, 404);
  }
  const content = readSkillFile(folder);
  if (content === null) {
    throw new SkillError(`Skill "${folder}" was not found.`, 404);
  }
  return { ...listing, content };
}

export async function deleteUserSkill(input: {
  agentHome: string;
  folderName: string;
  homedir?: string;
}): Promise<void> {
  const folderName = input.folderName.trim();
  assertFolderSegment(folderName);
  const listing = listingForFolder(folderName);
  if (listing && listing.source !== 'user') {
    throw new SkillError(
      listing.source === 'builtin'
        ? 'Built-in skills cannot be removed.'
        : 'Workspace skills cannot be removed from this panel.',
      403,
    );
  }
  const roots = userSkillDirectories(
    input.agentHome,
    input.homedir ?? os.homedir(),
  );
  let removed = false;
  for (const root of roots) {
    const dir = path.join(root, folderName);
    if (!existsSync(dir)) continue;
    await rm(dir, { recursive: true, force: true });
    removed = true;
  }
  if (!removed) {
    throw new SkillError(`Skill "${folderName}" was not found.`, 404);
  }
}

/**
 * Write a hand-authored skill to `$AGENT_HOME/skills/<name>/SKILL.md`.
 * Refuses a name that exists in either user root: an existing folder
 * may be an installed pack.
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
  const content = withFolderName(input.content, name);
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
    throw new SkillError('Skill is larger than 64 KB.', 413);
  }
  const parsed = parseSkillMarkdown(content, name);
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

  const roots = userSkillDirectories(
    input.agentHome,
    input.homedir ?? os.homedir(),
  );
  for (const root of roots) {
    if (!existsSync(path.join(root, name))) continue;
    throw new SkillError(`A skill named "${name}" already exists.`, 409);
  }
  const dir = path.join(input.agentHome, 'skills', name);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.SKILL.md.${process.pid}.tmp`);
  await writeFile(
    tmp,
    content.endsWith('\n') ? content : `${content}\n`,
    'utf8',
  );
  await rename(tmp, path.join(dir, 'SKILL.md'));
  return { folder: name };
}
