import { chmod, readFile, writeFile } from 'node:fs/promises';

/** True for any non-null object — the precondition every sidecar type guard shares. */
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
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
