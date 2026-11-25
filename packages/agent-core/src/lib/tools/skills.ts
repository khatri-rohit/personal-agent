import { AsyncLocalStorage } from 'node:async_hooks';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { Skill, SkillMetadata, Tool } from './types';

/**
 * Where skills come from, and who wins a name.
 *
 * Roots, in precedence order:
 * - builtin: packages/agent-core/skills (ships with the harness).
 * - user: the host's process roots, in order (`~/.agents/skills`, then
 *   `$AGENT_HOME/skills`). A later user root wins a name over earlier user
 *   roots and over builtin: your own packs are yours to override with.
 * - workspace: a bound folder's `.agents/skills`, overlaid per run. A
 *   workspace pack only adds names no other root has; it never replaces a
 *   builtin or user pack. An opened repo must not silently change the
 *   procedures you (or a sub-agent profile) rely on.
 *
 * Every root is trusted as-is: whatever sits in these folders is loadable.
 * Packs that break the Agent Skills spec are listed with a reason, never loaded.
 */

export type SkillScope = 'builtin' | 'user' | 'workspace';

export type SkillRoot = {
  scope: SkillScope;
  path: string;
  /** Stable label for this root (`agent-home`, `agents`, …). Defaults to the scope. */
  id?: string;
};

export type SkillIssue = 'invalid' | 'conflict';

export type SkillCatalogEntry = SkillMetadata & {
  folder: string;
  source: SkillScope;
  /** Id of the root the folder sits in. */
  root: string;
  issue?: SkillIssue;
  /** Why the pack is invalid or shadowed. */
  reason?: string;
};

/** A loadable skill plus where it came from. */
export type CatalogSkill = Skill & { scope: SkillScope; root: string };

/** Agent Skills spec: name is 1–64 chars, lowercase / digits / hyphens. */
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
/** A SKILL.md above this is not prompt text; it is listed invalid and never read. */
export const SKILL_FILE_MAX_BYTES = 1024 * 1024;
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isSpecSkillName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= SKILL_NAME_MAX &&
    SKILL_NAME_RE.test(name)
  );
}

type ResolvedRoot = Required<SkillRoot>;

type Assembled = {
  byName: Map<string, CatalogSkill>;
  loadable: CatalogSkill[];
  listings: SkillCatalogEntry[];
};

type SkillContext = {
  extra: ResolvedRoot[];
  /** Set for a run: the catalog is read once and held until the run ends. */
  freeze: boolean;
  frozen?: Assembled;
};

let configuredRoots: ResolvedRoot[] | null = null;
const context = new AsyncLocalStorage<SkillContext>();

function resolveRoot(root: SkillRoot): ResolvedRoot {
  return {
    scope: root.scope,
    path: path.resolve(root.path),
    id: root.id ?? root.scope,
  };
}

/** Bound-folder packs: `<workspace>/.agents/skills`. Empty when unbound (Home). */
export function extraSkillRoots(workspaceRoot?: string): SkillRoot[] {
  if (!workspaceRoot) return [];
  return [
    {
      scope: 'workspace',
      id: 'workspace',
      path: path.join(workspaceRoot, '.agents', 'skills'),
    },
  ];
}

/**
 * The shared ecosystem root (`~/.agents/skills`, where `npx skills add -g`
 * and other agents install) and this harness's own `$AGENT_HOME/skills`
 * (hand-written packs). Lowest to highest.
 */
export function standardUserSkillRoots(
  agentHome: string,
  homedir: string,
): SkillRoot[] {
  return [
    { scope: 'user', id: 'agents', path: path.join(homedir, '.agents', 'skills') },
    { scope: 'user', id: 'agent-home', path: path.join(agentHome, 'skills') },
  ];
}

/**
 * Overlay `extra` for this call and its async work. Empty `extra` keeps the
 * current overlay. `freeze` (a run) reads the catalog once and serves that
 * snapshot to every lookup inside, so a pack edited mid-run cannot change
 * the catalog, a pin, or a skill card halfway through.
 */
export function runWithSkillRoots<T>(
  extra: SkillRoot[],
  fn: () => T,
  options: { freeze?: boolean } = {},
): T {
  const current = context.getStore();
  const freeze = options.freeze === true;
  if (extra.length === 0 && !freeze) return fn();
  if (extra.length === 0 && current?.freeze) return fn();
  return context.run(
    {
      extra: extra.length > 0 ? extra.map(resolveRoot) : (current?.extra ?? []),
      freeze: freeze || current?.freeze === true,
    },
    fn,
  );
}

const CORE_PACKAGE = '@agent/agent-core';

/** `dir` is `<agent-core package>/skills`: its parent's package.json names agent-core. */
function isCoreSkillsDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(path.dirname(dir), 'package.json'), 'utf8'),
    ) as { name?: unknown };
    return pkg.name === CORE_PACKAGE;
  } catch {
    return false;
  }
}

