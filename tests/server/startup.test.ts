import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { access, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoundtableService, startServer } from '../../src/server/startup.ts';
import { ConversationStore } from '../../src/conversations/store.ts';
import { encodeProjectDir } from '../../src/projects/naming.ts';
import { StorageLock } from '../../src/storage/lock.ts';
import type { SseClient } from '../../src/server/sse.ts';
import type { ConversationMetadata, SizeLimits } from '../../src/types.ts';

const tempHome = () => mkdtemp(join(tmpdir(), 'rt-svc-'));
const tempProjectPath = () => mkdtemp(join(tmpdir(), 'rt-proj-'));

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

/** Boot a service over a fresh home with one registered project. */
async function withProject(limits?: SizeLimits) {
  const home = await tempHome();
  const projectPath = await tempProjectPath();
  const service = new RoundtableService({ home, limits });
  const added = await service.addProject(projectPath);
  if (!added.ok) throw new Error(added.error);
  return { home, projectPath, service, projectId: added.project.id };
}

/** A ConversationStore reading a project's on-disk transcripts directly (as a
 *  fresh process would), for asserting persistence independent of the service. */
const projectStore = (home: string, projectPath: string) =>
  new ConversationStore(join(home, 'projects', encodeProjectDir(projectPath)));

const conversationFile = (home: string, projectPath: string, meta: ConversationMetadata) =>
  join(home, 'projects', encodeProjectDir(projectPath), 'conversations', meta.filename);

async function makeConversation(service: RoundtableService, projectId: string, title: string) {
  const created = await service.createConversation(projectId, title);
  if (!created.ok) throw new Error(created.error);
  return created.conversation;
}

test('createConversation requires a known project and writes nothing on failure', async () => {
  const { service } = await withProject();
  const bad = await service.createConversation('deadbeefdeadbeef', 'orphan');
  assert.equal(bad.ok, false);
  assert.deepEqual((await service.listProjects()).flatMap((p) => p.conversations), []);
});

test('a created conversation is stored under its project and resolvable by id alone', async () => {
  const { home, projectPath, service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'in project');
  assert.equal((await projectStore(home, projectPath).get(conv.id))?.id, conv.id); // sidecar under the project's conversations/
  assert.equal((await service.view(conv.id))?.cursor, 0); // resolved with no project reference
});

test('a fresh service resolves an existing conversation id by scanning projects', async () => {
  const { home, projectId, service } = await withProject();
  const conv = await makeConversation(service, projectId, 'persisted');
  await service.say(conv.id, 'user', 'hello');

  // A new instance (as after a restart) starts with an empty id→project map.
  const restarted = new RoundtableService({ home });
  assert.equal((await restarted.view(conv.id))?.events.length, 1);
});

test('say persists read-only to metadata once the conversation total is exhausted', async () => {
  const { home, projectPath, service, projectId } = await withProject(TINY);
  const conv = await makeConversation(service, projectId, 'full');

  const res = await service.say(conv.id, 'user', 'hi');
  assert.equal(res.ok, false);

  // The sidecar — not just in-memory state — records it, so a fresh store (as
  // after a restart) reports read-only and the sidebar badge keeps showing.
  assert.equal((await projectStore(home, projectPath).get(conv.id))?.readOnly, true);
});

test('opening a read-only log persists the sidebar metadata flag', async () => {
  const { home, projectPath, service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'damaged');
  const store = projectStore(home, projectPath);

  await writeFile(store.conversationFilePath(conv), 'manual edit without framing\n');

  assert.equal((await service.view(conv.id))?.readOnly, true);
  assert.equal((await store.get(conv.id))?.readOnly, true);
});

test('a normal say leaves the conversation writable', async () => {
  const { home, projectPath, service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'ok');

  const res = await service.say(conv.id, 'user', 'hello');
  assert.equal(res.ok, true);
  assert.equal((await projectStore(home, projectPath).get(conv.id))?.readOnly ?? false, false);
});

