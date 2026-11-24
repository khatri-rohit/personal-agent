import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { Skill, SkillMetadata, Tool } from './types';

/**
 * Built-in packs: packages/agent-core/skills/<name>/SKILL.md.
 * Process roots (low → high): builtin, ~/.agents/skills, $AGENT_HOME/skills.
 * A bound folder adds `.agents/skills` for that run. Same name: later root wins.
 */

export type SkillScope = 'builtin' | 'user' | 'workspace';

export type SkillRoot = {
  scope: SkillScope;
  path: string;
};

export type SkillIssue = 'invalid' | 'conflict';

export type SkillCatalogEntry = SkillMetadata & {
  folder: string;
  source: SkillScope;
  issue?: SkillIssue;
};

/** Agent Skills spec: name is 1–64 chars, lowercase / digits / hyphens. */
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isSpecSkillName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= SKILL_NAME_MAX &&
    SKILL_NAME_RE.test(name)
  );
}

let configuredRoots: SkillRoot[] | null = null;
const extraRoots = new AsyncLocalStorage<SkillRoot[]>();

/** Bound-folder packs: `<workspace>/.agents/skills`. Empty when unbound (Home). */
export function extraSkillRoots(workspaceRoot?: string): SkillRoot[] {
  if (!workspaceRoot) return [];
  return [
    {
      scope: 'workspace',
      path: path.join(workspaceRoot, '.agents', 'skills'),
    },
  ];
}

/** Overlay `extra` for this call (and its async work). Empty `extra` keeps the current overlay. */
export function runWithSkillRoots<T>(extra: SkillRoot[], fn: () => T): T {
  if (extra.length === 0) return fn();
  return extraRoots.run(
    extra.map((root) => ({
      scope: root.scope,
      path: path.resolve(root.path),
    })),
    fn,
  );
}

export function resolveSkillsRoot(): string {
  const starts = [process.cwd()];
  try {
    starts.push(__dirname);
  } catch {
    /* CJS bundle without __dirname */
  }

  const candidates: string[] = [path.resolve(__dirname, '../../../skills')];
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let i = 0; i < 8; i++) {
      // Built-ins only: never the first random `skills/` under cwd (F11).
      candidates.push(path.join(dir, 'packages', 'agent-core', 'skills'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return path.resolve(process.cwd(), 'packages', 'agent-core', 'skills');
}

function defaultRoots(): SkillRoot[] {
  return [{ scope: 'builtin', path: resolveSkillsRoot() }];
}

function roots(): SkillRoot[] {
  const base = configuredRoots ?? defaultRoots();
  const extra = extraRoots.getStore();
  return extra && extra.length > 0 ? [...base, ...extra] : base;
}

/** `null` restores the built-in root only (tests). */
export function configureSkillRoots(next: SkillRoot[] | null): void {
  configuredRoots = next
    ? next.map((root) => ({
        scope: root.scope,
        path: path.resolve(root.path),
      }))
    : null;
}

export function invalidateSkillCatalog(): void {
  /* Catalog is read from disk on each call. */
}

export type ParsedSkill = {
  name: string;
  description: string;
  instructions: string;
};

export function parseSkillMarkdown(
  raw: string,
  fallbackName: string,
): ParsedSkill {
  const trimmed = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const end = trimmed.startsWith('---') ? trimmed.indexOf('\n---', 3) : -1;
  if (end < 0) {
    return {
      name: fallbackName,
      description: '',
      instructions: trimmed.trim(),
    };
  }
  const fm = trimmed.slice(3, end);
  const body = trimmed.slice(end + 4).trim();
  let name = fallbackName;
  let description = '';
  try {
    const data: unknown = parseYaml(fm);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const rec = data as Record<string, unknown>;
      if (typeof rec.name === 'string' && rec.name.trim()) {
        name = rec.name.trim();
      }
      if (typeof rec.description === 'string' && rec.description.trim()) {
        description = rec.description.trim();
      }
    }
  } catch {
    /* invalid YAML → empty description, listing is rejected */
  }
  return { name, description, instructions: body };
}

function specIssue(folder: string, parsed: ParsedSkill): boolean {
  return (
    !isSpecSkillName(parsed.name) ||
    parsed.name !== folder ||
    parsed.description.length < 1 ||
    parsed.description.length > SKILL_DESCRIPTION_MAX
  );
}

type RawListing = {
  folder: string;
  source: SkillScope;
  skill: Skill;
  invalid: boolean;
};

function readRoot(root: string, source: SkillScope): RawListing[] {
  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: RawListing[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const parsed = parseSkillMarkdown(
        readFileSync(path.join(root, entry.name, 'SKILL.md'), 'utf8'),
        entry.name,
      );
      out.push({
        folder: entry.name,
        source,
        invalid: specIssue(entry.name, parsed),
        skill: {
          name: parsed.name,
          description: parsed.description,
          instructions: parsed.instructions,
        },
      });
    } catch {
      continue;
    }
  }
  return out;
}

