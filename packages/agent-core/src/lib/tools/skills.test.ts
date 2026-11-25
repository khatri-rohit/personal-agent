import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '@agent/agent-models';

import {
  configureSkillRoots,
  extraSkillRoots,
  formatSkillBodies,
  formatSkillsCatalog,
  getSkill,
  listSkillCatalogs,
  listSkills,
  load_skill,
  parseSkillMarkdown,
  readSkillFile,
  resolveSkillsRoot,
  runWithSkillRoots,
  SKILL_FILE_MAX_BYTES,
  type ParsedSkill,
} from './skills';
import type { SkillMetadata } from './types';

function ctx(): ToolContext {
  return {
    runId: 'r1',
    threadId: 't1',
    origin: 'eval',
    signal: new AbortController().signal,
  };
}

const catalog: SkillMetadata[] = [
  {
    name: 'patch-and-verify',
    description: 'Edit then run the project check.',
  },
  {
    name: 'home-research',
    description: 'Multi-source web answer discipline.',
  },
];

describe('parseSkillMarkdown', () => {
  it('reads folded YAML descriptions', () => {
    const parsed = parseSkillMarkdown(
      [
        '---',
        'name: fold-demo',
        'description: >-',
        '  First line',
        '  second line',
        '---',
        '',
        'Body.',
      ].join('\n'),
      'fold-demo',
    );
    expect(parsed.name).toBe('fold-demo');
    expect(parsed.description).toBe('First line second line');
    expect(parsed.instructions).toBe('Body.');
  });

  it('reads name and description and ignores extra frontmatter', () => {
    const parsed: ParsedSkill = parseSkillMarkdown(
      [
        '---',
        'name: patch-and-verify',
        'description: Edit then verify.',
        'when: patch, edit, implement',
        'not: trivia, explain',
        'modes: workspace',
        '---',
        '',
        'Body here.',
      ].join('\n'),
      'fallback',
    );
    expect(parsed.name).toBe('patch-and-verify');
    expect(parsed.description).toBe('Edit then verify.');
    expect(parsed.instructions).toBe('Body here.');
  });
});

describe('formatSkillsCatalog', () => {
  it('lists name and description only', () => {
    const text = formatSkillsCatalog(catalog);
    expect(text).toContain('- patch-and-verify:');
    expect(text).toContain('- home-research:');
    expect(text).not.toContain('when:');
    expect(text).not.toContain('modes:');
    expect(text).toMatch(/Catalog of procedure packs/i);
  });
});

describe('formatSkillBodies', () => {
  it('inlines requested bodies and skips already loaded names', () => {
    const text = formatSkillBodies(
      ['patch-and-verify', 'missing-skill'],
      ['patch-and-verify'],
    );
    expect(text).toBe('');
    const loaded = formatSkillBodies(['patch-and-verify']);
    expect(loaded).toMatch(/# Loaded skills/);
    expect(loaded).toContain('## patch-and-verify');
    expect(loaded).toMatch(/Use this when the user asked you to change code/i);
  });
});

describe('load_skill', () => {
  it('loads any catalog skill (no run-set jail)', async () => {
    const result = await load_skill.execute(
      { skill_name: 'patch-and-verify' },
      ctx(),
    );
    expect(result).not.toMatch(/not selected/i);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(20);
  });

  it('reports available names when missing', async () => {
    const result = await load_skill.execute(
      { skill_name: 'no-such-skill' },
      ctx(),
    );
    expect(result).toMatch(/Skill not found/i);
    expect(result).toMatch(/Available skills:/i);
  });
});

function writeSkill(root: string, folder: string, markdown: string): void {
  const dir = path.join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), markdown, 'utf8');
}

