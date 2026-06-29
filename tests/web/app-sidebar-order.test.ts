import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversation, eventStream, firstSidebarConversationId, messageEvent, neverResponse, pendingResponse, projectList, renderApp, testView, tick, withFetch } from './app-test-harness.ts';
import type { TestNode } from './app-test-harness.ts';

test('successful send refreshes the sidebar order after the conversation view', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c2', 'Two'), conversation('c1', 'One')],
  });
  const view = pendingResponse();
  const requests: string[] = [];

  await withFetch(async (input) => {
    const path = String(input);
    requests.push(path);
    if (path.endsWith('/say')) return Response.json({ ok: true });
    if (path === '/api/conversations/c1') return view.response;
    if (path === '/api/projects') return Response.json(projectList([conversation('c1', 'One'), conversation('c2', 'Two')]));
    return Response.json(testView());
  }, async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    assert.equal(firstSidebarConversationId(doc), 'c2');

    textarea.value = 'hello';
    textarea.oninput?.();
    const send = browser.onSend(textarea as unknown as HTMLTextAreaElement);
    await tick();
    assert.equal(requests.includes('/api/projects'), false);

    view.resolve(Response.json(testView(2, [messageEvent('sent')])));
    await send;
    assert.ok(requests.indexOf('/api/conversations/c1') < requests.indexOf('/api/projects'));
    assert.equal(firstSidebarConversationId(doc), 'c1');
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /sent/);
  });
});

test('live message refreshes the sidebar order after the conversation view', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c2', 'Two'), conversation('c1', 'One')],
  });
  const view = pendingResponse();
  const requests: string[] = [];
  const stream = eventStream();

  await withFetch(async (input) => {
    const path = String(input);
    requests.push(path);
    if (path === '/api/conversations/c1/events') return stream.response;
    if (path === '/api/conversations/c1') return view.response;
    if (path === '/api/projects') return Response.json(projectList([conversation('c1', 'One'), conversation('c2', 'Two')]));
    return Response.json(testView());
  }, async () => {
    assert.equal(firstSidebarConversationId(doc), 'c2');

    browser.connect('c1');
    await tick();
    stream.send('data: {"cursor":2}\n\n');
    await tick();
    assert.equal(requests.includes('/api/projects'), false);

    view.resolve(Response.json(testView(2, [messageEvent('live')])));
    await tick();
    await tick();
    assert.ok(requests.indexOf('/api/conversations/c1') < requests.indexOf('/api/projects'));
    assert.equal(firstSidebarConversationId(doc), 'c1');
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /live/);
  });
});

test('stale overlapping live refreshes do not replace newer sidebar order', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c2', 'Two'), conversation('c1', 'One')],
    view: testView(1, [messageEvent('old')]),
  });
  const olderView = pendingResponse();
  const newerView = pendingResponse();
  const views = [olderView.response, newerView.response];
  const stream = eventStream();
  let listRequests = 0;

  await withFetch(async (input) => {
    const path = String(input);
    if (path === '/api/conversations/c1/events') return stream.response;
    if (path === '/api/conversations/c1') return views.shift() ?? Response.json(testView());
    if (path === '/api/projects') {
      listRequests++;
      return Response.json(projectList(
        listRequests === 1
          ? [conversation('c1', 'One'), conversation('c2', 'Two')]
          : [conversation('c2', 'Two stale'), conversation('c1', 'One')],
      ));
    }
    return Response.json(testView());
  }, async () => {
    browser.connect('c1');
    await tick();
    stream.send('data: {"cursor":2}\n\n');
    await tick();
    stream.send('data: {"cursor":3}\n\n');
    await tick();

    newerView.resolve(Response.json(testView(3, [messageEvent('newer')])));
    await tick();
    await tick();
    assert.equal(listRequests, 1);
    assert.equal(firstSidebarConversationId(doc), 'c1');

    olderView.resolve(Response.json(testView(2, [messageEvent('older')])));
    await tick();
    await tick();

    assert.equal(listRequests, 1);
    assert.equal(firstSidebarConversationId(doc), 'c1');
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /newer/);
    assert.doesNotMatch(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /older/);
  });
});

test('stale same-id send refresh does not reload the sidebar after reopening', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(1, [messageEvent('old')]),
  });
  const oldRefresh = pendingResponse();
  let c1Views = 0;
  let listRequests = 0;

  await withFetch(async (input) => {
    const path = String(input);
    if (path.endsWith('/say')) return Response.json({ ok: true });
    if (path === '/api/conversations/c1') {
      c1Views++;
      if (c1Views === 1) return oldRefresh.response;
      return Response.json(testView(3, [messageEvent('reopened')]));
    }
    if (path === '/api/conversations/c2') return Response.json(testView(2, [messageEvent('away')]));
    if (path === '/api/projects') {
      listRequests++;
      return Response.json(projectList([conversation('c1', 'One'), conversation('c2', 'Two')]));
    }
    if (path.endsWith('/events')) return neverResponse();
    return Response.json(testView());
  }, async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    textarea.value = 'hello';
    textarea.oninput?.();

    const send = browser.onSend(textarea as unknown as HTMLTextAreaElement);
    await tick();
    await tick();
    assert.equal(c1Views, 1);

    await browser.openConversation('c2');
    await browser.openConversation('c1');

    oldRefresh.resolve(Response.json(testView(4, [messageEvent('stale sent')])));
    await send;
    await tick();

    assert.equal(listRequests, 0);
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /reopened/);
    assert.doesNotMatch(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /stale sent/);
  });
});

test('stale same-id sidebar response is ignored after reopening', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c2', 'Two'), conversation('c1', 'One')],
    view: testView(1, [messageEvent('old')]),
  });
  const staleList = pendingResponse();
  let c1Views = 0;
  let listRequests = 0;

  await withFetch(async (input) => {
    const path = String(input);
    if (path.endsWith('/say')) return Response.json({ ok: true });
    if (path === '/api/conversations/c1') {
      c1Views++;
      if (c1Views === 1) return Response.json(testView(2, [messageEvent('sent')]));
      return Response.json(testView(3, [messageEvent('reopened')]));
    }
    if (path === '/api/conversations/c2') return Response.json(testView(2, [messageEvent('away')]));
    if (path === '/api/projects') {
      listRequests++;
      return listRequests === 1
        ? staleList.response
        : Response.json(projectList([conversation('c1', 'One'), conversation('c2', 'Two')]));
    }
    if (path.endsWith('/events')) return neverResponse();
    return Response.json(testView());
  }, async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    assert.equal(firstSidebarConversationId(doc), 'c2');
    textarea.value = 'hello';
    textarea.oninput?.();

    const send = browser.onSend(textarea as unknown as HTMLTextAreaElement);
    await tick();
    await tick();
    assert.equal(listRequests, 1);

    await browser.openConversation('c2');
    await browser.openConversation('c1');

    staleList.resolve(Response.json(projectList([conversation('c1', 'One'), conversation('c2', 'Two')])));
    await send;
    await tick();

    assert.equal(listRequests, 1);
    assert.equal(firstSidebarConversationId(doc), 'c2');
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /reopened/);
  });
});
