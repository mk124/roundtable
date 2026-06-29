import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ProjectStore } from '../../src/projects/store.ts';
import { encodeProjectDir } from '../../src/projects/naming.ts';
import { ConversationStore } from '../../src/conversations/store.ts';

const tempDir = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

test('add registers a project with a random URL-safe id, canonical path, and private perms', async () => {
  const home = await tempDir('rt-home-');
  const projectPath = await tempDir('rt-proj-');
  const meta = await new ProjectStore(home).add(projectPath);

  assert.match(meta.id, /^[0-9a-f]{16}$/); // CSPRNG handle, usable directly as /api/projects/:id
  assert.equal(/[#/]/.test(meta.id), false);
  assert.equal(meta.path, projectPath); // normalized canonical path
  assert.equal(meta.title, basename(projectPath));
  assert.ok(meta.addedAt);

  const dir = join(home, 'projects', encodeProjectDir(projectPath));
  assert.equal((await stat(dir)).mode & 0o077, 0); // 0o700 directory
  assert.equal((await stat(join(dir, 'project.json'))).mode & 0o077, 0); // 0o600 sidecar
});

test('add rejects relative, missing, and non-directory paths', async () => {
  const home = await tempDir('rt-home-');
  const store = new ProjectStore(home);
  await assert.rejects(store.add('relative/path'));
  await assert.rejects(store.add(join(home, 'does-not-exist')));
  const file = join(await tempDir('rt-proj-'), 'a-file');
  await writeFile(file, 'x');
  await assert.rejects(store.add(file));
});

test('re-adding the same path is idempotent and never overwrites', async () => {
  const home = await tempDir('rt-home-');
  const projectPath = await tempDir('rt-proj-');
  const store = new ProjectStore(home);
  const first = await store.add(projectPath);
  const second = await store.add(projectPath);
  assert.equal(second.id, first.id);
  assert.equal(second.addedAt, first.addedAt);
  assert.deepEqual((await store.list()).map((p) => p.id), [first.id]);
});

test('normalized-equivalent paths resolve to one project', async () => {
  const home = await tempDir('rt-home-');
  const projectPath = await tempDir('rt-proj-');
  const store = new ProjectStore(home);
  const a = await store.add(projectPath);
  const b = await store.add(`${projectPath}/`); // trailing slash normalizes away
  assert.equal(b.id, a.id);
  assert.equal((await store.list()).length, 1);
});

test('list skips malformed sidecars; a missing projects dir yields an empty list', async () => {
  const home = await tempDir('rt-home-');
  const store = new ProjectStore(home);
  assert.deepEqual(await store.list(), []); // projects/ absent

  const good = await store.add(await tempDir('rt-proj-'));
  await mkdir(join(home, 'projects', '#broken'), { recursive: true });
  await writeFile(join(home, 'projects', '#broken', 'project.json'), '{ not valid');
  assert.deepEqual((await store.list()).map((p) => p.id), [good.id]);
});

test('get resolves a known id and rejects unknown or malformed ids', async () => {
  const home = await tempDir('rt-home-');
  const store = new ProjectStore(home);
  const meta = await store.add(await tempDir('rt-proj-'));
  assert.equal((await store.get(meta.id))?.id, meta.id);
  assert.equal(await store.get('deadbeefdeadbeef'), null);
  assert.equal(await store.get('../escape'), null); // not a project-id shape
});

test('remove deregisters without deleting conversations, and re-add restores them', async () => {
  const home = await tempDir('rt-home-');
  const projectPath = await tempDir('rt-proj-');
  const store = new ProjectStore(home);
  const meta = await store.add(projectPath);

  const conv = await new ConversationStore(store.projectDir(meta)).create('Kept');
  assert.ok(conv.id);

  assert.equal(await store.remove(meta.id), true);
  assert.deepEqual(await store.list(), []); // deregistered from the sidebar
  await assert.rejects(stat(join(store.projectDir(meta), 'project.json'))); // only the sidecar is gone
  assert.equal((await new ConversationStore(store.projectDir(meta)).list()).length, 1); // transcript retained

  const restored = await store.add(projectPath);
  assert.notEqual(restored.id, meta.id); // a fresh id per registration
  assert.equal((await store.list()).length, 1);
  assert.equal((await new ConversationStore(store.projectDir(restored)).list())[0]?.title, 'Kept');

  assert.equal(await store.remove('deadbeefdeadbeef'), false); // unknown id is a no-op
});

test('a path containing .. normalizes to one directory segment inside projects/', async () => {
  const home = await tempDir('rt-home-');
  const base = await tempDir('rt-proj-');
  const traversed = join(base, '..', basename(base)); // resolves back to base
  const store = new ProjectStore(home);
  const meta = await store.add(traversed);

  assert.equal(meta.path, base); // .. resolved away
  const encoded = encodeProjectDir(base);
  assert.equal(encoded.includes('/'), false);
  assert.equal(store.projectDir(meta), join(home, 'projects', encoded)); // stays within projects/
});
