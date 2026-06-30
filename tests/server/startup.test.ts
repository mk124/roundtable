import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { access, chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoundtableService, startServer } from '../../src/server/startup.ts';
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

async function withFakeTmux(fn: (logPath: string, sessionsPath: string) => Promise<void>, options: { killRemoves?: boolean } = {}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'rt-fake-tmux-'));
  const bin = join(root, 'bin');
  const log = join(root, 'tmux.log');
  const sessions = join(root, 'sessions.txt');
  await mkdir(bin);
  const tmux = join(bin, 'tmux');
  await writeFile(
    tmux,
    `#!/usr/bin/env node
const fs = require('node:fs');
const log = process.env.RT_TMUX_LOG;
const sessions = process.env.RT_TMUX_SESSIONS;
const args = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
if (args[0] === '-V') {
  console.log('tmux 3.4');
  process.exit(0);
}
if (args[0] === 'new-session') {
  const index = args.indexOf('-s');
  if (index >= 0) fs.appendFileSync(sessions, args[index + 1] + '\\n');
  process.exit(0);
}
if (args[0] === 'has-session') {
  const index = args.indexOf('-t');
  const target = index >= 0 ? args[index + 1] : '';
  const live = fs.existsSync(sessions) ? fs.readFileSync(sessions, 'utf8').split('\\n') : [];
  process.exit(live.includes(target) ? 0 : 1);
}
if (args[0] === 'list-sessions') {
  if (fs.existsSync(sessions)) process.stdout.write(fs.readFileSync(sessions, 'utf8'));
  process.exit(0);
}
if (args[0] === 'kill-session') {
  const index = args.indexOf('-t');
  const target = index >= 0 ? args[index + 1] : '';
  const live = fs.existsSync(sessions) ? fs.readFileSync(sessions, 'utf8').split('\\n').filter(Boolean) : [];
  if (${options.killRemoves !== false}) fs.writeFileSync(sessions, live.filter((name) => name !== target).join('\\n') + '\\n');
  process.exit(0);
}
process.exit(0);
`,
  );
  await chmod(tmux, 0o755);
  for (const command of ['claude', 'codex', 'agy']) {
    const path = join(bin, command);
    await writeFile(path, '#!/bin/sh\nexit 0\n');
    await chmod(path, 0o755);
  }

  const prevPath = process.env.PATH;
  const prevLog = process.env.RT_TMUX_LOG;
  const prevSessions = process.env.RT_TMUX_SESSIONS;
  process.env.PATH = `${bin}:${prevPath ?? ''}`;
  process.env.RT_TMUX_LOG = log;
  process.env.RT_TMUX_SESSIONS = sessions;
  try {
    await fn(log, sessions);
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevLog === undefined) delete process.env.RT_TMUX_LOG;
    else process.env.RT_TMUX_LOG = prevLog;
    if (prevSessions === undefined) delete process.env.RT_TMUX_SESSIONS;
    else process.env.RT_TMUX_SESSIONS = prevSessions;
  }
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

/** The retained transcript path for behaviours whose contract explicitly keeps files. */
const conversationFile = (home: string, projectPath: string, meta: ConversationMetadata) =>
  join(home, 'projects', encodeProjectDir(projectPath), 'conversations', meta.filename);

async function waitForNextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() === start) await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

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

test('a created conversation appears under its project and is resolvable by id alone', async () => {
  const { service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'in project');
  const projects = await service.listProjects();
  assert.equal(projects.find((group) => group.project.id === projectId)?.conversations.some((c) => c.id === conv.id), true);
  assert.equal((await service.view(conv.id))?.cursor, 0);
});

test('a fresh service resolves an existing conversation id by scanning projects', async () => {
  const { home, projectId, service } = await withProject();
  const conv = await makeConversation(service, projectId, 'persisted');
  await service.say(conv.id, { model: 'user' }, 'hello');

  // A new instance (as after a restart) starts with an empty id-to-project map.
  const restarted = new RoundtableService({ home });
  assert.equal((await restarted.view(conv.id))?.events.length, 1);
});

test('say persists read-only to metadata once the conversation total is exhausted', async () => {
  const { home, service, projectId } = await withProject(TINY);
  const conv = await makeConversation(service, projectId, 'full');

  const res = await service.say(conv.id, { model: 'user' }, 'hi');
  assert.equal(res.ok, false);

  const restarted = new RoundtableService({ home, limits: TINY });
  const restored = (await restarted.listProjects()).flatMap((group) => group.conversations).find((c) => c.id === conv.id);
  assert.equal(restored?.readOnly, true);
});

test('say preserves message markdown exactly after the non-empty check', async () => {
  const { service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'markdown');
  const body = '  indented code\n\n- item  \n';

  const res = await service.say(conv.id, { model: 'user' }, body);
  assert.equal(res.ok, true);

  const event = (await service.view(conv.id))?.events[0];
  assert.ok(event?.type === 'message');
  assert.equal(event.body, body);
});

