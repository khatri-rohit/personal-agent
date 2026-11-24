import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '@agent/agent-models';

import {
  configureSkillRoots,
  formatSkillBodies,
  formatSkillsCatalog,
  getSkill,
  listSkillCatalogs,
  listSkills,
  load_skill,
  parseSkillMarkdown,
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

  it('loads a spec-valid user skill and skips invalid or reserved names', () => {
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

    expect(listSkills().map((s) => s.name).sort()).toEqual([
      'caveman-review',
      'ok-pack',
    ]);
    expect(getSkill('caveman-review')?.description).toBe('Built-in review.');
    expect(getSkill('ok-pack')?.instructions).toContain('Do the thing.');

    const { builtin: builtList, user: userList } = listSkillCatalogs();
    expect(builtList).toEqual([
      expect.objectContaining({
        name: 'caveman-review',
        folder: 'caveman-review',
        source: 'builtin',
      }),
    ]);
    expect(builtList[0]?.issue).toBeUndefined();
    expect(userList.find((s) => s.folder === 'ok-pack')?.issue).toBeUndefined();
    expect(userList.find((s) => s.folder === 'caveman-review')?.issue).toBe(
      'conflict',
    );
    expect(userList.find((s) => s.folder === 'BadFolder')?.issue).toBe(
      'invalid',
    );
  });

  it('marks duplicate user names as conflict and loads neither', () => {
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
    expect(listSkills().map((s) => s.name)).toEqual(['keep-me']);
    expect(
      listSkillCatalogs().user.every((s) => s.name === 'dup' && s.issue === 'conflict'),
    ).toBe(true);
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
    expect(listSkills().map((s) => s.name).sort()).toEqual([
      'keep-me',
      'late-pack',
    ]);
  });
});
