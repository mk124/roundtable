import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { access, chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoundtableService, startServer } from '../../src/server/startup.ts';
import { ConversationStore } from '../../src/conversations/store.ts';
import { StorageLock } from '../../src/storage/lock.ts';
import type { SizeLimits } from '../../src/types.ts';

const tempHome = () => mkdtemp(join(tmpdir(), 'rt-svc-'));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

// A tiny total so the very first message exhausts the conversation budget.
const TINY: SizeLimits = { messageBytes: 1_000_000, singleEventBytes: 1_000_000, conversationTotalBytes: 10 };

test('say persists read-only to metadata once the conversation total is exhausted (R48)', async () => {
  const home = await tempHome();
  const service = new RoundtableService({ home, limits: TINY });
  const created = await service.createConversation('full');
  if (!created.ok) throw new Error(created.error);
  const id = created.conversation.id;

  const res = await service.say(id, 'user', 'hi');
  assert.equal(res.ok, false);

  // The sidecar — not just in-memory state — records it, so a fresh store (as
  // after a restart) reports read-only and the sidebar badge keeps showing.
  const meta = await new ConversationStore(home).get(id);
  assert.equal(meta?.readOnly, true);
});

test('opening a read-only log persists the sidebar metadata flag', async () => {
  const home = await tempHome();
  const service = new RoundtableService({ home });
  const created = await service.createConversation('damaged');
  if (!created.ok) throw new Error(created.error);
  const id = created.conversation.id;
  const store = new ConversationStore(home);

  await writeFile(store.conversationFilePath(created.conversation), 'manual edit without framing\n');

  const view = await service.view(id);
  assert.equal(view?.readOnly, true);
  assert.equal((await store.get(id))?.readOnly, true);
});

test('a normal say leaves the conversation writable', async () => {
  const home = await tempHome();
  const service = new RoundtableService({ home });
  const created = await service.createConversation('ok');
  if (!created.ok) throw new Error(created.error);
  const id = created.conversation.id;

  const res = await service.say(id, 'user', 'hello');
  assert.equal(res.ok, true);
  const meta = await new ConversationStore(home).get(id);
  assert.equal(meta?.readOnly ?? false, false);
});

test('say preserves message markdown exactly after the non-empty check', async () => {
  const home = await tempHome();
  const service = new RoundtableService({ home });
  const created = await service.createConversation('markdown');
  if (!created.ok) throw new Error(created.error);
  const id = created.conversation.id;
  const body = '  indented code\n\n- item  \n';

  const res = await service.say(id, 'user', body);
  assert.equal(res.ok, true);

  const view = await service.view(id);
  const event = view?.events[0];
  assert.ok(event?.type === 'message');
  assert.equal(event.body, body);
});

test('concurrent first access shares one context, so no message is stranded', async () => {
  const home = await tempHome();
  const service = new RoundtableService({ home });
  const created = await service.createConversation('race');
  if (!created.ok) throw new Error(created.error);
  const id = created.conversation.id;

  // A view and a say hit the not-yet-opened conversation at the same instant.
  const [, sayRes] = await Promise.all([service.view(id), service.say(id, 'agent', 'hello')]);
  assert.equal(sayRes.ok, true);

  // The message is visible through the shared context, not lost on a duplicate log.
  const view = await service.view(id);
  assert.equal(view?.events.length, 1);
});

test('deleting during a first-access open resurrects no file and no ghost context', async () => {
  const home = await tempHome();
  const service = new RoundtableService({ home });
  const created = await service.createConversation('racey');
  if (!created.ok) throw new Error(created.error);
  const id = created.conversation.id;

  // A first access (which opens the log) races a delete of the same conversation.
  await Promise.all([service.view(id), service.deleteConversation(id)]);

  assert.equal(await new ConversationStore(home).get(id), null); // metadata gone
  assert.equal(await service.view(id), null); // unknown — no cached ghost context
  await assert.rejects(access(join(home, 'conversations', created.conversation.filename))); // no resurrected markdown
});

test('deleting an open conversation wins over later same-tick mutations', async () => {
  const home = await tempHome();
  const service = new RoundtableService({ home });
  const created = await service.createConversation('open race');
  if (!created.ok) throw new Error(created.error);
  const id = created.conversation.id;
  await service.view(id); // open and cache the context first

  const deleteResult = service.deleteConversation(id);
  const sayResult = service.say(id, 'agent', 'late message');
  const activityResult = service.setActivity(id, 'agent', 'thinking');

  assert.deepEqual(await deleteResult, { ok: true });
  assert.deepEqual(await sayResult, { ok: false, error: 'unknown conversation' });
  assert.deepEqual(await activityResult, { ok: false, error: 'unknown conversation' });
  assert.equal(await service.view(id), null);
  await assert.rejects(access(join(home, 'conversations', created.conversation.filename)));
});

test('startServer surfaces a bind failure and releases the lock', async () => {
  const home = await tempHome();
  const blocker = net.createServer();
  const port = await new Promise<number>((r) => blocker.listen(0, '127.0.0.1', () => r((blocker.address() as net.AddressInfo).port)));
  try {
    await assert.rejects(startServer({ home, port })); // EADDRINUSE rejects cleanly, no uncaught crash
    const lock = await StorageLock.acquire(home); // the lock was freed, so a retry can take it
    assert.ok(lock);
    await lock!.release();
  } finally {
    await new Promise<void>((r) => blocker.close(() => r()));
  }
});

test('startServer tightens existing storage directory permissions', async () => {
  const home = await tempHome();
  const conversations = join(home, 'conversations');
  await mkdir(conversations, { recursive: true });
  await chmod(home, 0o777);
  await chmod(conversations, 0o777);

  const started = await startServer({ home, port: await freePort() });
  if (!started) throw new Error('server did not start');
  try {
    assert.equal((await stat(home)).mode & 0o077, 0);
    assert.equal((await stat(conversations)).mode & 0o077, 0);
  } finally {
    await started.close();
  }
});

test('startServer close ends live SSE streams', async () => {
  const home = await tempHome();
  const started = await startServer({ home, port: await freePort() });
  if (!started) throw new Error('server did not start');

  const create = await fetch(`${started.url}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'live' }),
  });
  const body = (await create.json()) as { conversation: { id: string } };
  const stream = await fetch(`${started.url}/api/conversations/${body.conversation.id}/events`);
  assert.equal(stream.status, 200);

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      started.close(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('close timed out')), 1000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});