test('say requires a model and text', async () => {
  const { service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'required model');

  assert.deepEqual(await service.say(conv.id, { model: '' }, 'hello'), { ok: false, error: 'model and text are required' });
  assert.deepEqual(await service.say(conv.id, { model: 'Claude Opus 4.8' }, '  '), { ok: false, error: 'model and text are required' });
});

test('concurrent first access shares one context, so no message is stranded', async () => {
  const { service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'race');

  // A view and a say hit the not-yet-opened conversation at the same instant.
  const [, sayRes] = await Promise.all([service.view(conv.id), service.say(conv.id, { model: 'agent' }, 'hello')]);
  assert.equal(sayRes.ok, true);

  // The message is visible through the shared context, not lost on a duplicate log.
  assert.equal((await service.view(conv.id))?.events.length, 1);
});

test('deleting during a first-access open resurrects no file and no ghost context', async () => {
  const { home, service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'racey');

  // A first access (which opens the log) races a delete of the same conversation.
  await Promise.all([service.view(conv.id), service.deleteConversation(conv.id)]);

  assert.equal(await service.view(conv.id), null);
  assert.equal(await new RoundtableService({ home }).view(conv.id), null);
  assert.equal((await service.listProjects()).flatMap((group) => group.conversations).some((c) => c.id === conv.id), false);
});

test('deleting an open conversation wins over later same-tick mutations', async () => {
  const { home, service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'open race');
  await service.view(conv.id); // open and cache the context first

  const deleteResult = service.deleteConversation(conv.id);
  const sayResult = service.say(conv.id, { model: 'agent' }, 'late message');
  const activityResult = service.setActivity(conv.id, 'agent', 'thinking');

  assert.deepEqual(await deleteResult, { ok: true });
  assert.deepEqual(await sayResult, { ok: false, error: 'unknown conversation' });
  assert.deepEqual(await activityResult, { ok: false, error: 'unknown conversation' });
  assert.equal(await service.view(conv.id), null);
  assert.equal(await new RoundtableService({ home }).view(conv.id), null);
});

test('deleteConversation leaves data and streams intact when agent stop is unconfirmed', async () => {
  await withFakeTmux(async () => {
    const { home, projectPath, service, projectId } = await withProject();
    const conv = await makeConversation(service, projectId, 'kept on delete stop failure');
    await service.say(conv.id, { model: 'user' }, 'hi');
    const added = await service.addAgent(conv.id, 'claude');
    assert.equal(added.ok, true);
    let closed = false;
    const client: SseClient = { write() {}, close() { closed = true; } };
    assert.ok(await service.subscribe(conv.id, client, 0));

    const deleted = await service.deleteConversation(conv.id);

    assert.deepEqual(deleted, { ok: false, error: 'agent stop could not be confirmed', status: 503 });
    assert.equal(closed, false);
    assert.equal((await service.view(conv.id))?.events.length, 1);
    assert.equal((await new RoundtableService({ home }).view(conv.id))?.events.length, 1);
    await access(conversationFile(home, projectPath, conv));
  }, { killRemoves: false });
});

test('removeProject deregisters, retains transcripts, and stops resolving its ids until re-added', async () => {
  const { home, projectPath, service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'kept');
  await service.say(conv.id, { model: 'user' }, 'hi'); // warm the context

  assert.deepEqual(await service.removeProject(projectId), { ok: true });
  assert.equal(await service.view(conv.id), null); // id no longer resolves
  assert.deepEqual(await service.listProjects(), []); // gone from the sidebar
  await access(conversationFile(home, projectPath, conv)); // transcript retained on disk

  const readded = await service.addProject(projectPath);
  if (!readded.ok) throw new Error(readded.error);
  assert.equal((await service.view(conv.id))?.events.length, 1); // restored, message intact

  assert.deepEqual(await service.removeProject('deadbeefdeadbeef'), { ok: false, error: 'unknown project', status: 404 });
});

test('removeProject leaves project and streams intact when agent stop is unconfirmed', async () => {
  await withFakeTmux(async () => {
    const { home, projectPath, service, projectId } = await withProject();
    const conv = await makeConversation(service, projectId, 'kept on stop failure');
    await service.say(conv.id, { model: 'user' }, 'hi');
    const added = await service.addAgent(conv.id, 'claude');
    assert.equal(added.ok, true);
    let closed = false;
    const client: SseClient = { write() {}, close() { closed = true; } };
    assert.ok(await service.subscribe(conv.id, client, 0));

    const removed = await service.removeProject(projectId);

    assert.deepEqual(removed, { ok: false, error: 'agent stop could not be confirmed', status: 503 });
    assert.equal(closed, false);
    assert.equal((await service.view(conv.id))?.events.length, 1);
    assert.deepEqual((await service.listProjects()).map((group) => group.project.id), [projectId]);
    await access(conversationFile(home, projectPath, conv));
  }, { killRemoves: false });
});

