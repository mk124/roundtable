import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** True for any non-null object; the precondition every sidecar type guard shares. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Read and validate a JSON sidecar, returning null when it is absent, unparseable,
 *  or fails `guard`. Callers treat every such case the same: the record is ignored. */
export async function readJsonSidecar<T>(path: string, guard: (value: unknown) => value is T): Promise<T | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Write a JSON sidecar with current-user-private permissions. */
export async function writeJsonPrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
