const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3333';

export type SkillCatalogItem = {
  name: string;
  description: string;
  folder: string;
  source: 'builtin' | 'user';
  issue?: 'invalid' | 'conflict';
};

export type SkillCatalogs = {
  builtin: SkillCatalogItem[];
  user: SkillCatalogItem[];
};

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return body;
}

export async function fetchSkillCatalogs(): Promise<SkillCatalogs> {
  const res = await fetch(`${API_BASE}/api/agent/skills`);
  return readJson<SkillCatalogs>(res);
}

/** Save a hand-authored SKILL.md under the home skills folder. */
export async function createUserSkill(input: {
  name: string;
  content: string;
}): Promise<SkillCatalogs> {
  const res = await fetch(`${API_BASE}/api/agent/skills/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readJson<SkillCatalogs>(res);
}

export async function deleteUserSkill(folder: string): Promise<SkillCatalogs> {
  const res = await fetch(
    `${API_BASE}/api/agent/skills/${encodeURIComponent(folder)}`,
    { method: 'DELETE' },
  );
  return readJson<SkillCatalogs>(res);
}
