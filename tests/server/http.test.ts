import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ConversationView, type RoundtableApp } from '../../src/server/http.ts';
import { RedactingLogger } from '../../src/server/logging.ts';
import type { ConversationMetadata, ProjectMetadata } from '../../src/types.ts';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

const CONV: ConversationMetadata = { id: 'c1', title: 'Chat', filename: 'c.md', createdAt: 't', lastActivityAt: 't' };
const PROJECT: ProjectMetadata = { id: 'p1', path: '/abs/proj', title: 'proj', addedAt: 't' };

function fakeView(): ConversationView {
  return {
    readOnly: false,
    events: [
      { id: 'e1', type: 'message', timestamp: 't', author: 'user', body: 'hi' },
      { id: 'e2', type: 'message', timestamp: 't', author: 'Claude Opus 4.8', body: '**hello**' },
    ],
    cursor: 2,
  };
}

function fakeApp(over: Partial<RoundtableApp> = {}): RoundtableApp {
  return {
    async listProjects() {
      return [{ project: PROJECT, conversations: [CONV] }];
    },
    async addProject(path) {
      return path.startsWith('/') ? { ok: true, project: { ...PROJECT, path } } : { ok: false, error: 'project path must be absolute' };
    },
    async removeProject(id) {
      return id === 'p1' ? { ok: true } : { ok: false, error: 'unknown project' };
    },
    async createConversation(projectId, title) {
      return projectId === 'p1' ? { ok: true, conversation: { ...CONV, title } } : { ok: false, error: 'unknown project' };
    },
    async deleteConversation(id) {
      return id === 'c1' ? { ok: true } : { ok: false, error: 'unknown conversation' };
    },
    async renameConversation(id, title) {
      if (id !== 'c1') return { ok: false, error: 'unknown conversation', status: 404 };
      if (title.trim() === '') return { ok: false, error: 'title is required', status: 400 };
      return { ok: true, conversation: { ...CONV, title } };
    },
    async view(id) {
      return id === 'c1' ? fakeView() : null;
    },
    async say(id, _identity, text) {
      if (id !== 'c1') return { ok: false, error: 'unknown conversation' };
      if (text.length > 1000) return { ok: false, error: 'message exceeds the size limit' };
      return { ok: true, cursor: 3 };
    },
    async setActivity(id) {
      return id === 'c1' ? { ok: true } : { ok: false, error: 'unknown conversation' };
    },
    async getActivity(id) {
      return id === 'c1' ? [{ author: 'Claude Opus 4.8', state: 'thinking', since: 't' }] : null;
    },
    async heartbeat(id) {
      return id === 'c1';
    },
    async subscribeProjects() {
      return () => {};
    },
    async subscribe(id, client) {
      if (id !== 'c1') return null;
      queueMicrotask(() => client.write('id: 1\nevent: message\ndata: {"cursor":1}\n\n'));
      return () => {};
    },
    async listAgents(id) {
      return id === 'c1' ? { tmuxAvailable: true, agents: [] } : null;
    },
    async addAgent(id, kind) {
      return id === 'c1'
        ? { ok: true, agent: { instanceId: 'a1b2c3d4', kind, name: 'Claude-a1b2', status: 'starting', resumable: false, createdAt: 't' } }
        : { ok: false, error: 'unknown conversation', status: 404 };
    },
    async configureAgent(id, instanceId) {
      return id === 'c1' && instanceId === 'a1' ? { ok: true } : { ok: false, status: 404 };
    },
    async resumeAgent(id, instanceId) {
      return id === 'c1' && instanceId === 'a1' ? { ok: true } : { ok: false, status: 404 };
    },
    async stopAgent(id, instanceId) {
      return id === 'c1' && instanceId === 'a1' ? { ok: true } : { ok: false, status: 404 };
    },
    async removeAgent(id, instanceId) {
      return id === 'c1' && instanceId === 'a1' ? { ok: true } : { ok: false, status: 404 };
    },
    ...over,
  };
}

async function withServer(fn: (ctx: { origin: string; app: RoundtableApp }) => Promise<void>, app = fakeApp()): Promise<void> {
  const port = await freePort();
  const server = createServer({ app, logger: new RedactingLogger({ write() {} }), bindHost: '127.0.0.1', port });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  try {
    await fn({ origin: `http://127.0.0.1:${port}`, app });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const postJson = (origin: string, path: string, body: unknown, extra: Record<string, string> = {}) =>
  fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });

