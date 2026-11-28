import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

/**
 * Replace `target` with `data` so a reader never sees a partial file and a
 * crash mid-write leaves the old one. The temp name is unique per write, so
 * two writes to one file in this process cannot share (and lose) a temp file;
 * the last rename wins.
 */
export async function writeFileAtomic(target: string, data: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
