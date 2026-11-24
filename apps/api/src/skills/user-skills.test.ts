import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { configureSkillRoots } from '@agent/agent-core';

import {
  SkillError,
  createUserSkill,
  deleteUserSkill,
  readSkillDocument,
  userSkillDirectories,
} from './user-skills';

function writeSkill(root: string, folder: string, markdown: string): void {
  const dir = path.join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), markdown, 'utf8');
}

describe('user skills store', () => {
  const dirs: string[] = [];

  afterEach(() => {
    configureSkillRoots(null);
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmp(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pa-api-skills-'));
    dirs.push(dir);
    return dir;
  }

  function harness() {
    const builtin = tmp();
    const home = tmp();
    const homedir = tmp();
    writeSkill(
      builtin,
      'keep-me',
      '---\nname: keep-me\ndescription: Built-in pack.\n---\n\nBuilt-in body.\n',
    );
    configureSkillRoots([
      { scope: 'builtin', path: builtin },
      ...userSkillDirectories(home, homedir).map((skillPath) => ({
        scope: 'user' as const,
        path: skillPath,
      })),
    ]);
    return { builtin, home, homedir };
  }

  it('creates a spec-valid skill under AGENT_HOME and reads it back', async () => {
    const { home } = harness();
    await createUserSkill({
      agentHome: home,
      name: 'my-pack',
      content:
        '---\nname: other-name\ndescription: When to load this pack.\n---\n\nDo the work.\n',
    });
    const doc = await readSkillDocument({ folder: 'my-pack' });
    expect(doc.source).toBe('user');
    expect(doc.issue).toBeUndefined();
    expect(doc.name).toBe('my-pack');
    expect(doc.content).toMatch(/^name: my-pack$/m);
    expect(doc.content).toContain('Do the work.');
  });

  it('refuses a reserved built-in name', async () => {
    const { home } = harness();
    await expect(
      createUserSkill({
        agentHome: home,
        name: 'keep-me',
        content: '---\nname: keep-me\ndescription: Shadow.\n---\n\nNo.\n',
      }),
    ).rejects.toMatchObject({
      name: 'SkillError',
      status: 409,
    } satisfies Partial<SkillError>);
  });

  it('refuses a name that is not spec-shaped', async () => {
    const { home } = harness();
    await expect(
      createUserSkill({
        agentHome: home,
        name: 'Bad_Name',
        content: '---\nname: Bad_Name\ndescription: No.\n---\n\nNo.\n',
      }),
    ).rejects.toMatchObject({ status: 400 } satisfies Partial<SkillError>);
  });

  it('reads a built-in body and refuses to delete it', async () => {
    const { home, homedir } = harness();
    const doc = await readSkillDocument({ folder: 'keep-me' });
    expect(doc.source).toBe('builtin');
    expect(doc.content).toContain('Built-in body.');
    await expect(
      deleteUserSkill({
        agentHome: home,
        folderName: 'keep-me',
        homedir,
      }),
    ).rejects.toMatchObject({ status: 403 } satisfies Partial<SkillError>);
  });

  it('deletes a user skill from AGENT_HOME and 404s a second delete', async () => {
    const { home, homedir } = harness();
    await createUserSkill({
      agentHome: home,
      name: 'temp-pack',
      content: '---\nname: temp-pack\ndescription: Temporary.\n---\n\nBye.\n',
    });
    await deleteUserSkill({
      agentHome: home,
      folderName: 'temp-pack',
      homedir,
    });
    await expect(
      readSkillDocument({ folder: 'temp-pack' }),
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<SkillError>);
    await expect(
      deleteUserSkill({
        agentHome: home,
        folderName: 'temp-pack',
        homedir,
      }),
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<SkillError>);
  });

  it('404s a folder that is not on disk', async () => {
    harness();
    await expect(
      readSkillDocument({ folder: 'missing-pack' }),
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<SkillError>);
  });
});
