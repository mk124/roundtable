import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isRecord } from './sidecar.ts';

interface LockOwner {
  hostname: string;
  pid: number;
  token?: string;
}

export interface StorageLockIdentity {
  hostname: string;
  pid: number;
  token: string;
  lockPath: string;
}

const SERVER_LOCK_FILE = 'server.lock.json';
const TAKEOVER_SUFFIX = '.takeover';

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists but not ours
  }
}

type OwnerState =
  | { state: 'missing' }
  | { state: 'invalid' }
  | { state: 'valid'; owner: LockOwner };

async function readOwnerState(path: string): Promise<OwnerState> {
  try {
    const owner = lockOwner(JSON.parse(await readFile(path, 'utf8')));
    return owner ? { state: 'valid', owner } : { state: 'invalid' };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'invalid' };
  }
}

function lockOwner(value: unknown): LockOwner | null {
  if (!isRecord(value)) return null;
  if (typeof value.hostname !== 'string') return null;
  if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) return null;
  if (value.token !== undefined && typeof value.token !== 'string') return null;
  return { hostname: value.hostname, pid: value.pid, token: value.token };
}

function sameOwner(a: LockOwner, b: LockOwner): boolean {
  return a.hostname === b.hostname && a.pid === b.pid && a.token === b.token;
}

function deadSameHost(owner: LockOwner): boolean {
  return owner.hostname === hostname() && !pidAlive(owner.pid);
}

/**
 * Single-writer guard over ~/.roundtable. `server.lock.json` is created with `wx`, so
 * lock acquisition is an atomic file create on macOS, Linux, and Windows. A stale
 * lock is replaced only when its owner is on this host and its pid is confirmed
 * dead. Anything uncertain is refused.
 */
export class StorageLock {
  private readonly path: string;
  private readonly owner: Required<LockOwner>;

  private constructor(path: string, owner: Required<LockOwner>) {
    this.path = path;
    this.owner = owner;
  }

  get identity(): StorageLockIdentity {
    return { ...this.owner, lockPath: this.path };
  }

  static async acquire(home: string): Promise<StorageLock | null> {
    await mkdir(home, { recursive: true, mode: 0o700 });

    const path = join(home, SERVER_LOCK_FILE);
    const owner = { hostname: hostname(), pid: process.pid, token: randomBytes(16).toString('hex') };
    for (;;) {
      try {
        await writeNewOwner(path, owner);
        return new StorageLock(path, owner);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }

      const existingState = await readOwnerState(path);
      if (existingState.state === 'missing') continue;
      if (existingState.state === 'invalid') return null;
      const existing = existingState.owner;
      // Replace only a same-host lock whose pid is confirmed dead; else refuse.
      if (!deadSameHost(existing)) return null;
      if (!(await removeStaleLock(path, existing, owner))) return null;
    }
  }

  async release(): Promise<void> {
    const current = await readOwnerState(this.path);
    if (current.state === 'valid' && sameOwner(current.owner, this.owner)) await rm(this.path, { force: true });
  }
}

async function writeNewOwner(path: string, owner: Required<LockOwner>): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
  } catch (err) {
    await rm(path, { force: true }).catch(() => {});
    throw err;
  } finally {
    await file.close();
  }
}

async function removeStaleLock(path: string, stale: LockOwner, owner: Required<LockOwner>): Promise<boolean> {
  const takeoverPath = `${path}${TAKEOVER_SUFFIX}`;
  const takeover = await claimTakeover(takeoverPath, owner);
  if (!takeover) return false;
  try {
    const current = await readOwnerState(path);
    if (current.state === 'valid' && sameOwner(current.owner, stale) && deadSameHost(current.owner)) {
      await rm(path, { force: true });
    }
    return true;
  } finally {
    const marker = await readOwnerState(takeoverPath);
    if (marker.state === 'valid' && sameOwner(marker.owner, owner)) await rm(takeoverPath, { force: true });
  }
}

async function claimTakeover(path: string, owner: Required<LockOwner>): Promise<boolean> {
  for (;;) {
    try {
      await writeNewOwner(path, owner);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const existing = await readOwnerState(path);
    if (existing.state === 'missing') continue;
    if (existing.state === 'invalid') return false;
    if (!deadSameHost(existing.owner)) return false;
    await rm(path, { force: true });
  }
}
