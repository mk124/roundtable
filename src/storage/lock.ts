import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

interface LockOwner {
  hostname: string;
  pid: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists but not ours
  }
}

async function readOwner(dir: string): Promise<LockOwner | null> {
  try {
    return lockOwner(JSON.parse(await readFile(join(dir, 'owner.json'), 'utf8')));
  } catch {
    return null;
  }
}

function lockOwner(value: unknown): LockOwner | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.hostname !== 'string') return null;
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) return null;
  return { hostname: record.hostname, pid: record.pid };
}

function sameOwner(a: LockOwner | null, b: LockOwner): boolean {
  return a?.hostname === b.hostname && a.pid === b.pid;
}

/**
 * Single-writer guard over ~/.roundtable (R20). Ownership is an atomic directory
 * create; a stale lock is taken over only when its owner is on this host and its
 * pid is confirmed dead. Anything uncertain fails closed (returns null) so a
 * second instance never writes to the same store concurrently.
 */
export class StorageLock {
  private readonly dir: string;
  private readonly owner: LockOwner;

  private constructor(dir: string, owner: LockOwner) {
    this.dir = dir;
    this.owner = owner;
  }

  static async acquire(home: string): Promise<StorageLock | null> {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const dir = join(home, '.lock');

    for (;;) {
      try {
        await mkdir(dir, { mode: 0o700 }); // non-recursive -> atomic; EEXIST means already locked
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }

      const existing = await readOwner(dir);
      // Take over only a same-host lock whose pid is confirmed dead; else fail closed.
      if (!existing || existing.hostname !== hostname() || pidAlive(existing.pid)) return null;

      const marker = join(dir, 'takeover');
      try {
        await mkdir(marker, { mode: 0o700 });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue; // another process removed the stale dir; retry the atomic mkdir
        if (code === 'EEXIST') return null; // another process is already taking it over
        throw err;
      }

      try {
        const current = await readOwner(dir);
        if (!sameOwner(current, existing) || pidAlive(existing.pid)) return null;
        await rm(dir, { recursive: true });
      } finally {
        await rm(marker, { recursive: true, force: true }).catch(() => {});
      }
    }

    const lock = new StorageLock(dir, { hostname: hostname(), pid: process.pid });
    await lock.write();
    return lock;
  }

  async release(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  private async write(): Promise<void> {
    await writeFile(join(this.dir, 'owner.json'), JSON.stringify(this.owner), { mode: 0o600 });
  }
}