// Projects (sidebar gating + grouping)

test('POST /api/projects adds a project, rejects an invalid path, and is CSRF-guarded', async () => {
  await withServer(async ({ origin }) => {
    const evil = await postJson(origin, '/api/projects', { path: '/abs/proj' }, { Origin: 'http://evil.test' });
    assert.equal(evil.status, 403);
    const bad = await postJson(origin, '/api/projects', { path: 'relative' });
    assert.equal(bad.status, 400);
    const ok = await postJson(origin, '/api/projects', { path: '/abs/proj' });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { project: { path: string } }).project.path, '/abs/proj');
  });
});

test('DELETE /api/projects/:id removes a project, 404s an unknown id, and is CSRF-guarded', async () => {
  await withServer(async ({ origin }) => {
    const evil = await fetch(`${origin}/api/projects/p1`, { method: 'DELETE', headers: { Origin: 'http://evil.test' } });
    assert.equal(evil.status, 403);
    const missing = await fetch(`${origin}/api/projects/nope`, { method: 'DELETE' });
    assert.equal(missing.status, 404);
    const ok = await fetch(`${origin}/api/projects/p1`, { method: 'DELETE' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
  });
});

test('POST /api/projects/:id/conversations creates within the project and is CSRF-guarded', async () => {
  await withServer(async ({ origin }) => {
    const evil = await postJson(origin, '/api/projects/p1/conversations', { title: 'x' }, { Origin: 'http://evil.test' });
    assert.equal(evil.status, 403);
    const unknown = await postJson(origin, '/api/projects/nope/conversations', { title: 'x' });
    assert.equal(unknown.status, 400);
    const ok = await postJson(origin, '/api/projects/p1/conversations', { title: 'New chat' });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { conversation: { title: string } }).conversation.title, 'New chat');
  });
});

// Agents (launch + manage)

// Conversations by id (the agent contract, unchanged)

test('the view DTO renders markdown and exposes author + cursor', async () => {
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}/api/conversations/c1`);
    const body = (await res.json()) as { cursor: number; events: Array<{ author?: string; content?: Array<{ type: string }> }> };

    assert.equal(body.cursor, 2);
    assert.equal(body.events.length, 2);
    assert.equal(body.events[0]!.author, 'user');
    assert.equal(body.events[1]!.author, 'Claude Opus 4.8');
    assert.equal(body.events[1]!.content![0]!.type, 'paragraph');
  });
});

test('say returns the new cursor', async () => {
  await withServer(async ({ origin }) => {
    const res = await postJson(origin, '/api/conversations/c1/say', { model: 'Claude Opus 4.8', name: 'Opal', text: 'pong' });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, cursor: 3 });
  });
});

test('oversized JSON bodies are rejected', async () => {
  await withServer(async ({ origin }) => {
    const res = await postJson(origin, '/api/conversations/c1/say', { model: 'x', text: 'x'.repeat(2_100_000) });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'request body too large' });
  });
});

test('malformed JSON is rejected', async () => {
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}/api/projects/p1/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid JSON body' });
  });
});

test('messages?since returns events after the cursor as raw text, without a render tree', async () => {
  await withServer(async ({ origin }) => {
    const all = (await (await fetch(`${origin}/api/conversations/c1/messages?since=0`)).json()) as { messages: Array<{ text?: string; content?: unknown }>; cursor: number };
    assert.equal(all.messages.length, 2);
    assert.equal(all.cursor, 2);
    assert.equal(all.messages[1]!.text, '**hello**'); // raw body for agents
    assert.equal(all.messages[1]!.content, undefined); // /messages carries no render tree

    const tail = (await (await fetch(`${origin}/api/conversations/c1/messages?since=2`)).json()) as { messages: unknown[] };
    assert.equal(tail.messages.length, 0);

    const partial = (await (await fetch(`${origin}/api/conversations/c1/messages?since=1`)).json()) as { messages: Array<{ author?: string }> };
    assert.equal(partial.messages.length, 1);
    assert.equal(partial.messages[0]!.author, 'Claude Opus 4.8');
  });
});

test('say is CSRF-guarded: cross-site Origin is refused, same-origin and no-Origin pass', async () => {
  await withServer(async ({ origin }) => {
    const evil = await postJson(origin, '/api/conversations/c1/say', { model: 'x', text: 'hi' }, { Origin: 'http://evil.test' });
    assert.equal(evil.status, 403);
    const same = await postJson(origin, '/api/conversations/c1/say', { model: 'x', text: 'hi' }, { Origin: origin });
    assert.equal(same.status, 200);
    const agent = await postJson(origin, '/api/conversations/c1/say', { model: 'x', text: 'hi' }); // no Origin (non-browser)
    assert.equal(agent.status, 200);
  });
});

test('a loopback alias Origin (localhost) is accepted, not treated as cross-site', async () => {
  await withServer(async ({ origin }) => {
    const port = new URL(origin).port;
    const res = await postJson(origin, '/api/conversations/c1/say', { model: 'x', text: 'hi' }, { Origin: `http://localhost:${port}` });
    assert.equal(res.status, 200);
  });
});

