import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageLock } from '../../src/storage/lock.ts';

const home = () => mkdtemp(join(tmpdir(), 'rt-lock-'));

test('acquires a lock on a fresh home', async () => {
  const lock = await StorageLock.acquire(await home());
  assert.ok(lock);
  await lock!.release();
});

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

test('takes over a stale lock whose owner pid is dead', async () => {
  const dir = await home();
  await mkdir(join(dir, '.lock'));
  await writeFile(join(dir, '.lock', 'owner.json'), JSON.stringify({ hostname: hostname(), pid: 2147483646 }));
  const lock = await StorageLock.acquire(dir);
  assert.ok(lock); // dead owner on this host → safe takeover
  await lock!.release();
});

test('only one contender can take over the same stale lock', async () => {
  const dir = await home();
  await mkdir(join(dir, '.lock'));
  await writeFile(join(dir, '.lock', 'owner.json'), JSON.stringify({ hostname: hostname(), pid: 2147483646 }));

  const locks = await Promise.all(Array.from({ length: 6 }, () => StorageLock.acquire(dir)));
  const acquired = locks.filter((lock): lock is StorageLock => lock !== null);

  assert.equal(acquired.length, 1);
  await acquired[0]!.release();
});

test('refuses takeover when the owner is on another host', async () => {
  const dir = await home();
  await mkdir(join(dir, '.lock'));
  await writeFile(join(dir, '.lock', 'owner.json'), JSON.stringify({ hostname: 'some-other-host', pid: 2147483646 }));
  const lock = await StorageLock.acquire(dir);
  assert.equal(lock, null); // cannot verify another host → fail closed
});

test('refuses takeover when the owner file is not verifiable', async () => {
  const dir = await home();
  await mkdir(join(dir, '.lock'));
  await writeFile(join(dir, '.lock', 'owner.json'), JSON.stringify({ hostname: hostname() }));
  const lock = await StorageLock.acquire(dir);
  assert.equal(lock, null);
});