function assemble(): {
  loadable: Skill[];
  listings: SkillCatalogEntry[];
} {
  const raw = roots().flatMap((root) => readRoot(root.path, root.scope));
  const winner = new Map<string, RawListing>();
  for (const row of raw) {
    if (!row.invalid) winner.set(row.skill.name, row);
  }
  const listings = raw.map((row) => {
    const issue: SkillIssue | undefined = row.invalid
      ? 'invalid'
      : winner.get(row.skill.name) !== row
        ? 'conflict'
        : undefined;
    return {
      name: row.skill.name,
      description: row.skill.description,
      folder: row.folder,
      source: row.source,
      ...(issue ? { issue } : {}),
    };
  });
  listings.sort((a, b) => a.name.localeCompare(b.name));
  const loadable = [...winner.values()]
    .map((row) => row.skill)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { loadable, listings };
}

function catalog(): Skill[] {
  return assemble().loadable;
}

export function listSkills(): SkillMetadata[] {
  return catalog().map(({ name, description }) => ({ name, description }));
}

/** Raw SKILL.md from the highest-precedence root that has this folder. */
export function readSkillFile(folder: string): string | null {
  if (
    !folder ||
    folder.includes('..') ||
    folder.includes('/') ||
    folder.includes('\\')
  ) {
    return null;
  }
  for (const root of [...roots()].reverse()) {
    const file = path.join(root.path, folder, 'SKILL.md');
    const rel = path.relative(root.path, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    try {
      return readFileSync(file, 'utf8');
    } catch {
      continue;
    }
  }
  return null;
}

export function getSkill(name: string): Skill | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return catalog().find((item) => item.name.toLowerCase() === key);
}

/** User-requested bodies (`/` picks). Not host guesses. */
/** Bodies above this are "large": they load as core + contents, then by section. */
export const SKILL_LARGE_CHARS = 8_000;
/** One section per load_skill call; longer sections are cut with a pointer. */
export const SKILL_SECTION_MAX_CHARS = 12_000;
/** Fallback core when a skill has no `## Core rules` section. */
const SKILL_CORE_FALLBACK_CHARS = 1_200;
/** `/` picks are pinned in full up to this total; larger picks pin core + contents. */
export const PINNED_SKILLS_MAX_CHARS = 24_000;

const CORE_HEADING = /^##\s+core rules\s*$/im;

