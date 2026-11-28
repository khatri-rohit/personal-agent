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
  formatSkillsCatalog,
  getSkill,
  listSkillCatalogs,
  listSkills,
  load_skill,
  skillBodyInPrompt,
  parseSkillMarkdown,
  readSkillFile,
  resolveSkillsRoot,
  runWithSkillRoots,
  SKILL_BODY_MAX_CHARS,
  SKILL_FILE_MAX_BYTES,
  SKILL_FILE_PAGE_CHARS,
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

  it('still reads a description with an unquoted ": " (invalid strict YAML)', () => {
    const parsed = parseSkillMarkdown(
      [
        '---',
        'name: caveman-review',
        'description: Each comment is one line: location, problem, fix.',
        '---',
        '',
        'Body.',
      ].join('\n'),
      'caveman-review',
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.name).toBe('caveman-review');
    expect(parsed.description).toBe(
      'Each comment is one line: location, problem, fix.',
    );
  });

  it('folds a block description in the loose fallback', () => {
    const parsed = parseSkillMarkdown(
      [
        '---',
        'name: loose-fold',
        'description: >',
        '  Use when: the user asks',
        '  for a fold.',
        'tags: [unclosed',
        '---',
        '',
        'Body.',
      ].join('\n'),
      'loose-fold',
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.description).toBe('Use when: the user asks for a fold.');
  });

  it('keeps a pack invalid when even the loose read finds no description', () => {
    const parsed = parseSkillMarkdown('---\nname: [unclosed\n---\n\nX.\n', 'x');
    expect(parsed.error).toMatch(/YAML/);
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

describe('skillBodyInPrompt', () => {
  const call = (id: string, args: Record<string, unknown>) => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'load_skill', arguments: JSON.stringify(args) } }],
  });

  it('is true only while a whole body of that skill is in the prompt', () => {
    const loaded = [call('c1', { skill_name: 'Patch-And-Verify' }), { role: 'tool', tool_call_id: 'c1', content: 'Body text.' }];
    expect(skillBodyInPrompt(loaded, 'patch-and-verify')).toBe(true);
    expect(skillBodyInPrompt(loaded, 'home-research')).toBe(false);
    // A file read, a pointer or an evicted card is not the body.
    expect(skillBodyInPrompt([call('c2', { skill_name: 'x', file: 'a.md' }), { role: 'tool', tool_call_id: 'c2', content: 'A.' }], 'x')).toBe(false);
    expect(skillBodyInPrompt([call('c3', { skill_name: 'x' }), { role: 'tool', tool_call_id: 'c3', content: '(unchanged) The x skill…' }], 'x')).toBe(false);
    expect(skillBodyInPrompt([call('c4', { skill_name: 'x' }), { role: 'tool', tool_call_id: 'c4', content: '(evicted) …' }], 'x')).toBe(false);
    // The call whose result is not back yet does not count.
    expect(skillBodyInPrompt([call('c5', { skill_name: 'x' })], 'x')).toBe(false);
  });
});

describe('load_skill whole bodies and pack files', () => {
  const dirs: string[] = [];

  afterEach(() => {
    configureSkillRoots(null);
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function packRoot(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pa-skill-files-'));
    dirs.push(dir);
    return dir;
  }

  it('returns a large body whole, then lists the pack files', async () => {
    const root = packRoot();
    const body = Array.from({ length: 400 }, (_, i) => `Rule ${i}: keep every line.`).join('\n');
    writeSkill(root, 'big-pack', `---\nname: big-pack\ndescription: A large pack.\n---\n\n${body}\n`);
    mkdirSync(path.join(root, 'big-pack', 'references'));
    writeFileSync(path.join(root, 'big-pack', 'references', 'guide.md'), 'Guide text.', 'utf8');
    configureSkillRoots([{ scope: 'user', path: root }]);

    const result = await load_skill.execute({ skill_name: 'big-pack' }, ctx());
    expect(result).toContain('Rule 0: keep every line.');
    expect(result).toContain('Rule 399: keep every line.');
    expect(result).not.toMatch(/core rules/i);
    expect(result).toContain('- references/guide.md');
  });

  it('reads one pack file, jailed to the pack folder', async () => {
    const root = packRoot();
    writeSkill(root, 'filed', '---\nname: filed\ndescription: Has files.\n---\n\nSee references/a.md.\n');
    mkdirSync(path.join(root, 'filed', 'references'));
    writeFileSync(path.join(root, 'filed', 'references', 'a.md'), 'Detail A.', 'utf8');
    writeFileSync(path.join(root, 'outside.md'), 'Not in the pack.', 'utf8');
    configureSkillRoots([{ scope: 'user', path: root }]);

    expect(await load_skill.execute({ skill_name: 'filed', file: 'references/a.md' }, ctx())).toBe('Detail A.');
    expect(await load_skill.execute({ skill_name: 'filed', file: '../outside.md' }, ctx())).toMatch(/^Error: .*not a path inside/);
    expect(await load_skill.execute({ skill_name: 'filed', file: path.join(root, 'outside.md') }, ctx())).toMatch(/^Error:/);
    expect(await load_skill.execute({ skill_name: 'filed', file: 'missing.md' }, ctx())).toMatch(/^Error: filed has no file/);
  });

  it('pages a long pack file instead of cutting it', async () => {
    const root = packRoot();
    writeSkill(root, 'paged', '---\nname: paged\ndescription: Long file.\n---\n\nBody.\n');
    writeFileSync(path.join(root, 'paged', 'long.txt'), 'x'.repeat(SKILL_FILE_PAGE_CHARS + 500), 'utf8');
    configureSkillRoots([{ scope: 'user', path: root }]);

    const first = await load_skill.execute({ skill_name: 'paged', file: 'long.txt' }, ctx());
    expect(first).toContain(`offset=${SKILL_FILE_PAGE_CHARS}`);
    const second = await load_skill.execute(
      { skill_name: 'paged', file: 'long.txt', offset: SKILL_FILE_PAGE_CHARS },
      ctx(),
    );
    expect(second).toBe('x'.repeat(500));
  });

  it('lists a pack over the body limit as invalid instead of cutting it', () => {
    const root = packRoot();
    writeSkill(root, 'huge', `---\nname: huge\ndescription: Too big.\n---\n\n${'y'.repeat(SKILL_BODY_MAX_CHARS + 1)}\n`);
    configureSkillRoots([{ scope: 'user', path: root }]);
    expect(getSkill('huge')).toBeUndefined();
    const entry = listSkillCatalogs().user.find((item) => item.folder === 'huge');
    expect(entry?.issue).toBe('invalid');
    expect(entry?.reason).toMatch(/move detail into files/);
  });
});
