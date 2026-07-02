import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../../src/conversations/store.ts';
import type { AgentRecord } from '../../src/agents/record.ts';

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), 'rt-store-'));
  return { store: new ConversationStore(root), dir: join(root, 'conversations') };
}

const RECORDS: AgentRecord[] = [
  {
    kind: 'claude',
    instanceId: 'a1b2c3d4',
    name: 'Claude-a1b2',
    sessionId: '0123abcd-0123-abcd-0123-0123456789ab',
    createdAt: '2026-07-02T00:00:00.000Z',
    status: 'running',
  },
  { kind: 'codex', instanceId: 'e5f6a7b8', name: 'Codex-e5f6', createdAt: '2026-07-02T00:01:00.000Z', status: 'stopped' },
];

const metaPath = (dir: string, id: string) => join(dir, `${id}.meta.json`);

test('agent records round-trip through the meta sidecar', async () => {
  const { store } = await makeStore();
  const conv = await store.create('with agents');

  await store.writeAgents(conv.id, RECORDS);

  assert.deepEqual(await store.readAgents(conv.id), RECORDS);
});

test('a conversation without agents reads as empty, not corrupt', async () => {
  const { store } = await makeStore();
  const conv = await store.create('no agents');

  assert.deepEqual(await store.readAgentsForReconcile(conv.id), []);
});

test('clearing agent records leaves no trace on the conversation', async () => {
  const { store } = await makeStore();
  const conv = await store.create('cleared');

  await store.writeAgents(conv.id, RECORDS);
  await store.writeAgents(conv.id, []);

  assert.deepEqual(await store.readAgents(conv.id), []);
  assert.equal((await store.get(conv.id))?.agents, undefined);
});

test('unreadable records signal corrupt (null), never an empty list', async () => {
  const { store, dir } = await makeStore();

  const broken = await store.create('unparseable meta');
  await writeFile(metaPath(dir, broken.id), 'not json');
  assert.equal(await store.readAgentsForReconcile(broken.id), null);

  const malformed = await store.create('malformed agents');
  const meta = JSON.parse(await readFile(metaPath(dir, malformed.id), 'utf8')) as Record<string, unknown>;
  await writeFile(metaPath(dir, malformed.id), JSON.stringify({ ...meta, agents: [{ kind: 'claude' }] }));
  assert.equal(await store.readAgentsForReconcile(malformed.id), null);
});

test('rename and update preserve agent records', async () => {
  const { store } = await makeStore();
  const conv = await store.create('before rename');
  await store.writeAgents(conv.id, RECORDS);

  await store.update(conv.id, { lastActivityAt: '2026-07-02T01:00:00.000Z' });
  await store.rename(conv.id, 'after rename');

  assert.deepEqual(await store.readAgents(conv.id), RECORDS);
  assert.equal((await store.get(conv.id))?.title, 'after rename');
});

test('writeAgents for an unknown conversation writes nothing', async () => {
  const { store, dir } = await makeStore();
  await store.create('only this one'); // ensures the directory exists

  await store.writeAgents('deadbeefdeadbeef', RECORDS);

  assert.equal((await readdir(dir)).some((name) => name.startsWith('deadbeefdeadbeef')), false);
});

test('delete removes the conversation and its records entirely', async () => {
  const { store, dir } = await makeStore();
  const conv = await store.create('doomed');
  await store.writeAgents(conv.id, RECORDS);

  assert.equal(await store.delete(conv.id), true);

  assert.equal(await store.get(conv.id), null);
  assert.deepEqual(await readdir(dir), []);
});
