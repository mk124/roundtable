import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ConversationView, type RoundtableApp } from '../../src/server/http.ts';
import { RedactingLogger } from '../../src/server/logging.ts';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

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
    async listConversations() {
      return [{ id: 'c1', title: 'Chat', filename: 'c.md', createdAt: 't', lastActivityAt: 't' }];
    },
    async createConversation(title) {
      return { ok: true, conversation: { id: 'c1', title, filename: 'c.md', createdAt: 't', lastActivityAt: 't' } };
    },
    async deleteConversation(id) {
      return id === 'c1' ? { ok: true } : { ok: false, error: 'unknown conversation' };
    },
    async view(id) {
      return id === 'c1' ? fakeView() : null;
    },
    async say(id, _author, text) {
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
    async subscribe(id, client) {
      if (id !== 'c1') return null;
      queueMicrotask(() => client.write('id: 1\nevent: message\ndata: {"cursor":1}\n\n'));
      return () => {};
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

test('lists conversations with no auth (loopback is the only boundary)', async () => {
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}/api/conversations`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { conversations: unknown[] }).conversations.length, 1);
  });
});

test('createConversation succeeds and is CSRF-guarded like other state changes', async () => {
  await withServer(async ({ origin }) => {
    const evil = await postJson(origin, '/api/conversations', { title: 'x' }, { Origin: 'http://evil.test' });
    assert.equal(evil.status, 403);
    const ok = await postJson(origin, '/api/conversations', { title: 'New chat' });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { conversation: { title: string } }).conversation.title, 'New chat');
  });
});

test('the view DTO renders markdown and exposes author + cursor', async () => {
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}/api/conversations/c1`);
    const body = (await res.json()) as { cursor: number; events: Array<{ author?: string; content?: Array<{ type: string }> }> };
    assert.equal(body.cursor, 2);
    assert.equal(body.events.length, 2);
    assert.equal(body.events[0]!.author, 'user');
    assert.equal(body.events[1]!.author, 'Claude Opus 4.8');
    assert.equal(body.events[1]!.content![0]!.type, 'paragraph'); // markdown rendered to nodes
  });
});

test('say appends and returns the new cursor', async () => {
  await withServer(async ({ origin }) => {
    const res = await postJson(origin, '/api/conversations/c1/say', { author: 'Claude Opus 4.8', text: 'pong' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, cursor: 3 });
  });
});

test('say rejects an oversized message (AE17)', async () => {
  await withServer(async ({ origin }) => {
    const res = await postJson(origin, '/api/conversations/c1/say', { author: 'x', text: 'x'.repeat(2000) });
    assert.equal(res.status, 400);
  });
});

test('malformed JSON is rejected before the app is called', async () => {
  let called = false;
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid JSON body' });
    assert.equal(called, false);
  }, fakeApp({
    async createConversation() {
      called = true;
      return { ok: true, conversation: { id: 'c2', title: 'bad', filename: 'bad.md', createdAt: 't', lastActivityAt: 't' } };
    },
  }));
});

test('oversized JSON bodies are rejected before the app is called', async () => {
  let called = false;
  await withServer(async ({ origin }) => {
    const res = await postJson(origin, '/api/conversations/c1/say', { author: 'x', text: 'x'.repeat(2_100_000) });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'request body too large' });
    assert.equal(called, false);
  }, fakeApp({
    async say() {
      called = true;
      return { ok: true, cursor: 99 };
    },
  }));
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
    const evil = await postJson(origin, '/api/conversations/c1/say', { author: 'x', text: 'hi' }, { Origin: 'http://evil.test' });
    assert.equal(evil.status, 403);
    const same = await postJson(origin, '/api/conversations/c1/say', { author: 'x', text: 'hi' }, { Origin: origin });
    assert.equal(same.status, 200);
    const agent = await postJson(origin, '/api/conversations/c1/say', { author: 'x', text: 'hi' }); // no Origin (non-browser)
    assert.equal(agent.status, 200);
  });
});

test('a loopback alias Origin (localhost) is accepted, not treated as cross-site', async () => {
  await withServer(async ({ origin }) => {
    const port = new URL(origin).port;
    const res = await postJson(origin, '/api/conversations/c1/say', { author: 'x', text: 'hi' }, { Origin: `http://localhost:${port}` });
    assert.equal(res.status, 200);
  });
});