/** `## ` sections of a skill body, in order. Text before the first heading is the preamble. */
export function skillSections(
  instructions: string,
): { title: string; body: string }[] {
  const parts = instructions.split(/\n(?=##\s)/);
  const sections: { title: string; body: string }[] = [];
  for (const part of parts) {
    const match = part.match(/^##\s+(.+)\n?/);
    if (!match) continue;
    sections.push({
      title: match[1]!.trim(),
      body: part.slice(match[0].length).trim(),
    });
  }
  return sections;
}

/**
 * The must-follow rules that stay in context after a skill body is evicted:
 * the `## Core rules` section, else the first paragraph or list block.
 */
export function skillCore(instructions: string): string {
  const core = skillSections(instructions).find((section) =>
    CORE_HEADING.test(`## ${section.title}`),
  );
  if (core) return core.body.trim();
  const firstBlock = instructions.trim().split(/\n\s*\n/)[0] ?? '';
  return firstBlock.length > SKILL_CORE_FALLBACK_CHARS
    ? `${firstBlock.slice(0, SKILL_CORE_FALLBACK_CHARS)}…`
    : firstBlock;
}

/** Large skills without `## Core rules` (their evicted card falls back to the first block). */
export function skillLintWarnings(): string[] {
  return catalog()
    .filter(
      (skill) =>
        skill.instructions.length > SKILL_LARGE_CHARS &&
        !CORE_HEADING.test(skill.instructions),
    )
    .map(
      (skill) =>
        `${skill.name}: ${Math.round(skill.instructions.length / 4)} tokens and no "## Core rules" section`,
    );
}

function contentsLine(skill: Skill): string {
  const sections = skillSections(skill.instructions);
  if (sections.length === 0) return '';
  return `Sections (load_skill with section): ${sections
    .map(
      (section) =>
        `${section.title} (~${Math.round(section.body.length / 4)} tokens)`,
    )
    .join('; ')}`;
}

/** What load_skill returns: the whole body when small, else core + contents, or one section. */
export function skillForLoad(skill: Skill, section?: string): string {
  if (section) {
    const wanted = section.trim().toLowerCase();
    const found = skillSections(skill.instructions).find(
      (item) => item.title.toLowerCase() === wanted,
    );
    if (!found)
      return `Section "${section}" not found in ${skill.name}. ${contentsLine(skill)}`;
    return found.body.length > SKILL_SECTION_MAX_CHARS
      ? `${found.body.slice(0, SKILL_SECTION_MAX_CHARS)}\n…(section cut at ${SKILL_SECTION_MAX_CHARS} chars)`
      : found.body;
  }
  if (skill.instructions.length <= SKILL_LARGE_CHARS) return skill.instructions;
  return [
    `# ${skill.name} — core rules`,
    skillCore(skill.instructions),
    '',
    contentsLine(skill),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Replaces a loaded skill body once it has been applied: core rules plus a
 * reload note. The model keeps the rules; the long body stops riding along.
 */
export function skillCard(name: string, loadedAtIteration?: number): string {
  const skill = getSkill(name);
  const when =
    loadedAtIteration !== undefined ? ` at iteration ${loadedAtIteration}` : '';
  if (!skill)
    return `(skill card) ${name} was loaded${when}; call load_skill again for the full text.`;
  return `(skill card) ${skill.name} loaded${when}. Core rules:\n${skillCore(skill.instructions)}\nCall load_skill again for the full text or a section.`;
}

/**
 * Bodies for `/` picks (mandatory for this send). Pinned in full while the
 * total stays under `capChars`; larger picks pin core + contents instead.
 */
export function formatPinnedSkills(
  names: string[],
  alreadyLoaded: string[] = [],
  capChars = PINNED_SKILLS_MAX_CHARS,
): { text: string; trimmed: string[] } {
  const skip = new Set(alreadyLoaded.map((name) => name.toLowerCase()));
  const blocks: string[] = [];
  const trimmed: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const name of names) {
    const skill = getSkill(name);
    if (!skill) continue;
    const key = skill.name.toLowerCase();
    if (seen.has(key) || skip.has(key)) continue;
    seen.add(key);
    let body = skill.instructions;
    if (used + body.length > capChars) {
      // Over the cap: large skills pin core + contents, small ones their core.
      body =
        skill.instructions.length > SKILL_LARGE_CHARS
          ? skillForLoad(skill)
          : skillCore(skill.instructions);
      trimmed.push(skill.name);
    }
    used += body.length;
    blocks.push(`## ${skill.name}\n${body}`);
  }
  if (blocks.length === 0) return { text: '', trimmed };
  return {
    text: [
      '# Loaded skills',
      'The user attached these packs to this send. Follow them.',
      'Do not call load_skill again for these names (except to load a listed section).',
      '',
      blocks.join('\n\n'),
    ].join('\n'),
    trimmed,
  };
}

export function formatSkillBodies(
  names: string[],
  alreadyLoaded: string[] = [],
): string {
  return formatPinnedSkills(names, alreadyLoaded).text;
}

/** Catalog lines are for matching, not reading; the body loads on demand. */
const CATALOG_DESCRIPTION_MAX_CHARS = 200;

export function formatSkillsCatalog(skills: SkillMetadata[]): string {
  const lines =
    skills.length === 0
      ? '- (none)'
      : skills
          .map((skill) => {
            const description =
              skill.description.length > CATALOG_DESCRIPTION_MAX_CHARS
                ? `${skill.description.slice(0, CATALOG_DESCRIPTION_MAX_CHARS)}…`
                : skill.description;
            return `- ${skill.name}: ${description}`;
          })
          .join('\n');
  return [
    '# Skills',
    'Catalog of procedure packs (name + description).',
    'Load one with load_skill (exact name) when its description matches what you are about to do. Most tasks need none.',
    'Large skills return core rules + a section list; load a section when you need it. Loading does not approve steps or add tools.',
    '',
    lines,
  ].join('\n');
}

export function listSkillCatalogs(): {
  builtin: SkillCatalogEntry[];
  user: SkillCatalogEntry[];
  workspace: SkillCatalogEntry[];
} {
  const listings = assemble().listings;
  return {
    builtin: listings.filter((entry) => entry.source === 'builtin'),
    user: listings.filter((entry) => entry.source === 'user'),
    workspace: listings.filter((entry) => entry.source === 'workspace'),
  };
}

export const load_skill: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'load_skill',
      description:
        'Load the procedure body for a skill from the catalog. Built-in tools work without a skill.',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: 'Exact skill name from the skills catalog',
          },
          section: {
            type: 'string',
            description:
              'Optional section title, for large skills that list their sections.',
          },
        },
        required: ['skill_name'],
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: [
      'A catalog skill matches the user intent and its body is not already in Loaded skills.',
    ],
    whenNotToUse: [
      'Do not load a skill whose body is already in Loaded skills.',
      'Do not load a skill on every turn.',
      'Do not load a skill instead of calling a built-in tool.',
      'Do not load a skill for small talk or a one-line factual answer.',
      'Do not use offer_choice to decide which skill to load.',
    ],
    usage: [
      'Pass skill_name exactly as listed in the skills catalog.',
      'Follow the loaded steps; they do not grant extra tools or bypass the path jail.',
    ],
  },
  stage: 'skill',
  execute: async (args) => {
    const name = String(args.skill_name ?? '').trim();
    const skill = getSkill(name);
    const section = typeof args.section === 'string' ? args.section : undefined;
    if (skill) return skillForLoad(skill, section);
    const available = listSkills()
      .map((item) => item.name)
      .join(', ');
    return `Skill not found. Available skills: ${available || '(none)'}`;
  },
};