test('CSRF guard refuses a foreign port and a loopback-lookalike host', async () => {
  await withServer(async ({ origin }) => {
    const wrongPort = await postJson(
      origin,
      '/api/conversations/c1/say',
      { model: 'x', text: 'hi' },
      { Origin: 'http://127.0.0.1:1' },
    );
    assert.equal(wrongPort.status, 403);
    const wrongScheme = await postJson(
      origin,
      '/api/conversations/c1/say',
      { model: 'x', text: 'hi' },
      { Origin: origin.replace('http:', 'https:') },
    );
    assert.equal(wrongScheme.status, 403);
    const lookalike = await postJson(
      origin,
      '/api/conversations/c1/say',
      { model: 'x', text: 'hi' },
      { Origin: 'http://127.0.0.1.evil.com' },
    );
    assert.equal(lookalike.status, 403);
  });
});

test('the heartbeat route accepts a same-origin browser post and 404s an unknown conversation', async () => {
  await withServer(async ({ origin }) => {
    // The browser always sends Origin, and the client swallows heartbeat errors, so a
    // broken route or an over-strict CSRF guard would silently stop watched agents.
    const same = await postJson(origin, '/api/conversations/c1/heartbeat', {}, { Origin: origin });
    assert.equal(same.status, 200);
    const unknown = await postJson(origin, '/api/conversations/nope/heartbeat', {});
    assert.equal(unknown.status, 404);
  });
});

test('DELETE removes a conversation, 404s an unknown id, and is CSRF-guarded', async () => {
  await withServer(async ({ origin }) => {
    const evil = await fetch(`${origin}/api/conversations/c1`, { method: 'DELETE', headers: { Origin: 'http://evil.test' } });
    assert.equal(evil.status, 403);
    const missing = await fetch(`${origin}/api/conversations/nope`, { method: 'DELETE' });
    assert.equal(missing.status, 404);
    const ok = await fetch(`${origin}/api/conversations/c1`, { method: 'DELETE' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
  });
});

test('PATCH renames a conversation, maps unknown/empty, and is CSRF-guarded', async () => {
  await withServer(async ({ origin }) => {
    const patch = (path: string, body: unknown, extra: Record<string, string> = {}) =>
      fetch(`${origin}${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });

    const evil = await patch('/api/conversations/c1', { title: 'x' }, { Origin: 'http://evil.test' });
    assert.equal(evil.status, 403);
    const missing = await patch('/api/conversations/nope', { title: 'x' });
    assert.equal(missing.status, 404);
    const empty = await patch('/api/conversations/c1', { title: '   ' });
    assert.equal(empty.status, 400);
    const ok = await patch('/api/conversations/c1', { title: 'Renamed' });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { conversation: { id: string; title: string } };
    assert.equal(body.conversation.title, 'Renamed');
    assert.equal(body.conversation.id, 'c1'); // id is unchanged
  });
});

test('every response carries a Content-Security-Policy', async () => {
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}/api/projects`);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  });
});

test('static files are served with safe path handling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rt-static-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>ok</title>');
  const port = await freePort();
  const server = createServer({ app: fakeApp(), logger: new RedactingLogger({ write() {} }), bindHost: '127.0.0.1', port, staticDir: dir });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  try {
    const origin = `http://127.0.0.1:${port}`;
    const index = await fetch(`${origin}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(index.headers.get('cache-control'), 'no-store');

    const traversal = await fetch(`${origin}/..%2f..%2fpackage.json`);
    assert.equal(traversal.status, 404);

    const missing = await fetch(`${origin}/nope.css`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