test('crossSite refuses a foreign port and a loopback-lookalike host', async () => {
  await withServer(async ({ origin }) => {
    const wrongPort = await postJson(
      origin,
      '/api/conversations/c1/say',
      { author: 'x', text: 'hi' },
      { Origin: 'http://127.0.0.1:1' },
    );
    assert.equal(wrongPort.status, 403);
    const wrongScheme = await postJson(
      origin,
      '/api/conversations/c1/say',
      { author: 'x', text: 'hi' },
      { Origin: origin.replace('http:', 'https:') },
    );
    assert.equal(wrongScheme.status, 403);
    const lookalike = await postJson(
      origin,
      '/api/conversations/c1/say',
      { author: 'x', text: 'hi' },
      { Origin: 'http://127.0.0.1.evil.com' },
    );
    assert.equal(lookalike.status, 403);
  });
});

test('GET activity returns the current presence snapshot', async () => {
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}/api/conversations/c1/activity`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { active: Array<{ author: string; state: string }> };
    assert.equal(body.active[0]!.author, 'Claude Opus 4.8');
    assert.equal(body.active[0]!.state, 'thinking');
  });
});

test('POST activity is CSRF-guarded like say', async () => {
  await withServer(async ({ origin }) => {
    const evil = await postJson(origin, '/api/conversations/c1/activity', { author: 'x', state: 'thinking' }, { Origin: 'http://evil.test' });
    assert.equal(evil.status, 403);
    const ok = await postJson(origin, '/api/conversations/c1/activity', { author: 'x', state: 'thinking' });
    assert.equal(ok.status, 200);
    const clear = await postJson(origin, '/api/conversations/c1/activity', { author: 'x', state: null });
    assert.equal(clear.status, 200);
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

test('an unknown-id 404 body is uniform across routes (DELETE included)', async () => {
  await withServer(async ({ origin }) => {
    const view = await fetch(`${origin}/api/conversations/nope`);
    const del = await fetch(`${origin}/api/conversations/nope`, { method: 'DELETE' });
    assert.equal(del.status, 404);
    assert.deepEqual(await del.json(), await view.json()); // same { error: 'not found' } shape
  });
});

test('every response carries a Content-Security-Policy', async () => {
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}/api/conversations`);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  });
});

test('SSE streams without auth', async () => {
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}/api/conversations/c1/events`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /connected|event: message/);
    await reader.cancel();
  });
});

test('SSE for an unknown conversation returns the uniform 404 body', async () => {
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}/api/conversations/nope/events`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not found' });
  });
});

test('createServer refuses a non-loopback bind host', () => {
  assert.throws(() => createServer({ app: fakeApp(), logger: new RedactingLogger({ write() {} }), bindHost: '0.0.0.0', port: 8080 }));
});

test('serveStatic serves files, refuses path traversal, and 404s the unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rt-static-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>ok</title>');
  await writeFile(join(dir, 'app.ts'), "import { ok } from './client.ts';\nconst label: string = ok;\n");
  await writeFile(join(dir, 'client.ts'), "export const ok: string = 'ok';\n");
  const port = await freePort();
  const server = createServer({ app: fakeApp(), logger: new RedactingLogger({ write() {} }), bindHost: '127.0.0.1', port, staticDir: dir });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  try {
    const origin = `http://127.0.0.1:${port}`;
    const index = await fetch(`${origin}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /text\/html/);

    const appBody = await (await fetch(`${origin}/app.js`)).text();
    assert.match(appBody, /import \{ ok \} from '\.\/client\.ts'/);
    assert.doesNotMatch(appBody, /: string/);

    const clientTs = await fetch(`${origin}/client.ts`);
    assert.equal(clientTs.status, 200);
    assert.match(clientTs.headers.get('content-type') ?? '', /application\/javascript/);
    assert.match(await clientTs.text(), /export const ok/);

    const traversal = await fetch(`${origin}/..%2f..%2fpackage.json`);
    assert.equal(traversal.status, 404); // the '..' guard keeps reads inside staticDir

    const missing = await fetch(`${origin}/nope.css`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
