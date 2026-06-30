import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageLock } from '../../src/storage/lock.ts';

const home = () => mkdtemp(join(tmpdir(), 'rt-lock-'));
const lockFile = (dir: string) => join(dir, 'server.lock.json');
const deadPid = 2147483646;

test('a second acquire is refused while held (fail closed)', async () => {
  const dir = await home();
  const first = await StorageLock.acquire(dir);
  const second = await StorageLock.acquire(dir);
  assert.equal(second, null);
  await first!.release();
});

test('release allows re-acquisition', async () => {
  const dir = await home();
  const a = await StorageLock.acquire(dir);
  await a!.release();
  const b = await StorageLock.acquire(dir);
  assert.ok(b);
  await b!.release();
});

test('takes over a same-host stale lock whose owner pid is dead', async () => {
  const dir = await home();
  await writeFile(lockFile(dir), JSON.stringify({ hostname: hostname(), pid: deadPid, token: 'old' }));

  const lock = await StorageLock.acquire(dir);

  assert.ok(lock);
  assert.notEqual(lock!.identity.token, 'old');
  await lock!.release();
});

test('only one contender can take over the same stale lock', async () => {
  const dir = await home();
  await writeFile(lockFile(dir), JSON.stringify({ hostname: hostname(), pid: deadPid, token: 'old' }));

  const locks = await Promise.all(Array.from({ length: 6 }, () => StorageLock.acquire(dir)));
  const acquired = locks.filter((lock): lock is StorageLock => lock !== null);

  assert.equal(acquired.length, 1);
  await acquired[0]!.release();
});

test('refuses takeover when the owner is on another host', async () => {
  const dir = await home();
  await writeFile(lockFile(dir), JSON.stringify({ hostname: 'some-other-host', pid: deadPid, token: 'old' }));

  assert.equal(await StorageLock.acquire(dir), null);
});

test('refuses takeover when the owner file is not verifiable', async () => {
  const dir = await home();
  await writeFile(lockFile(dir), JSON.stringify({ hostname: hostname() }));

  assert.equal(await StorageLock.acquire(dir), null);
});
