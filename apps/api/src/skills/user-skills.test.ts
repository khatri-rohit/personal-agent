import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  configureSkillRoots,
  getSkill,
  listSkillCatalogs,
  standardUserSkillRoots,
} from '@agent/agent-core';

import {
  SkillError,
  createUserSkill,
  deleteUserSkill,
  readSkillDocument,
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
      ...standardUserSkillRoots(home, homedir),
    ]);
    const shared = path.join(homedir, '.agents', 'skills');
    return { builtin, home, homedir, shared };
  }

  function trashEntries(home: string): string[] {
    const trash = path.join(home, '.trash', 'skills');
    return existsSync(trash) ? readdirSync(trash) : [];
  }

  it('moves a removed pack to the trash, not into oblivion', async () => {
    const { home, homedir } = harness();
    await createUserSkill({
      agentHome: home,
      name: 'kept-body',
      content: '---\nname: kept-body\ndescription: D.\n---\n\nRecover me.\n',
      homedir,
    });
    const { trashedTo } = await deleteUserSkill({
      agentHome: home,
      folderName: 'kept-body',
      homedir,
    });
    expect(existsSync(path.join(home, 'skills', 'kept-body'))).toBe(false);
    expect(readFileSync(path.join(trashedTo, 'SKILL.md'), 'utf8')).toContain(
      'Recover me.',
    );
    expect(getSkill('kept-body')).toBeUndefined();
  });

  it('never removes from the shared ~/.agents/skills folder', async () => {
    const { home, homedir, shared } = harness();
    writeSkill(
      shared,
      'npx-pack',
      '---\nname: npx-pack\ndescription: From npx skills.\n---\n\nShared.\n',
    );
    await expect(
      deleteUserSkill({ agentHome: home, folderName: 'npx-pack', homedir }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('npx skills remove npx-pack -g'),
    });
    expect(existsSync(path.join(shared, 'npx-pack', 'SKILL.md'))).toBe(true);
    expect(trashEntries(home)).toEqual([]);
  });

  it('removes only the agent-home copy when both folders have the pack', async () => {
    const { home, homedir, shared } = harness();
    writeSkill(
      shared,
      'both',
      '---\nname: both\ndescription: Shared copy.\n---\n\nS.\n',
    );
    writeSkill(
      path.join(home, 'skills'),
      'both',
      '---\nname: both\ndescription: Home copy.\n---\n\nH.\n',
    );
    expect(getSkill('both')?.description).toBe('Home copy.');
    await deleteUserSkill({ agentHome: home, folderName: 'both', homedir });
    expect(existsSync(path.join(shared, 'both', 'SKILL.md'))).toBe(true);
    // The shared copy stops being shadowed and loads.
    expect(getSkill('both')?.description).toBe('Shared copy.');
  });

  it('sweeps trash older than 30 days on the next removal', async () => {
    const { home, homedir } = harness();
    for (const name of ['old-one', 'new-one']) {
      writeSkill(
        path.join(home, 'skills'),
        name,
        `---\nname: ${name}\ndescription: D.\n---\n\nX.\n`,
      );
    }
    const old = await deleteUserSkill({
      agentHome: home,
      folderName: 'old-one',
      homedir,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    // 31 days after the first removal's own clock: the trashed folder's
    // mtime is real time, so sweep with a clock far enough ahead of it.
    await deleteUserSkill({
      agentHome: home,
      folderName: 'new-one',
      homedir,
      now: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
    });
    expect(existsSync(old.trashedTo)).toBe(false);
  });

  it('refuses Windows device names that are spec-valid', async () => {
    const { home, homedir } = harness();
    await expect(
      createUserSkill({
        agentHome: home,
        name: 'con',
        content: '---\nname: con\ndescription: D.\n---\n\nX.\n',
        homedir,
      }),
    ).rejects.toMatchObject({ status: 400 } satisfies Partial<SkillError>);
  });

  it('keeps both trash entries when one name is removed twice at once', async () => {
    const { home, homedir } = harness();
    const now = new Date();
    const removeOnce = async () => {
      writeSkill(
        path.join(home, 'skills'),
        'again',
        '---\nname: again\ndescription: D.\n---\n\nX.\n',
      );
      return deleteUserSkill({ agentHome: home, folderName: 'again', homedir, now });
    };
    const first = await removeOnce();
    const second = await removeOnce();
    expect(second.trashedTo).not.toBe(first.trashedTo);
    expect(existsSync(first.trashedTo)).toBe(true);
    expect(existsSync(second.trashedTo)).toBe(true);
  });

  it('says why an oversized pack cannot be shown', async () => {
    const { home } = harness();
    writeSkill(
      path.join(home, 'skills'),
      'too-big',
      `---\nname: too-big\ndescription: D.\n---\n\n${'x'.repeat(1024 * 1024 + 1)}\n`,
    );
    await expect(
      readSkillDocument({ folder: 'too-big' }),
    ).rejects.toMatchObject({ status: 422 } satisfies Partial<SkillError>);
  });

  it('reads SKILL.md from the root the caller names', async () => {
    const { home, shared } = harness();
    writeSkill(
      shared,
      'twin',
      '---\nname: twin\ndescription: Shared twin.\n---\n\nShared body.\n',
    );
    writeSkill(
      path.join(home, 'skills'),
      'twin',
      '---\nname: twin\ndescription: Home twin.\n---\n\nHome body.\n',
    );
    const sharedDoc = await readSkillDocument({ folder: 'twin', root: 'agents' });
    expect(sharedDoc).toMatchObject({ root: 'agents', issue: 'conflict' });
    expect(sharedDoc.content).toContain('Shared body.');
    const winner = await readSkillDocument({ folder: 'twin' });
    expect(winner.root).toBe('agent-home');
    expect(winner.content).toContain('Home body.');
  });

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

  it('lets a user pack override a built-in name', async () => {
    const { home } = harness();
    await createUserSkill({
      agentHome: home,
      name: 'keep-me',
      content: '---\nname: keep-me\ndescription: User override.\n---\n\nMine.\n',
    });
    const doc = await readSkillDocument({ folder: 'keep-me' });
    expect(doc.source).toBe('user');
    expect(doc.issue).toBeUndefined();
    expect(doc.content).toContain('Mine.');
    expect(listSkillCatalogs().builtin[0]?.issue).toBe('conflict');
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

  it('409s a name that already exists in the shared ~/.agents/skills root', async () => {
    const { home, homedir } = harness();
    writeSkill(
      path.join(homedir, '.agents', 'skills'),
      'installed-pack',
      '---\nname: installed-pack\ndescription: Installed via npx skills add.\n---\n\nPack body.\n',
    );
    await expect(
      createUserSkill({
        agentHome: home,
        name: 'installed-pack',
        content: '---\nname: installed-pack\ndescription: Mine now.\n---\n\nMine.\n',
        homedir,
      }),
    ).rejects.toMatchObject({ status: 409 } satisfies Partial<SkillError>);
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