test('removeProject interleaved with say/subscribe leaves the id unresolved and the stream closed', async () => {
  const { service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'racey project');
  await service.view(conv.id); // warm context + SSE hub

  let closed = false;
  const client: SseClient = { write() {}, close() { closed = true; } };
  assert.ok(await service.subscribe(conv.id, client, 0));

  await Promise.all([service.removeProject(projectId), service.say(conv.id, { model: 'agent' }, 'late')]);

  assert.equal(closed, true); // the warm SSE stream was closed, not leaked
  assert.equal(await service.view(conv.id), null); // resolves to not-found
});

test('removeProject racing a cold first-access subscribe leaves no resolvable zombie', async () => {
  const { home, projectId, service } = await withProject();
  const conv = await makeConversation(service, projectId, 'cold');
  await service.say(conv.id, { model: 'user' }, 'hi');

  // A fresh instance (as after a restart) starts with an empty id-to-project map, so
  // the first access cold-resolves the id while removeProject runs concurrently.
  const restarted = new RoundtableService({ home });
  let closed = false;
  const client: SseClient = { write() {}, close() { closed = true; } };
  const [unsubscribe] = await Promise.all([
    restarted.subscribe(conv.id, client, 0),
    restarted.removeProject(projectId),
  ]);

  assert.equal(await restarted.view(conv.id), null); // deregistered; stops resolving, no cached ghost
  if (unsubscribe) assert.equal(closed, true); // if the open won the race, removal still closed its stream
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

  await makeConversation(service, older.project.id, 'older');
  await waitForNextMillisecond();
  await makeConversation(service, newer.project.id, 'newer');

  const order = (await service.listProjects()).map((group) => group.project.id);
  assert.deepEqual(order, [newer.project.id, older.project.id]); // most-recent-activity first
});

test('startServer surfaces a bind failure, closes adopted agents, and releases the lock', async () => {
  await withFakeTmux(async () => {
    const home = await tempHome();
    const projectPath = await tempProjectPath();
    const setup = new RoundtableService({ home });
    const added = await setup.addProject(projectPath);
    if (!added.ok) throw new Error(added.error);
    const conv = await makeConversation(setup, added.project.id, 'adopted');
    const agent = await setup.addAgent(conv.id, 'claude');
    assert.equal(agent.ok, true);

    const blocker = net.createServer();
    const port = await new Promise<number>((r) => blocker.listen(0, '127.0.0.1', () => r((blocker.address() as net.AddressInfo).port)));
    try {
      await assert.rejects(startServer({ home, port })); // EADDRINUSE rejects cleanly, no uncaught crash
      assert.equal((await new RoundtableService({ home }).listAgents(conv.id))?.agents[0]?.status, 'stopped');
      const lock = await StorageLock.acquire(home); // the lock was freed, so a retry can take it
      assert.ok(lock);
      await lock!.release();
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

test('startServer close is idempotent and releases the lock', async () => {
  const home = await tempHome();
  const started = await startServer({ home, port: await freePort() });
  if (!started) throw new Error('server did not start');

  await Promise.all([started.close(), started.close()]);

  const lock = await StorageLock.acquire(home);
  assert.ok(lock);
  await lock!.release();
});

test('startServer close stops tmux-owned agents', async () => {
  await withFakeTmux(async () => {
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
    const created = await fetch(`${started.url}/api/projects/${project.project.id}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'agents' }),
    });
    const body = (await created.json()) as { conversation: { id: string } };
    const agent = await fetch(`${started.url}/api/conversations/${body.conversation.id}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'claude' }),
    });
    assert.equal(agent.status, 200);

    await started.close();

    assert.equal((await new RoundtableService({ home }).listAgents(body.conversation.id))?.agents[0]?.status, 'stopped');
  });
});

test('startServer close releases resources even when agent stop is unconfirmed', async () => {
  await withFakeTmux(async (_logPath) => {
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
    const created = await fetch(`${started.url}/api/projects/${project.project.id}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'agents' }),
    });
    const body = (await created.json()) as { conversation: { id: string } };
    const agent = await fetch(`${started.url}/api/conversations/${body.conversation.id}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'claude' }),
    });
    assert.equal(agent.status, 200);
    const stream = await fetch(`${started.url}/api/conversations/${body.conversation.id}/events`);
    const reader = stream.body!.getReader();

    await assert.rejects(started.close(), /agent stop could not be confirmed/);

    const closed = await Promise.race([
      (async () => {
        for (;;) {
          if ((await reader.read()).done) return true;
        }
      })(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream stayed open')), 1000)),
    ]);
    assert.equal(closed, true);
    const lock = await StorageLock.acquire(home);
    assert.ok(lock);
    await lock!.release();
    await assert.rejects(fetch(`${started.url}/api/projects`));
  }, { killRemoves: false });
});