describe('skill catalog roots', () => {
  const dirs: string[] = [];

  afterEach(() => {
    configureSkillRoots(null);
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmp(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pa-skills-'));
    dirs.push(dir);
    return dir;
  }

  it('lets a user pack override a builtin; invalid folders stay listed', () => {
    const builtin = tmp();
    const user = tmp();
    writeSkill(
      builtin,
      'caveman-review',
      '---\nname: caveman-review\ndescription: Built-in review.\n---\n\nBody.\n',
    );
    writeSkill(
      user,
      'ok-pack',
      '---\nname: ok-pack\ndescription: A valid user pack.\n---\n\nDo the thing.\n',
    );
    writeSkill(
      user,
      'caveman-review',
      '---\nname: caveman-review\ndescription: Shadow attempt.\n---\n\nNo.\n',
    );
    writeSkill(
      user,
      'BadFolder',
      '---\nname: bad-folder\ndescription: Folder does not match name.\n---\n\nNo.\n',
    );
    configureSkillRoots([
      { scope: 'builtin', path: builtin },
      { scope: 'user', path: user },
    ]);

    expect(
      listSkills()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['caveman-review', 'ok-pack']);
    expect(getSkill('caveman-review')?.description).toBe('Shadow attempt.');
    expect(getSkill('ok-pack')?.instructions).toContain('Do the thing.');

    const { builtin: builtList, user: userList } = listSkillCatalogs();
    expect(builtList).toEqual([
      expect.objectContaining({
        name: 'caveman-review',
        folder: 'caveman-review',
        source: 'builtin',
        issue: 'conflict',
      }),
    ]);
    expect(userList.find((s) => s.folder === 'ok-pack')?.issue).toBeUndefined();
    expect(userList.find((s) => s.folder === 'caveman-review')?.issue).toBe(
      undefined,
    );
    expect(userList.find((s) => s.folder === 'BadFolder')?.issue).toBe(
      'invalid',
    );
  });

  it('lets a later user root win a duplicate name', () => {
    const builtin = tmp();
    const agents = tmp();
    const home = tmp();
    writeSkill(
      builtin,
      'keep-me',
      '---\nname: keep-me\ndescription: Built-in.\n---\n\nB.\n',
    );
    writeSkill(
      agents,
      'dup',
      '---\nname: dup\ndescription: From agents.\n---\n\nA.\n',
    );
    writeSkill(
      home,
      'dup',
      '---\nname: dup\ndescription: From home.\n---\n\nH.\n',
    );
    configureSkillRoots([
      { scope: 'builtin', path: builtin },
      { scope: 'user', path: agents },
      { scope: 'user', path: home },
    ]);
    expect(
      listSkills()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['dup', 'keep-me']);
    expect(getSkill('dup')?.description).toBe('From home.');
    const dups = listSkillCatalogs().user.filter((s) => s.name === 'dup');
    expect(dups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: 'From agents.',
          issue: 'conflict',
        }),
        expect.objectContaining({ description: 'From home.' }),
      ]),
    );
    expect(
      dups.find((s) => s.description === 'From home.')?.issue,
    ).toBeUndefined();
  });

  it('never lets a workspace pack replace a user or built-in pack', () => {
    const builtin = tmp();
    const user = tmp();
    const project = tmp();
    writeSkill(
      builtin,
      'review',
      '---\nname: review\ndescription: Built-in review.\n---\n\nB.\n',
    );
    writeSkill(
      builtin,
      'lint',
      '---\nname: lint\ndescription: Built-in lint.\n---\n\nL.\n',
    );
    writeSkill(
      user,
      'review',
      '---\nname: review\ndescription: User review.\n---\n\nU.\n',
    );
    const ws = path.join(project, '.agents', 'skills');
    writeSkill(
      ws,
      'review',
      '---\nname: review\ndescription: Workspace review.\n---\n\nW.\n',
    );
    writeSkill(
      ws,
      'lint',
      '---\nname: lint\ndescription: Workspace lint.\n---\n\nW.\n',
    );
    writeSkill(
      ws,
      'deploy-web',
      '---\nname: deploy-web\ndescription: Project deploy.\n---\n\nD.\n',
    );
    configureSkillRoots([
      { scope: 'builtin', path: builtin },
      { scope: 'user', path: user },
    ]);
    runWithSkillRoots(extraSkillRoots(project), () => {
      expect(getSkill('review')?.description).toBe('User review.');
      expect(getSkill('lint')?.description).toBe('Built-in lint.');
      // New names are the workspace's to add.
      expect(getSkill('deploy-web')?.scope).toBe('workspace');
      const { workspace, builtin: builtList } = listSkillCatalogs();
      expect(workspace.find((s) => s.name === 'review')).toMatchObject({
        issue: 'conflict',
        reason: expect.stringContaining('cannot replace the user pack'),
      });
      expect(workspace.find((s) => s.name === 'lint')?.issue).toBe('conflict');
      expect(
        workspace.find((s) => s.name === 'deploy-web')?.issue,
      ).toBeUndefined();
      expect(builtList.find((s) => s.name === 'lint')?.issue).toBeUndefined();
    });
    expect(getSkill('deploy-web')).toBeUndefined();
  });

  it('reads a folder reached through two roots once, under the first', () => {
    const builtin = tmp();
    const home = tmp();
    const agents = path.join(home, '.agents', 'skills');
    writeSkill(
      agents,
      'mine',
      '---\nname: mine\ndescription: Mine.\n---\n\nM.\n',
    );
    configureSkillRoots([
      { scope: 'builtin', path: builtin },
      { scope: 'user', id: 'agents', path: agents },
    ]);
    // A workspace bound at the home folder points at the same skills folder.
    runWithSkillRoots(extraSkillRoots(home), () => {
      const { user, workspace } = listSkillCatalogs();
      expect(user).toHaveLength(1);
      expect(workspace).toHaveLength(0);
      expect(user[0]?.issue).toBeUndefined();
    });
  });

  it('says why a pack is invalid', () => {
    const builtin = tmp();
    const user = tmp();
    writeSkill(user, 'no-fm', 'Just text.\n');
    writeSkill(user, 'bad-yaml', '---\nname: [unclosed\n---\n\nX.\n');
    writeSkill(user, 'Upper', '---\nname: Upper\ndescription: D.\n---\n\nX.\n');
    writeSkill(user, 'other', '---\nname: mismatch\ndescription: D.\n---\n\nX.\n');
    writeSkill(user, 'no-desc', '---\nname: no-desc\n---\n\nX.\n');
    writeSkill(
      user,
      'huge',
      `---\nname: huge\ndescription: Big.\n---\n\n${'x'.repeat(SKILL_FILE_MAX_BYTES + 1)}\n`,
    );
    configureSkillRoots([
      { scope: 'builtin', path: builtin },
      { scope: 'user', path: user },
    ]);
    const reasons = Object.fromEntries(
      listSkillCatalogs().user.map((s) => [s.folder, s.reason]),
    );
    expect(reasons['no-fm']).toMatch(/frontmatter/);
    expect(reasons['bad-yaml']).toMatch(/YAML/);
    expect(reasons['Upper']).toMatch(/lowercase/);
    expect(reasons['other']).toMatch(/must match its folder/);
    expect(reasons['no-desc']).toMatch(/description is missing/);
    expect(reasons['huge']).toMatch(/larger than/);
    expect(listSkills()).toEqual([]);
  });

  it('loads a pack whose folder is a symlink or junction', () => {
    const builtin = tmp();
    const user = tmp();
    const elsewhere = tmp();
    writeSkill(
      elsewhere,
      'linked',
      '---\nname: linked\ndescription: Via link.\n---\n\nL.\n',
    );
    try {
      symlinkSync(
        path.join(elsewhere, 'linked'),
        path.join(user, 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return; // the platform refuses links here; nothing to check
    }
    configureSkillRoots([
      { scope: 'builtin', path: builtin },
      { scope: 'user', path: user },
    ]);
    expect(getSkill('linked')?.instructions).toBe('L.');
  });

  it('holds one catalog for a frozen run, and sees edits outside it', () => {
    const builtin = tmp();
    const user = tmp();
    writeSkill(user, 'pack', '---\nname: pack\ndescription: v1.\n---\n\nOne.\n');
    configureSkillRoots([
      { scope: 'builtin', path: builtin },
      { scope: 'user', path: user },
    ]);
    runWithSkillRoots(
      [],
      () => {
        expect(getSkill('pack')?.description).toBe('v1.');
        writeSkill(
          user,
          'pack',
          '---\nname: pack\ndescription: version two.\n---\n\nTwo, longer.\n',
        );
        writeSkill(user, 'late', '---\nname: late\ndescription: L.\n---\n\nL.\n');
        expect(getSkill('pack')?.description).toBe('v1.');
        expect(getSkill('late')).toBeUndefined();
      },
      { freeze: true },
    );
    expect(getSkill('pack')?.description).toBe('version two.');
    expect(getSkill('late')).toBeDefined();
  });

  it('reads SKILL.md from the root a listing names', () => {
    const builtin = tmp();
    const agents = tmp();
    const home = tmp();
    writeSkill(agents, 'dup', '---\nname: dup\ndescription: A.\n---\n\nShared.\n');
    writeSkill(home, 'dup', '---\nname: dup\ndescription: H.\n---\n\nHome.\n');
    configureSkillRoots([
      { scope: 'builtin', path: builtin },
      { scope: 'user', id: 'agents', path: agents },
      { scope: 'user', id: 'agent-home', path: home },
    ]);
    expect(readSkillFile('dup', 'agents')).toContain('Shared.');
    expect(readSkillFile('dup', 'agent-home')).toContain('Home.');
    expect(readSkillFile('dup')).toContain('Home.');
    expect(readSkillFile('../dup')).toBeNull();
    expect(
      listSkillCatalogs().user.find((s) => s.root === 'agents')?.issue,
    ).toBe('conflict');
  });

  it('finds the built-in folder beside agent-core’s package.json', () => {
    const root = resolveSkillsRoot();
    expect(path.basename(root)).toBe('skills');
    expect(path.basename(path.dirname(root))).toBe('agent-core');
  });

  it('sees a skill added after configure without a restart', () => {
    const builtin = tmp();
    const user = tmp();
    writeSkill(
      builtin,
      'keep-me',
      '---\nname: keep-me\ndescription: Built-in.\n---\n\nB.\n',
    );
    configureSkillRoots([
      { scope: 'builtin', path: builtin },
      { scope: 'user', path: user },
    ]);
    expect(listSkills().map((s) => s.name)).toEqual(['keep-me']);
    writeSkill(
      user,
      'late-pack',
      '---\nname: late-pack\ndescription: Added later.\n---\n\nHi.\n',
    );
    expect(
      listSkills()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['keep-me', 'late-pack']);
  });
});
