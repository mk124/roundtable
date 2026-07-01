import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoundtableService } from '../../src/server/startup.ts';
import type { SseClient } from '../../src/server/sse.ts';
import type { SizeLimits } from '../../src/types.ts';

const tempHome = () => mkdtemp(join(tmpdir(), 'rt-svc-'));
const tempProjectPath = () => mkdtemp(join(tmpdir(), 'rt-proj-'));

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

async function waitForNextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() === start) await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

async function makeConversation(service: RoundtableService, projectId: string, title: string) {
  const created = await service.createConversation(projectId, title);
  if (!created.ok) throw new Error(created.error);
  return created.conversation;
}

async function waitForAgentStatus(service: RoundtableService, convId: string, instanceId: string, status: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if ((await service.listAgents(convId))?.agents.find((agent) => agent.instanceId === instanceId)?.status === status) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`agent ${instanceId} did not reach ${status}`);
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

test('a fresh service can read an existing conversation by id', async () => {
  const { home, projectId, service } = await withProject();
  const conv = await makeConversation(service, projectId, 'persisted');
  await service.say(conv.id, { model: 'user' }, 'hello');

  const restarted = new RoundtableService({ home });
  assert.equal((await restarted.view(conv.id))?.events.length, 1);
});

test('say restores read-only after restart once the conversation total is exhausted', async () => {
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

test('concurrent view and send do not lose the message', async () => {
  const { service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'race');

  const [, sayRes] = await Promise.all([service.view(conv.id), service.say(conv.id, { model: 'agent' }, 'hello')]);
  assert.equal(sayRes.ok, true);

  assert.equal((await service.view(conv.id))?.events.length, 1);
});

test('delete racing with a first read leaves no resolvable conversation', async () => {
  const { home, service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'racey');

  await Promise.all([service.view(conv.id), service.deleteConversation(conv.id)]);

  assert.equal(await service.view(conv.id), null);
  assert.equal(await new RoundtableService({ home }).view(conv.id), null);
  assert.equal((await service.listProjects()).flatMap((group) => group.conversations).some((c) => c.id === conv.id), false);
});

test('deleting an open conversation wins over later same-tick mutations', async () => {
  const { home, service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'open race');
  await service.view(conv.id);

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
    const { home, service, projectId } = await withProject();
    const conv = await makeConversation(service, projectId, 'kept on delete stop failure');
    await service.say(conv.id, { model: 'user' }, 'hi');
    const added = await service.addAgent(conv.id, 'claude');
    assert.equal(added.ok, true);
    if (added.ok) await waitForAgentStatus(service, conv.id, added.agent.instanceId, 'running');
    let closed = false;
    const client: SseClient = { write() {}, close() { closed = true; } };
    assert.ok(await service.subscribe(conv.id, client, 0));

    const deleted = await service.deleteConversation(conv.id);

    assert.deepEqual(deleted, { ok: false, error: 'agent stop could not be confirmed', status: 503 });
    assert.equal(closed, false);
    assert.equal((await service.view(conv.id))?.events.length, 1);
    assert.equal((await new RoundtableService({ home }).view(conv.id))?.events.length, 1);
  }, { killRemoves: false });
});

test('removeProject deregisters, retains transcripts, and stops resolving its ids until re-added', async () => {
  const { projectPath, service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'kept');
  await service.say(conv.id, { model: 'user' }, 'hi');

  assert.deepEqual(await service.removeProject(projectId), { ok: true });
  assert.equal(await service.view(conv.id), null);
  assert.deepEqual(await service.listProjects(), []);

  const readded = await service.addProject(projectPath);
  if (!readded.ok) throw new Error(readded.error);
  assert.equal((await service.view(conv.id))?.events.length, 1);

  assert.deepEqual(await service.removeProject('deadbeefdeadbeef'), { ok: false, error: 'unknown project', status: 404 });
});

test('removeProject leaves project and streams intact when agent stop is unconfirmed', async () => {
  await withFakeTmux(async () => {
    const { service, projectId } = await withProject();
    const conv = await makeConversation(service, projectId, 'kept on stop failure');
    await service.say(conv.id, { model: 'user' }, 'hi');
    const added = await service.addAgent(conv.id, 'claude');
    assert.equal(added.ok, true);
    if (added.ok) await waitForAgentStatus(service, conv.id, added.agent.instanceId, 'running');
    let closed = false;
    const client: SseClient = { write() {}, close() { closed = true; } };
    assert.ok(await service.subscribe(conv.id, client, 0));

    const removed = await service.removeProject(projectId);

    assert.deepEqual(removed, { ok: false, error: 'agent stop could not be confirmed', status: 503 });
    assert.equal(closed, false);
    assert.equal((await service.view(conv.id))?.events.length, 1);
    assert.deepEqual((await service.listProjects()).map((group) => group.project.id), [projectId]);
  }, { killRemoves: false });
});

test('removeProject interleaved with say/subscribe leaves the id unresolved and the stream closed', async () => {
  const { service, projectId } = await withProject();
  const conv = await makeConversation(service, projectId, 'racey project');
  await service.view(conv.id);

  let closed = false;
  const client: SseClient = { write() {}, close() { closed = true; } };
  assert.ok(await service.subscribe(conv.id, client, 0));

  await Promise.all([service.removeProject(projectId), service.say(conv.id, { model: 'agent' }, 'late')]);

  assert.equal(closed, true);
  assert.equal(await service.view(conv.id), null);
});

test('removeProject racing a first subscribe leaves no resolvable conversation', async () => {
  const { home, projectId, service } = await withProject();
  const conv = await makeConversation(service, projectId, 'cold');
  await service.say(conv.id, { model: 'user' }, 'hi');

  const restarted = new RoundtableService({ home });
  let closed = false;
  const client: SseClient = { write() {}, close() { closed = true; } };
  const [unsubscribe] = await Promise.all([
    restarted.subscribe(conv.id, client, 0),
    restarted.removeProject(projectId),
  ]);

  assert.equal(await restarted.view(conv.id), null);
  if (unsubscribe) assert.equal(closed, true);
});

test('createConversation racing removeProject never yields a conversation that resolves in the removed project', async () => {
  const { service, projectId } = await withProject();
  const [created] = await Promise.all([
    service.createConversation(projectId, 'racer'),
    service.removeProject(projectId),
  ]);

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
