import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversation, findByText, messageEvent, pendingResponse, renderApp, testView, withFetch } from './app-test-harness.ts';
import type { TestNode } from './app-test-harness.ts';

test('conversation list refresh preserves same-conversation UI nodes and scroll position', async () => {
  const { browser, doc } = renderApp({ view: testView(1, [messageEvent('still reading')]) });

  await withFetch(async (input) => {
    assert.equal(String(input), '/api/conversations');
    return Response.json({ conversations: [conversation(), conversation('c2', 'Two')] });
  }, async () => {
    const oldLog = doc.app.querySelector<TestNode>('.chat__log')!;
    const oldSidebar = doc.app.querySelector<TestNode>('.sidebar__scroll')!;
    const oldTextarea = doc.app.querySelector<TestNode>('.composer__input')!;
    oldLog.scrollHeight = 1000;
    oldLog.clientHeight = 300;
    oldLog.scrollTop = 200;
    oldSidebar.scrollTop = 80;
    oldTextarea.value = 'draft';
    oldTextarea.selectionStart = oldTextarea.selectionEnd = 2;
    oldTextarea.oninput?.();
    oldTextarea.focus();

    await browser.loadConversations();

    const newLog = doc.app.querySelector<TestNode>('.chat__log')!;
    const newSidebar = doc.app.querySelector<TestNode>('.sidebar__scroll')!;
    assert.equal(newLog, oldLog);
    assert.equal(newSidebar, oldSidebar);
    assert.equal(doc.app.querySelector<TestNode>('.composer__input'), oldTextarea);
    assert.equal(doc.activeElement, oldTextarea);
    assert.equal(oldTextarea.value, 'draft');
    assert.equal(oldTextarea.selectionStart, 2);
    assert.equal(oldTextarea.selectionEnd, 2);
    assert.equal(newLog.scrollTop, 200);
    assert.equal(newSidebar.scrollTop, 80);
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /still reading/);
    assert.match(doc.app.textContent, /Two/);
  });
});

test('conversation list refresh restores focused sidebar controls', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(1, [messageEvent('still reading')]),
  });

  await withFetch(async (input) => {
    assert.equal(String(input), '/api/conversations');
    return Response.json({ conversations: [conversation('c1', 'One'), conversation('c2', 'Two updated')] });
  }, async () => {
    const nav = findByText(doc.app, 'Two')!;
    nav.focus();

    await browser.loadConversations();

    const updatedNav = findByText(doc.app, 'Two updated')!;
    assert.equal(doc.activeElement, updatedNav);
  });
});

test('conversation list failures keep the last good sidebar', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(1, [messageEvent('still reading')]),
  });

  await withFetch(async (input) => {
    assert.equal(String(input), '/api/conversations');
    return new Response('temporary failure', { status: 503 });
  }, async () => {
    const nav = findByText(doc.app, 'Two')!;
    nav.focus();

    await browser.loadConversations();

    assert.match(doc.app.textContent, /One/);
    assert.match(doc.app.textContent, /Two/);
    assert.equal(doc.activeElement, nav);
  });
});

test('malformed conversation list responses keep the last good sidebar', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
  });

  await withFetch(async (input) => {
    assert.equal(String(input), '/api/conversations');
    return Response.json(testView());
  }, async () => {
    await browser.loadConversations();

    assert.match(doc.app.textContent, /One/);
    assert.match(doc.app.textContent, /Two/);
  });
});

test('older conversation list responses do not replace newer sidebar state', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(1, [messageEvent('still reading')]),
  });
  const olderResponse = pendingResponse();
  const newerResponse = pendingResponse();
  const responses = [olderResponse.response, newerResponse.response];

  await withFetch(async (input) => {
    assert.equal(String(input), '/api/conversations');
    return responses.shift() ?? Response.json({ conversations: [conversation('c1', 'One')] });
  }, async () => {
    const older = browser.loadConversations();
    const newer = browser.loadConversations();

    newerResponse.resolve(Response.json({ conversations: [conversation('c1', 'One')] }));
    await newer;

    olderResponse.resolve(Response.json({ conversations: [conversation('c1', 'One'), conversation('c2', 'Two stale')] }));
    await older;

    assert.match(doc.app.textContent, /One/);
    assert.doesNotMatch(doc.app.textContent, /Two stale/);
  });
});