test('say preserves message markdown exactly after the non-empty check', async () => {
  const { service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'markdown');
  const body = '  indented code\n\n- item  \n';

  const res = await service.say(conv.id, 'user', body);
  assert.equal(res.ok, true);

  const event = (await service.view(conv.id))?.events[0];
  assert.ok(event?.type === 'message');
  assert.equal(event.body, body);
});

test('concurrent first access shares one context, so no message is stranded', async () => {
  const { service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'race');

  // A view and a say hit the not-yet-opened conversation at the same instant.
  const [, sayRes] = await Promise.all([service.view(conv.id), service.say(conv.id, 'agent', 'hello')]);
  assert.equal(sayRes.ok, true);

  // The message is visible through the shared context, not lost on a duplicate log.
  assert.equal((await service.view(conv.id))?.events.length, 1);
});

test('deleting during a first-access open resurrects no file and no ghost context', async () => {
  const { home, projectPath, service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'racey');

  // A first access (which opens the log) races a delete of the same conversation.
  await Promise.all([service.view(conv.id), service.deleteConversation(conv.id)]);

  assert.equal(await projectStore(home, projectPath).get(conv.id), null); // metadata gone
  assert.equal(await service.view(conv.id), null); // unknown — no cached ghost context
  await assert.rejects(access(conversationFile(home, projectPath, conv))); // no resurrected markdown
});

test('deleting an open conversation wins over later same-tick mutations', async () => {
  const { home, projectPath, service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'open race');
  await service.view(conv.id); // open and cache the context first

  const deleteResult = service.deleteConversation(conv.id);
  const sayResult = service.say(conv.id, 'agent', 'late message');
  const activityResult = service.setActivity(conv.id, 'agent', 'thinking');

  assert.deepEqual(await deleteResult, { ok: true });
  assert.deepEqual(await sayResult, { ok: false, error: 'unknown conversation' });
  assert.deepEqual(await activityResult, { ok: false, error: 'unknown conversation' });
  assert.equal(await service.view(conv.id), null);
  await assert.rejects(access(conversationFile(home, projectPath, conv)));
});

test('removeProject deregisters, retains transcripts, and stops resolving its ids until re-added', async () => {
  const { home, projectPath, service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'kept');
  await service.say(conv.id, 'user', 'hi'); // warm the context

  assert.deepEqual(await service.removeProject(projectId), { ok: true });
  assert.equal(await service.view(conv.id), null); // id no longer resolves
  assert.deepEqual(await service.listProjects(), []); // gone from the sidebar
  await access(conversationFile(home, projectPath, conv)); // transcript retained on disk

  const readded = await service.addProject(projectPath);
  if (!readded.ok) throw new Error(readded.error);
  assert.equal((await service.view(conv.id))?.events.length, 1); // restored, message intact

  assert.deepEqual(await service.removeProject('deadbeefdeadbeef'), { ok: false, error: 'unknown project' });
});

test('removeProject interleaved with say/subscribe leaves the id unresolved and the stream closed', async () => {
  const { service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'racey project');
  await service.view(conv.id); // warm context + SSE hub

  let closed = false;
  const client: SseClient = { write() {}, close() { closed = true; } };
  assert.ok(await service.subscribe(conv.id, client, 0));

  await Promise.all([service.removeProject(projectId), service.say(conv.id, 'agent', 'late')]);

  assert.equal(closed, true); // the warm SSE stream was closed, not leaked
  assert.equal(await service.view(conv.id), null); // resolves to not-found
});

test('removeProject racing a cold first-access subscribe leaves no resolvable zombie', async () => {
  const { home, projectId, service } = await withProject();
  const conv = await makeConversation(service, projectId, 'cold');
  await service.say(conv.id, 'user', 'hi');

  // A fresh instance (as after a restart) starts with an empty id→project map, so
  // the first access cold-resolves the id while removeProject runs concurrently.
  const restarted = new RoundtableService({ home });
  let closed = false;
  const client: SseClient = { write() {}, close() { closed = true; } };
  const [unsubscribe] = await Promise.all([
    restarted.subscribe(conv.id, client, 0),
    restarted.removeProject(projectId),
  ]);

  assert.equal(await restarted.view(conv.id), null); // deregistered → stops resolving, no cached ghost
  if (unsubscribe) assert.equal(closed, true); // if the open won the race, removal still closed its stream
});