/**
 * The built-in packs folder. Only a `skills/` next to agent-core's own
 * package.json qualifies, so a stray `skills/` under cwd (or beside a
 * bundled build) is never mistaken for built-ins.
 */
let builtinRoot: string | null = null;

export function resolveSkillsRoot(): string {
  // The package does not move while the process runs; hosts call this often.
  if (builtinRoot) return builtinRoot;
  const starts: string[] = [];
  try {
    starts.push(__dirname);
  } catch {
    /* ESM bundle without __dirname */
  }
  starts.push(process.cwd());

  for (const start of starts) {
    let dir = path.resolve(start);
    for (let i = 0; i < 10; i++) {
      for (const candidate of [
        path.join(dir, 'skills'),
        path.join(dir, 'packages', 'agent-core', 'skills'),
      ]) {
        if (isCoreSkillsDir(candidate)) {
          builtinRoot = candidate;
          return candidate;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  // Not found: do not memoize, so a later call (other cwd) can still find it.
  return path.resolve(process.cwd(), 'packages', 'agent-core', 'skills');
}

function defaultRoots(): ResolvedRoot[] {
  return [resolveRoot({ scope: 'builtin', path: resolveSkillsRoot() })];
}

/** Path identity for de-duplication (symlinks resolved, case-folded on Windows). */
function rootIdentity(root: string): string {
  let real = root;
  try {
    real = realpathSync.native(root);
  } catch {
    /* missing root: compare the resolved path */
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * Process roots, then the overlay. A folder reachable through two roots
 * (a workspace bound at `~`, so its `.agents/skills` is the user root) is
 * read once, under the first (higher-trust) root that names it.
 */
function roots(): ResolvedRoot[] {
  const base = configuredRoots ?? defaultRoots();
  const extra = context.getStore()?.extra ?? [];
  const seen = new Set<string>();
  const out: ResolvedRoot[] = [];
  for (const root of [...base, ...extra]) {
    const key = rootIdentity(root.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

/** `null` restores the built-in root only (tests). */
export function configureSkillRoots(next: SkillRoot[] | null): void {
  const resolved = next ? next.map(resolveRoot) : null;
  // Hosts call this on every request; only a real change drops the cache.
  if (JSON.stringify(resolved) === JSON.stringify(configuredRoots)) return;
  configuredRoots = resolved;
  cache = null;
}

/** Drop the cached catalog (after the host writes or removes a pack). */
export function invalidateSkillCatalog(): void {
  cache = null;
}

export type ParsedSkill = {
  name: string;
  description: string;
  instructions: string;
  /** Why the frontmatter could not be read, when it could not. */
  error?: string;
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
      error: 'no --- frontmatter block',
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
    } else {
      return { name, description, instructions: body, error: 'frontmatter is not a YAML map' };
    }
  } catch {
    return { name, description, instructions: body, error: 'frontmatter is not valid YAML' };
  }
  return { name, description, instructions: body };
}

/** Why a pack breaks the spec, or null when it is loadable. */
function specReason(folder: string, parsed: ParsedSkill): string | null {
  if (parsed.error) return parsed.error;
  if (!isSpecSkillName(parsed.name)) {
    return `name "${parsed.name}" must be 1–${SKILL_NAME_MAX} lowercase letters, digits and single hyphens`;
  }
  if (parsed.name !== folder) {
    return `name "${parsed.name}" must match its folder "${folder}"`;
  }
  if (parsed.description.length < 1) return 'description is missing';
  if (parsed.description.length > SKILL_DESCRIPTION_MAX) {
    return `description is over ${SKILL_DESCRIPTION_MAX} characters`;
  }
  return null;
}

type ScannedFolder = { folder: string; file: string; stat: Stats };

/**
 * Skill folders in one root: directories, and symlinks or junctions that
 * point at one (how shared installers often place packs). A folder without
 * a SKILL.md is not a skill and is skipped.
 */
function scanRoot(root: string): ScannedFolder[] {
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ScannedFolder[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    if (!entry.isDirectory()) {
      if (!entry.isSymbolicLink()) continue;
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue; // broken link
      }
    }
    const file = path.join(dir, 'SKILL.md');
    try {
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      out.push({ folder: entry.name, file, stat });
    } catch {
      continue;
    }
  }
  return out;
}

type RawListing = {
  folder: string;
  root: ResolvedRoot;
  skill: Skill;
  reason: string | null;
};

function readListing(root: ResolvedRoot, scanned: ScannedFolder): RawListing {
  const empty = { name: scanned.folder, description: '', instructions: '' };
  if (scanned.stat.size > SKILL_FILE_MAX_BYTES) {
    return {
      folder: scanned.folder,
      root,
      skill: empty,
      reason: `SKILL.md is larger than ${Math.round(SKILL_FILE_MAX_BYTES / 1024)} KB`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(scanned.file, 'utf8');
  } catch {
    return { folder: scanned.folder, root, skill: empty, reason: 'SKILL.md could not be read' };
  }
  const parsed = parseSkillMarkdown(raw, scanned.folder);
  return {
    folder: scanned.folder,
    root,
    reason: specReason(scanned.folder, parsed),
    skill: {
      name: parsed.name,
      description: parsed.description,
      instructions: parsed.instructions,
    },
  };
}

function nameKey(name: string): string {
  return name.toLowerCase();
}

function assembleFrom(
  rows: RawListing[],
): Assembled {
  // Pass 1: builtin and user roots, in order; a later root wins a name.
  const winner = new Map<string, RawListing>();
  for (const row of rows) {
    if (row.reason || row.root.scope === 'workspace') continue;
    winner.set(nameKey(row.skill.name), row);
  }
  // Pass 2: workspace roots add only names nobody else has.
  for (const row of rows) {
    if (row.reason || row.root.scope !== 'workspace') continue;
    const key = nameKey(row.skill.name);
    if (!winner.has(key)) winner.set(key, row);
  }

  const listings: SkillCatalogEntry[] = rows.map((row) => {
    const base = {
      name: row.skill.name,
      description: row.skill.description,
      folder: row.folder,
      source: row.root.scope,
      root: row.root.id,
    };
    if (row.reason) return { ...base, issue: 'invalid' as const, reason: row.reason };
    const won = winner.get(nameKey(row.skill.name));
    if (won !== row && won) {
      return {
        ...base,
        issue: 'conflict' as const,
        reason:
          row.root.scope === 'workspace'
            ? `workspace packs cannot replace the ${won.root.scope} pack "${won.skill.name}"`
            : `replaced by the ${won.root.scope} pack in ${won.root.id}`,
      };
    }
    return base;
  });
  listings.sort(
    (a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root),
  );

  const loadable = [...winner.values()]
    .map(
      (row): CatalogSkill => ({
        ...row.skill,
        scope: row.root.scope,
        root: row.root.id,
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    byName: new Map(loadable.map((skill) => [nameKey(skill.name), skill])),
    loadable,
    listings,
  };
}

/**
 * The catalog is cheap to validate and costly to rebuild: one readdir and
 * one stat per pack decide whether anything changed (folder set, SKILL.md
 * size, mtime or ctime); only then are files read and YAML parsed.
 */
/** One entry per root set (Home, each bound workspace), so threads do not evict each other. */
const CACHE_MAX_ROOT_SETS = 16;
let cache: Map<string, { key: string; value: Assembled }> | null = null;

function buildCatalog(): Assembled {
  const resolved = roots();
  const rootsKey = resolved
    .map((root) => `${root.scope}|${root.id}|${root.path}`)
    .join('\n');
  const scans = resolved.map((root) => ({ root, scanned: scanRoot(root.path) }));
  const key = scans
    .map(({ scanned }) =>
      scanned
        .map(
          ({ folder, stat }) =>
            `${folder}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
        )
        .join('\n'),
    )
    .join('\n\n');
  cache ??= new Map();
  const hit = cache.get(rootsKey);
  if (hit && hit.key === key) {
    // Refresh recency.
    cache.delete(rootsKey);
    cache.set(rootsKey, hit);
    return hit.value;
  }
  const rows = scans.flatMap(({ root, scanned }) =>
    scanned.map((item) => readListing(root, item)),
  );
  const value = assembleFrom(rows);
  cache.delete(rootsKey);
  cache.set(rootsKey, { key, value });
  while (cache.size > CACHE_MAX_ROOT_SETS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

function current(): Assembled {
  const store = context.getStore();
  if (store?.freeze) {
    store.frozen ??= buildCatalog();
    return store.frozen;
  }
  return buildCatalog();
}

function catalog(): CatalogSkill[] {
  return current().loadable;
}

export function listSkills(): SkillMetadata[] {
  return catalog().map(({ name, description }) => ({ name, description }));
}

/**
 * Raw SKILL.md for `folder`. With `rootId`, only that root is read (so the
 * text matches the listing the caller showed); without it, the
 * highest-precedence root that has the folder.
 */
export function readSkillFile(folder: string, rootId?: string): string | null {
  if (
    !folder ||
    folder === '.' ||
    folder.includes('..') ||
    folder.includes('/') ||
    folder.includes('\\') ||
    folder.includes('\0')
  ) {
    return null;
  }
  const candidates = [...roots()]
    .reverse()
    .filter((root) => rootId === undefined || root.id === rootId);
  for (const root of candidates) {
    const file = path.join(root.path, folder, 'SKILL.md');
    const rel = path.relative(root.path, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    try {
      if (statSync(file).size > SKILL_FILE_MAX_BYTES) return null;
      return readFileSync(file, 'utf8');
    } catch {
      continue;
    }
  }
  return null;
}

export function getSkill(name: string): CatalogSkill | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return current().byName.get(key);
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
  const listings = current().listings;
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
