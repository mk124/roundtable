import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamEvents } from '../../src/web/client.ts';
import { conversation, eventStream, messageEvent, pendingResponse, renderApp, testView, tick, withFetch, withWindowTimeout } from './app-test-harness.ts';
import type { TestNode } from './app-test-harness.ts';

test('old stream drops are ignored after another stream becomes current', () => {
  const { browser, doc } = renderApp();
  const oldStream = new AbortController();
  browser.sseAbort = new AbortController();

  browser.onSseDrop(oldStream);

  assert.doesNotMatch(doc.app.textContent, /Reconnecting/);
});

test('SSE drops schedule a reconnect only for the current stream', async () => {
  const { browser, doc } = renderApp();

  await withWindowTimeout(async (flush) => {
    const currentStream = new AbortController();
    const reconnected = eventStream();
    let eventRequests = 0;

    await withFetch(async (input) => {
      if (String(input).endsWith('/events')) {
        eventRequests++;
        return reconnected.response;
      }
      return Response.json(testView());
    }, async () => {
      browser.sseAbort = currentStream;
      browser.onSseDrop(currentStream);

      assert.match(doc.app.textContent, /Reconnecting/);
      assert.equal(eventRequests, 0);

      flush();
      await tick();

      assert.equal(eventRequests, 1);
      assert.doesNotMatch(doc.app.textContent, /Reconnecting/);
    });
  });
});

test('stale SSE drop retries are skipped after the current stream changes', async () => {
  const { browser } = renderApp();

  await withWindowTimeout(async (flush) => {
    const staleStream = new AbortController();
    let eventRequests = 0;

    await withFetch(async (input) => {
      if (String(input).endsWith('/events')) eventRequests++;
      return eventStream().response;
    }, async () => {
      browser.sseAbort = staleStream;
      browser.onSseDrop(staleStream);
      browser.sseAbort = new AbortController();

      flush();
      await tick();

      assert.equal(eventRequests, 0);
    });
  });
});

test('successful SSE reconnect clears the reconnecting banner', async () => {
  const { browser, doc } = renderApp();
  const stream = eventStream();

  await withFetch(async (input) => {
    if (String(input).endsWith('/events')) return stream.response;
    return Response.json(testView());
  }, async () => {
    browser.sse = 'reconnecting';
    browser.render();
    assert.match(doc.app.textContent, /Reconnecting/);

    browser.connect('c1');
    await tick();

    assert.doesNotMatch(doc.app.textContent, /Reconnecting/);
  });
});

test('stale SSE message and activity frames are ignored after a conversation switch', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(1, [messageEvent('c1 current')]),
  });
  const c1Stream = eventStream();
  const c2Open = pendingResponse();
  let c2ViewRequests = 0;

  await withFetch(async (input) => {
    const path = String(input);
    if (path === '/api/conversations/c2') {
      c2ViewRequests++;
      return c2Open.response;
    }
    if (path === '/api/conversations/c1/events') return c1Stream.response;
    if (path.endsWith('/events')) return eventStream().response;
    return Response.json(testView());
  }, async () => {
    browser.connect('c1');
    await tick();

    const opening = browser.openConversation('c2');
    c1Stream.send('event: activity\ndata: {"active":[{"author":"old","state":"typing","since":"2026-01-01T00:00:00.000Z"}]}\n\n');
    c1Stream.send('event: message\ndata: {}\n\n');
    await tick();

    assert.equal(c2ViewRequests, 1);
    assert.doesNotMatch(doc.app.textContent, /old/);

    c2Open.resolve(Response.json(testView(2, [messageEvent('c2 current')])));
    await opening;

    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c2 current/);
    assert.doesNotMatch(doc.app.textContent, /old/);
  });
});

test('stale SSE open is ignored after a conversation switch', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(1, [messageEvent('c1 current')]),
  });
  const c1Events = pendingResponse();

  await withFetch(async (input) => {
    const path = String(input);
    if (path === '/api/conversations/c1/events') return c1Events.response;
    if (path === '/api/conversations/c2') return Response.json(testView(2, [messageEvent('c2 current')]));
    if (path === '/api/conversations/c2/events') return eventStream().response;
    return Response.json(testView());
  }, async () => {
    browser.connect('c1');
    const oldController = browser.sseAbort;

    await browser.openConversation('c2');
    const currentController = browser.sseAbort;
    c1Events.resolve(eventStream().response);
    await tick();

    assert.notEqual(currentController, oldController);
    assert.equal(browser.sseAbort, currentController);
    assert.equal(browser.conversationId, 'c2');
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c2 current/);
  });
});

test('stale SSE 404 is ignored after a conversation switch', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(1, [messageEvent('c1 current')]),
  });
  const c1Events = pendingResponse();

  await withFetch(async (input) => {
    const path = String(input);
    if (path === '/api/conversations/c1/events') return c1Events.response;
    if (path === '/api/conversations/c2') return Response.json(testView(2, [messageEvent('c2 current')]));
    if (path === '/api/conversations/c2/events') return eventStream().response;
    return Response.json(testView());
  }, async () => {
    browser.connect('c1');

    await browser.openConversation('c2');
    const currentController = browser.sseAbort;
    c1Events.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    await tick();

    assert.equal(browser.sseAbort, currentController);
    assert.equal(browser.conversationId, 'c2');
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c2 current/);
    assert.doesNotMatch(doc.live.textContent, /no longer exists/);
  });
});

test('active conversation refresh keeps the current SSE stream', async () => {
  const { browser, doc } = renderApp({ view: testView(1, [messageEvent('c1 current')]) });
  let viewRequests = 0;
  let eventRequests = 0;

  await withFetch(async (input) => {
    const path = String(input);
    if (path === '/api/conversations/c1') {
      viewRequests++;
      return Response.json(testView(2, [messageEvent('refreshed same')]));
    }
    if (path === '/api/conversations/c1/events') {
      eventRequests++;
      return eventStream().response;
    }
    return Response.json(testView());
  }, async () => {
    browser.connect('c1');
    await tick();
    const currentController = browser.sseAbort;

    await browser.openConversation('c1');
    assert.equal(viewRequests, 1);
    assert.equal(eventRequests, 1);
    assert.equal(browser.sseAbort, currentController);
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /refreshed same/);
  });
});

test('repeated active conversation opens do not create duplicate streams', async () => {
  const { browser } = renderApp();
  let eventRequests = 0;

  await withFetch(async (input) => {
    const path = String(input);
    if (path === '/api/conversations/c1') return Response.json(testView(2, [messageEvent('refreshed')]));
    if (path.endsWith('/events')) {
      eventRequests++;
      return eventStream().response;
    }
    return Response.json(testView());
  }, async () => {
    browser.connect('c1');
    await tick();
    const currentController = browser.sseAbort;
    assert.equal(eventRequests, 1);

    await browser.openConversation('c1');
    await browser.openConversation('c1');

    assert.equal(eventRequests, 1);
    assert.equal(browser.sseAbort, currentController);
  });
});

test('streamEvents treats a 404 stream as a missing conversation', async () => {
  const seen = { missing: 0, drop: 0 };

  await withFetch(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }), async () => {
    await streamEvents('c1', 0, new AbortController().signal, {
      onMessage() {},
      onActivity() {},
      onMissing() {
        seen.missing++;
      },
      onDrop() {
        seen.drop++;
      },
    });
  });

  assert.deepEqual(seen, { missing: 1, drop: 0 });
});
