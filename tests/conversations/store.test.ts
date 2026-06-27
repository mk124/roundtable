import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../../src/conversations/store.ts';
import { ConversationLog } from '../../src/storage/event-log.ts';

const tempDir = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

test('create derives a slugged filename and a distinct id', async () => {
  const store = new ConversationStore(await tempDir('rt-root-'));
  const meta = await store.create('My Chat');
  assert.match(meta.filename, /^my-chat-[0-9a-f]{8}\.md$/);
  assert.match(meta.id, /^[0-9a-f]{16}$/);
  assert.equal(meta.title, 'My Chat');
});

test('lists conversations and reads them back', async () => {
  const store = new ConversationStore(await tempDir('rt-root-'));
  const a = await store.create('First');
  const b = await store.create('Second');
  assert.deepEqual(
    (await store.list()).map((c) => c.id).sort(),
    [a.id, b.id].sort(),
  );
  assert.equal((await store.get(a.id))?.title, 'First');
});

test('update changes the title but never the id or filename', async () => {
  const store = new ConversationStore(await tempDir('rt-root-'));
  const meta = await store.create('Old');
  const updated = await store.update(meta.id, { title: 'New' });
  assert.equal(updated?.title, 'New');
  assert.equal(updated?.id, meta.id);
  assert.equal(updated?.filename, meta.filename);
});

test('conversationId never enters the Markdown log (R32)', async () => {
  const store = new ConversationStore(await tempDir('rt-root-'));
  const meta = await store.create('Chat');
  const log = await ConversationLog.open(store.conversationFilePath(meta));
  await log.append({ id: 'e1', type: 'message', timestamp: 't', author: 'user', body: 'hello' });
  const markdown = await readFile(store.conversationFilePath(meta), 'utf8');
  assert.ok(!markdown.includes(meta.id));
});

test('metadata files use current-user-private permissions (R32)', async () => {
  const root = await tempDir('rt-root-');
  const store = new ConversationStore(root);
  const meta = await store.create('Chat');
  const s = await stat(join(root, 'conversations', `${meta.id}.meta.json`));
  assert.equal(s.mode & 0o077, 0);
});

test('metadata updates repair over-broad sidecar permissions', async () => {
  const root = await tempDir('rt-root-');
  const store = new ConversationStore(root);
  const meta = await store.create('Chat');
  const sidecar = join(root, 'conversations', `${meta.id}.meta.json`);
  await chmod(sidecar, 0o644);

  await store.update(meta.id, { title: 'Renamed' });

  assert.equal((await stat(sidecar)).mode & 0o077, 0);
});

test('a fresh store lists no conversations', async () => {
  assert.deepEqual(await new ConversationStore(await tempDir('rt-root-')).list(), []);
});

test('malformed sidecars are ignored instead of crashing list', async () => {
  const root = await tempDir('rt-root-');
  const store = new ConversationStore(root);
  const good = await store.create('Good');
  await writeFile(join(root, 'conversations', 'bad.meta.json'), '{"lastActivityAt":42}\n');

  assert.deepEqual((await store.list()).map((c) => c.id), [good.id]);
});

test('store rejects ids outside the generated id shape', async () => {
  const root = await tempDir('rt-root-');
  const store = new ConversationStore(root);
  await store.create('Good');
  const outside = join(root, 'escape.meta.json');
  await writeFile(outside, '{"title":"outside"}\n');

  assert.equal(await store.get('../escape'), null);
  assert.equal(await store.update('../escape', { title: 'changed' }), null);
  assert.equal(await store.delete('../escape'), false);
  assert.equal(await readFile(outside, 'utf8'), '{"title":"outside"}\n');
});

test('delete removes the markdown log and sidecar; an unknown id is a no-op', async () => {
  const root = await tempDir('rt-root-');
  const store = new ConversationStore(root);
  const meta = await store.create('Doomed');
  const log = await ConversationLog.open(store.conversationFilePath(meta));
  await log.append({ id: 'e1', type: 'message', timestamp: 't', author: 'user', body: 'bye' });

  assert.equal(await store.delete(meta.id), true);
  assert.equal(await store.get(meta.id), null);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(stat(store.conversationFilePath(meta))); // markdown gone
  await assert.rejects(stat(join(root, 'conversations', `${meta.id}.meta.json`))); // sidecar gone

  assert.equal(await store.delete('deadbeefdeadbeef'), false);
});

test('an unsluggable title falls back to a dated filename (R41)', async () => {
  const meta = await new ConversationStore(await tempDir('rt-root-')).create('!!!');
  assert.match(meta.filename, /^conversation-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.md$/);
});