test('removeProject racing a cold getActivity does not resurrect the deregistered project', async () => {
  const { home, projectId, service } = await withProject();
  const conv = await makeConversation(service, projectId, 'presence');
  await service.say(conv.id, 'user', 'hi');

  // getActivity is the only resolveStore caller outside the opening/mutate
  // coordination, so a cold instance exercises the bare cold-scan path.
  const restarted = new RoundtableService({ home });
  await Promise.all([restarted.getActivity(conv.id), restarted.removeProject(projectId)]);

  assert.equal(await restarted.view(conv.id), null); // no resurrected store/map entry
  assert.deepEqual(await restarted.listProjects(), []);
});

test('createConversation racing removeProject never yields a conversation that resolves in the removed project', async () => {
  const { service, projectId } = await withProject();
  const [created] = await Promise.all([
    service.createConversation(projectId, 'racer'),
    service.removeProject(projectId),
  ]);

  // The create may win or lose the race, but the project is gone either way and a
  // surviving transcript must not resolve (the deregistered-ids-stop-resolving contract).
  if (created.ok) assert.equal(await service.view(created.conversation.id), null);
  assert.deepEqual(await service.listProjects(), []);
});

test('listProjects orders projects by most recent conversation activity', async () => {
  const home = await tempHome();
  const service = new RoundtableService({ home });
  const older = await service.addProject(await tempProjectPath());
  const newer = await service.addProject(await tempProjectPath());
  if (!older.ok || !newer.ok) throw new Error('addProject failed');

  const a = await makeConversation(service, older.project.id, 'older');
  const b = await makeConversation(service, newer.project.id, 'newer');
  // Pin distinct activity on disk so the ordering is deterministic (two real say()
  // calls could tie at millisecond resolution under load).
  await projectStore(home, older.project.path).update(a.id, { lastActivityAt: '2026-01-01T00:00:00.000Z' });
  await projectStore(home, newer.project.path).update(b.id, { lastActivityAt: '2026-06-30T00:00:00.000Z' });

  const order = (await service.listProjects()).map((group) => group.project.id);
  assert.deepEqual(order, [newer.project.id, older.project.id]); // most-recent-activity first
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

test('startServer creates and tightens only the projects root', async () => {
  const home = await tempHome();
  const projects = join(home, 'projects');
  await mkdir(projects, { recursive: true });
  await chmod(home, 0o777);
  await chmod(projects, 0o777);

  const started = await startServer({ home, port: await freePort() });
  if (!started) throw new Error('server did not start');
  try {
    assert.equal((await stat(home)).mode & 0o077, 0);
    assert.equal((await stat(projects)).mode & 0o077, 0);
  } finally {
    await started.close();
  }
});

test('a pre-existing flat conversations/ dir is never read, hardened, or deleted', async () => {
  const home = await tempHome();
  const flat = join(home, 'conversations');
  await mkdir(flat, { recursive: true });
  await writeFile(join(flat, 'legacy.meta.json'), '{"legacy":true}\n');
  await chmod(flat, 0o777);

  const started = await startServer({ home, port: await freePort() });
  if (!started) throw new Error('server did not start');
  try {
    assert.equal(await readFile(join(flat, 'legacy.meta.json'), 'utf8'), '{"legacy":true}\n'); // untouched
    assert.equal((await stat(flat)).mode & 0o077, 0o077); // its loose perms are left as-is — no code path touches it
  } finally {
    await started.close();
  }
});

test('startServer close ends live SSE streams', async () => {
  const home = await tempHome();
  const projectPath = await tempProjectPath();
  const started = await startServer({ home, port: await freePort() });
  if (!started) throw new Error('server did not start');

  const added = await fetch(`${started.url}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: projectPath }),
  });
  const project = (await added.json()) as { project: { id: string } };
  const create = await fetch(`${started.url}/api/projects/${project.project.id}/conversations`, {
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
