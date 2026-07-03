import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentCoordinator, type CoordinatorDeps } from '../../src/agents/coordinator.ts';
import type { AgentKind, AgentRecord } from '../../src/agents/record.ts';
import type { ConversationStore } from '../../src/conversations/store.ts';
import type { AgentSupervisor } from '../../src/agents/supervisor.ts';
import { agentSessionInScope, agentSessionName } from '../../src/agents/session-name.ts';

const CONV = '00000000000000a1';

class FakeStore {
  agents = new Map<string, AgentRecord[]>();

  async readAgents(id: string): Promise<AgentRecord[]> {
    return (this.agents.get(id) ?? []).map((r) => ({ ...r }));
  }

  async readAgentsForReconcile(id: string): Promise<AgentRecord[] | null> {
    return this.readAgents(id);
  }

  async writeAgents(id: string, records: AgentRecord[]): Promise<void> {
    this.agents.set(id, records);
  }
}

class FakeSupervisor {
  live = new Set<string>();

  sessionName(convId: string, instanceId: string, kind: AgentKind = 'claude') {
    return agentSessionName('local', kind, convId, instanceId);
  }

  async available() {
    return true;
  }

  reserveCapture(): boolean {
    return true;
  }

  releaseCapture(): void {}

  async launch(spec: { convId: string; instanceId: string; kind: AgentKind; sessionId?: string }): Promise<{ started: boolean; sessionId: string | null }> {
    this.live.add(this.sessionName(spec.convId, spec.instanceId, spec.kind));
    return { started: true, sessionId: spec.sessionId ?? null };
  }

  async stop(convId: string, instanceId: string) {
    for (const session of [...this.live].filter((name) => agentSessionInScope(name, 'local', convId, instanceId))) {
      this.live.delete(session);
    }
    return true;
  }

  async stopAll(convId?: string): Promise<{ ok: boolean; sessions: string[] | null }> {
    const sessions = [...this.live].filter((name) => agentSessionInScope(name, 'local', convId));
    for (const session of sessions) this.live.delete(session);
    return { ok: true, sessions };
  }

  async liveSessions(convId?: string): Promise<string[] | null> {
    return [...this.live].filter((name) => agentSessionInScope(name, 'local', convId));
  }
}

function make(overrides: Partial<CoordinatorDeps> = {}) {
  const store = new FakeStore();
  const sup = new FakeSupervisor();
  const chains = new Map<string, Promise<unknown>>();
  const lock = <T>(convId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(convId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(convId, run.then(() => undefined, () => undefined));
    return run;
  };
  const coord = new AgentCoordinator({
    supervisor: sup as unknown as AgentSupervisor,
    lock,
    storeFor: async () => store as unknown as ConversationStore,
    agentContextFor: async () => ({ store: store as unknown as ConversationStore, cwd: '/proj' }),
    roundtablePath: '/repo',
    baseUrl: 'http://127.0.0.1:8787',
    watcherCount: () => 1,
    graceMs: 15,
    cap: 3,
    ...overrides,
  });
  return { coord, store };
}

test('the per-conversation cap rejects with 429', async () => {
  const { coord } = make({ cap: 2 });
  assert.ok((await coord.add(CONV, 'claude')).ok);
  assert.ok((await coord.add(CONV, 'claude')).ok);
  const third = await coord.add(CONV, 'claude');
  assert.equal(third.ok, false);
  assert.equal(third.ok === false && third.status, 429);
});

test('resume rejects a stopped agent without a captured session id', async () => {
  const { coord, store } = make();
  await store.writeAgents(CONV, [
    { kind: 'codex', instanceId: 'no-session', name: 'Codex-nos', createdAt: 't', status: 'stopped' },
  ]);

  const res = await coord.resume(CONV, 'no-session');

  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(res.error, 'agent is not resumable');
  assert.equal((await coord.list(CONV))![0]!.status, 'stopped');
});

test('stop keeps a stopped record; remove deletes it', async () => {
  const { coord } = make();
  const add = await coord.add(CONV, 'claude');
  const id = add.ok ? add.agent.instanceId : '';

  await coord.stop(CONV, id);
  assert.equal((await coord.list(CONV))![0]!.status, 'stopped');

  await coord.remove(CONV, id);
  assert.deepEqual(await coord.list(CONV), []);
});

test('resume relaunches resumable stopped and errored agents, then rejects a running one', async () => {
  const { coord, store } = make();
  const add = await coord.add(CONV, 'claude');
  const id = add.ok ? add.agent.instanceId : '';
  await coord.stop(CONV, id);

  await coord.resume(CONV, id);
  assert.equal((await coord.list(CONV))![0]!.status, 'running');

  const running = await coord.resume(CONV, id);
  assert.equal(running.ok, false);
  assert.equal(running.status, 400);

  await store.writeAgents(CONV, [{ kind: 'codex', instanceId: 'errored-agent', name: 'Codex-error', createdAt: 't', status: 'errored' }]);
  assert.equal((await coord.list(CONV))![0]!.resumable, true);

  const errored = await coord.resume(CONV, 'errored-agent');
  assert.equal(errored.ok, true);
  assert.equal((await coord.list(CONV))![0]!.status, 'running');
});
