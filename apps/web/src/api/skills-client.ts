import { api } from './client';

/** Root ids the API reports: `builtin`, `agents` (~/.agents/skills), `agent-home`, `workspace`. */
export type SkillRootId = 'builtin' | 'agents' | 'agent-home' | 'workspace';

export type SkillCatalogItem = {
  name: string;
  description: string;
  folder: string;
  source: 'builtin' | 'user' | 'workspace';
  /** Which folder it sits in. Older APIs omit it. */
  root?: SkillRootId | string;
  issue?: 'invalid' | 'conflict';
  /** Why it is invalid or shadowed. */
  reason?: string;
};

export type SkillCatalogs = {
  builtin: SkillCatalogItem[];
  user: SkillCatalogItem[];
  workspace: SkillCatalogItem[];
};

export type SkillDocument = SkillCatalogItem & { content: string };

/** The folder the panel may remove from (hand-written packs). */
export const OWN_SKILL_ROOT = 'agent-home';
/** The folder shared with other agents and `npx skills`. */
export const SHARED_SKILL_ROOT = 'agents';

/** Stable row key: the same folder can exist in two roots. */
export function skillRowKey(skill: SkillCatalogItem): string {
  return `${skill.root ?? skill.source}:${skill.folder}`;
}

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return body;
}

function asCatalogs(raw: SkillCatalogs): SkillCatalogs {
  return {
    builtin: raw.builtin ?? [],
    user: raw.user ?? [],
    workspace: raw.workspace ?? [],
  };
}

/** `threadId=` so the API answers with that thread's workspace packs too (no leading `?`). */
function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  return search.toString();
}

export async function fetchSkillCatalogs(
  threadId?: string,
): Promise<SkillCatalogs> {
  const res = await api.request('skills.list', { query: query({ threadId }) });
  return asCatalogs(await readJson<SkillCatalogs>(res));
}

/** Raw SKILL.md of one listed pack, from the root the row shows. */
export async function fetchSkillDocument(input: {
  folder: string;
  root?: string;
  threadId?: string;
}): Promise<SkillDocument> {
  const res = await api.request('skills.get', {
    params: { folder: input.folder },
    query: query({ root: input.root, threadId: input.threadId }),
  });
  return readJson<SkillDocument>(res);
}

/** Save a hand-authored SKILL.md under the home skills folder. */
export async function createUserSkill(input: {
  name: string;
  content: string;
  threadId?: string;
}): Promise<SkillCatalogs> {
  const res = await api.request('skills.create', {
    query: query({ threadId: input.threadId }),
    init: {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: input.name, content: input.content }),
    },
  });
  return asCatalogs(await readJson<SkillCatalogs>(res));
}

/** Move a hand-written pack to the agent home's trash (recoverable for 30 days). */
export async function deleteUserSkill(
  folder: string,
  threadId?: string,
): Promise<SkillCatalogs> {
  const res = await api.request('skills.delete', { params: { folder }, query: query({ threadId }) });
  return asCatalogs(await readJson<SkillCatalogs>(res));
}
