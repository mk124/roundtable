import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversation, eventStream, findByText, messageEvent, neverResponse, pendingResponse, renderApp, testView, tick, withFetch, withWindowTimeout } from './app-test-harness.ts';
import type { TestEvent, TestNode } from './app-test-harness.ts';

test('message refresh preserves an in-progress composer draft', async () => {
  const { browser, doc } = renderApp();
  let cursor = 1;

  await withFetch(async (input) => {
    assert.equal(String(input), '/api/conversations/c1');
    cursor += 1;
    return Response.json({
      cursor,
      readOnly: false,
      events: [messageEvent('new', `e${cursor}`)],
    });
  }, async () => {
    const textarea = doc.app.querySelector<HTMLTextAreaElement>('.composer__input')!;
    textarea.value = 'half typed';
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    textarea.oninput?.({} as InputEvent);
    textarea.onkeydown?.({
      altKey: true,
      key: 'Enter',
      preventDefault() {},
      shiftKey: false,
    } as KeyboardEvent);

    await browser.refresh();

    const refreshed = doc.app.querySelector<HTMLTextAreaElement>('.composer__input')!;
    assert.equal(refreshed.value, 'half typed\n');
    assert.equal(refreshed.selectionStart, 'half typed\n'.length);
    assert.equal(refreshed.selectionEnd, 'half typed\n'.length);
  });
});

test('message refresh keeps the composer textarea node stable', async () => {
  const { browser, doc } = renderApp();

  await withFetch(async () =>
    Response.json({
      cursor: 2,
      readOnly: false,
      events: [messageEvent('new', 'e2')],
    }), async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    textarea.value = 'ni';
    textarea.selectionStart = textarea.selectionEnd = 2;
    textarea.oninput?.();
    textarea.focus();

    await browser.refresh();

    const refreshed = doc.app.querySelector<TestNode>('.composer__input')!;
    assert.equal(refreshed, textarea);
    assert.equal(doc.activeElement, textarea);
    assert.equal(refreshed.value, 'ni');
    assert.equal(refreshed.selectionStart, 2);
    assert.equal(refreshed.selectionEnd, 2);
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /new/);
  });
});

test('message refresh updates read-only composer state without replacing the textarea', async () => {
  const { browser, doc } = renderApp();

  await withFetch(async () =>
    Response.json({
      cursor: 2,
      readOnly: true,
      events: [messageEvent('new', 'e2')],
    }), async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    const button = doc.app.querySelector<TestNode>('.composer__btn')!;

    await browser.refresh();

    assert.equal(doc.app.querySelector<TestNode>('.composer__input'), textarea);
    assert.match(doc.app.textContent, /Conversation storage limit reached/);
    assert.match(doc.app.textContent, /read-only/);
    assert.equal(textarea.disabled, true);
    assert.equal(button.disabled, true);
    assert.match(textarea.placeholder, /read-only/);
  });
});

test('message refresh preserves a manual scroll position away from the bottom', async () => {
  const { browser, doc } = renderApp();

  await withFetch(async () => Response.json(testView(2, [messageEvent('new while reading')])), async () => {
    const log = doc.app.querySelector<TestNode>('.chat__log')!;
    log.scrollHeight = 1000;
    log.clientHeight = 300;
    log.scrollTop = 200;

    await browser.refresh();

    assert.equal(doc.app.querySelector<TestNode>('.chat__log'), log);
    assert.equal(log.scrollTop, 200);
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /new while reading/);
  });
});

test('message refresh keeps a bottom-pinned log at the bottom', async () => {
  const { browser, doc } = renderApp();

  await withFetch(async () => Response.json(testView(2, [messageEvent('new at bottom')])), async () => {
    const log = doc.app.querySelector<TestNode>('.chat__log')!;
    log.scrollHeight = 1000;
    log.clientHeight = 300;
    log.scrollTop = 700;

    await browser.refresh();

    assert.equal(doc.app.querySelector<TestNode>('.chat__log'), log);
    assert.equal(log.scrollTop, 1000);
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /new at bottom/);
  });
});

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

test('message refresh does not replace focused header controls', async () => {
  const { browser, doc } = renderApp();

  await withFetch(async () => Response.json(testView(2, [messageEvent('new without nav rebuild')])), async () => {
    const copy = doc.app.querySelector<TestNode>('.chat__copy')!;
    copy.focus();

    await browser.refresh();

    assert.equal(doc.app.querySelector<TestNode>('.chat__copy'), copy);
    assert.equal(doc.activeElement, copy);
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /new without nav rebuild/);
  });
});

test('message refresh does not replace focused sidebar controls', async () => {
  const { browser, doc } = renderApp();

  await withFetch(async () => Response.json(testView(2, [messageEvent('new without sidebar rebuild')])), async () => {
    const nav = findByText(doc.app, 'Chat')!;
    nav.focus();

    await browser.refresh();

    assert.equal(findByText(doc.app, 'Chat'), nav);
    assert.equal(doc.activeElement, nav);
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /new without sidebar rebuild/);
  });
});

test('message refresh preserves focus inside unchanged transcript links', async () => {
  const linkedEvent: TestEvent = {
    id: 'linked',
    type: 'message',
    timestamp: 't',
    author: 'agent',
    content: [
      {
        type: 'paragraph',
        children: [{ type: 'link', href: 'https://example.test', children: [{ type: 'text', value: 'docs' }] }],
      },
    ],
  };
  const { browser, doc } = renderApp({ view: testView(1, [linkedEvent]) });

  await withFetch(async () => Response.json(testView(2, [linkedEvent, messageEvent('new after link')])), async () => {
    const link = doc.app.querySelector<TestNode>('a')!;
    link.focus();

    await browser.refresh();

    assert.equal(doc.app.querySelector<TestNode>('a'), link);
    assert.equal(doc.activeElement, link);
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /new after link/);
  });
});

test('stale refresh responses do not replace the active conversation view', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
  });
  const c1 = pendingResponse();

  await withFetch(async (input) => {
    if (String(input) === '/api/conversations/c1') return c1.response;
    return Response.json({
      cursor: 2,
      readOnly: false,
      events: [messageEvent('c2 live', 'c2e')],
    });
  }, async () => {
    const staleRefresh = browser.refresh();
    browser.conversationId = 'c2';
    browser.view = testView(1, [messageEvent('c2 current', 'c2a')]);
    browser.render();

    c1.resolve(
      Response.json({
        cursor: 2,
        readOnly: false,
        events: [messageEvent('c1 stale', 'c1e')],
      }),
    );
    await staleRefresh;

    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c2 current/);
    assert.doesNotMatch(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c1 stale/);
  });
});

test('stale open responses do not replace the active conversation view', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two'), conversation('c3', 'Three')],
    view: testView(1, [messageEvent('c1 current')]),
  });
  const c2Open = pendingResponse();
  let c2EventRequests = 0;
  let c3EventRequests = 0;

  await withFetch(async (input) => {
    const path = String(input);
    if (path === '/api/conversations/c2') return c2Open.response;
    if (path === '/api/conversations/c3') return Response.json(testView(3, [messageEvent('c3 current')]));
    if (path === '/api/conversations/c2/events') {
      c2EventRequests++;
      return eventStream().response;
    }
    if (path === '/api/conversations/c3/events') {
      c3EventRequests++;
      return eventStream().response;
    }
    return Response.json(testView());
  }, async () => {
    const staleOpen = browser.openConversation('c2');
    await browser.openConversation('c3');

    c2Open.resolve(Response.json(testView(5, [messageEvent('c2 stale success')])));
    await staleOpen;

    assert.equal(browser.conversationId, 'c3');
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c3 current/);
    assert.doesNotMatch(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c2 stale success/);
    assert.equal(c2EventRequests, 0);
    assert.equal(c3EventRequests, 1);
  });
});

test('opening another conversation accepts a lower cursor than the previous view', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(10, [messageEvent('c1 old')]),
  });

  await withFetch(async (input) => {
    if (String(input) === '/api/conversations/c2') return Response.json(testView(1, [messageEvent('c2 lower')]));
    if (String(input).endsWith('/events')) return neverResponse();
    return Response.json(testView());
  }, async () => {
    await browser.openConversation('c2');

    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c2 lower/);
    assert.doesNotMatch(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c1 old/);
  });
});

test('opening another conversation removes the old composer while the view loads', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(1, [messageEvent('c1 old')]),
  });
  const open = pendingResponse();
  let sayRequests = 0;

  await withFetch(async (input) => {
    const path = String(input);
    if (path === '/api/conversations/c2') return open.response;
    if (path.endsWith('/say')) {
      sayRequests++;
      return Response.json({ ok: true });
    }
    if (path.endsWith('/events')) return neverResponse();
    return Response.json(testView());
  }, async () => {
    const oldStream = new AbortController();
    browser.sseAbort = oldStream;
    const oldTextarea = doc.app.querySelector<TestNode>('.composer__input')!;
    oldTextarea.value = 'old draft';
    oldTextarea.oninput?.();

    const opening = browser.openConversation('c2');
    assert.equal(oldStream.signal.aborted, true);
    assert.equal(doc.app.querySelector<TestNode>('.composer__input'), null);
    assert.match(doc.app.textContent, /Loading conversation/);
    assert.doesNotMatch(doc.app.textContent, /c1 old/);

    await browser.onSend(oldTextarea as unknown as HTMLTextAreaElement);
    assert.equal(sayRequests, 0);

    open.resolve(Response.json(testView(1, [messageEvent('c2 current')])));
    await opening;
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c2 current/);
  });
});

test('opening another conversation retries transient view failures', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(1, [messageEvent('c1 old')]),
  });

  await withWindowTimeout(async (flush) => {
    const c2View = pendingResponse();
    let c2Views = 0;
    let eventRequests = 0;

    await withFetch(async (input) => {
      const path = String(input);
      if (path === '/api/conversations/c2') {
        c2Views++;
        if (c2Views === 1) throw new Error('server restarting');
        return c2View.response;
      }
      if (path.endsWith('/events')) {
        eventRequests++;
        return eventStream().response;
      }
      return Response.json(testView());
    }, async () => {
      await browser.openConversation('c2');

      assert.match(doc.app.textContent, /Reconnecting/);
      assert.equal(eventRequests, 0);

      const retried = tick();
      flush();
      c2View.resolve(Response.json(testView(2, [messageEvent('c2 recovered')])));
      await retried;
      await tick();

      assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c2 recovered/);
      assert.equal(eventRequests, 1);
      assert.doesNotMatch(doc.app.textContent, /Reconnecting/);
    });
  });
});

test('opening another conversation retries retryable view HTTP failures', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(1, [messageEvent('c1 old')]),
  });

  await withWindowTimeout(async (flush) => {
    const c2View = pendingResponse();
    let c2Views = 0;
    let eventRequests = 0;

    await withFetch(async (input) => {
      const path = String(input);
      if (path === '/api/conversations/c2') {
        c2Views++;
        if (c2Views === 1) return new Response('server unavailable', { status: 503 });
        return c2View.response;
      }
      if (path.endsWith('/events')) {
        eventRequests++;
        return eventStream().response;
      }
      return Response.json(testView());
    }, async () => {
      await browser.openConversation('c2');

      assert.match(doc.app.textContent, /Reconnecting/);
      assert.equal(eventRequests, 0);

      const retried = tick();
      flush();
      c2View.resolve(Response.json(testView(2, [messageEvent('c2 recovered')])));
      await retried;
      await tick();

      assert.equal(browser.conversationId, 'c2');
      assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c2 recovered/);
      assert.equal(eventRequests, 1);
      assert.doesNotMatch(doc.app.textContent, /Reconnecting/);
    });
  });
});

test('stale open retry timers do not affect the current conversation', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two'), conversation('c3', 'Three')],
    view: testView(1, [messageEvent('c1 old')]),
  });

  await withWindowTimeout(async (flush) => {
    let c2Views = 0;
    let c2EventRequests = 0;
    let c3EventRequests = 0;

    await withFetch(async (input) => {
      const path = String(input);
      if (path === '/api/conversations/c2') {
        c2Views++;
        return new Response('server unavailable', { status: 503 });
      }
      if (path === '/api/conversations/c3') return Response.json(testView(3, [messageEvent('c3 current')]));
      if (path === '/api/conversations/c2/events') {
        c2EventRequests++;
        return eventStream().response;
      }
      if (path === '/api/conversations/c3/events') {
        c3EventRequests++;
        return eventStream().response;
      }
      return Response.json(testView());
    }, async () => {
      await browser.openConversation('c2');
      assert.match(doc.app.textContent, /Reconnecting/);

      await browser.openConversation('c3');
      assert.equal(browser.conversationId, 'c3');
      assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c3 current/);

      flush();
      await tick();

      assert.equal(browser.conversationId, 'c3');
      assert.equal(c2Views, 1);
      assert.equal(c2EventRequests, 0);
      assert.equal(c3EventRequests, 1);
      assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c3 current/);
    });
  });
});

test('reopening the active conversation preserves the focused composer draft', async () => {
  const { browser, doc } = renderApp();

  await withFetch(async (input) => {
    if (String(input) === '/api/conversations/c1') return Response.json(testView(2, [messageEvent('same chat')]));
    if (String(input).endsWith('/events')) return neverResponse();
    return Response.json(testView());
  }, async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    textarea.value = 'draft';
    textarea.selectionStart = textarea.selectionEnd = 3;
    textarea.oninput?.();
    textarea.focus();

    await browser.openConversation('c1');

    const activeTextarea = doc.app.querySelector<TestNode>('.composer__input')!;
    assert.equal(activeTextarea, textarea);
    assert.equal(doc.activeElement, textarea);
    assert.equal(activeTextarea.value, 'draft');
    assert.equal(activeTextarea.selectionStart, 3);
    assert.equal(activeTextarea.selectionEnd, 3);
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /same chat/);
  });
});

test('older active-conversation refresh responses do not override a newer in-place refresh', async () => {
  const { browser, doc } = renderApp();
  const olderResponse = pendingResponse();
  const newerResponse = pendingResponse();
  const views = [olderResponse.response, newerResponse.response];

  await withFetch(async (input) => {
    if (String(input) === '/api/conversations/c1') return views.shift() ?? Response.json(testView());
    if (String(input).endsWith('/events')) return neverResponse();
    return Response.json(testView());
  }, async () => {
    const older = browser.refresh();
    const newer = browser.openConversation('c1');

    newerResponse.resolve(Response.json(testView(5, [messageEvent('newer in-place refresh')])));
    await newer;

    olderResponse.resolve(Response.json(testView(2, [messageEvent('older refresh')])));
    await older;

    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /newer in-place refresh/);
    assert.doesNotMatch(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /older refresh/);
  });
});

test('stale same-id refresh responses from a previous visit are ignored', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(1, [messageEvent('c1 old visit')]),
  });
  const oldC1Refresh = pendingResponse();
  let c1Views = 0;

  await withFetch(async (input) => {
    const path = String(input);
    if (path === '/api/conversations/c1') {
      c1Views++;
      if (c1Views === 1) return oldC1Refresh.response;
      return Response.json(testView(3, [messageEvent('c1 reopened')]));
    }
    if (path === '/api/conversations/c2') return Response.json(testView(2, [messageEvent('c2 away')]));
    if (path.endsWith('/events')) return neverResponse();
    return Response.json(testView());
  }, async () => {
    const staleRefresh = browser.refresh();
    await browser.openConversation('c2');
    await browser.openConversation('c1');

    oldC1Refresh.resolve(Response.json(testView(9, [messageEvent('c1 stale previous visit')])));
    await staleRefresh;

    assert.equal(browser.conversationId, 'c1');
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c1 reopened/);
    assert.doesNotMatch(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /c1 stale previous visit/);
  });
});

test('out-of-order refresh responses do not roll the transcript back', async () => {
  const { browser, doc } = renderApp();
  const olderResponse = pendingResponse();
  const newerResponse = pendingResponse();
  const views = [olderResponse.response, newerResponse.response];

  await withFetch(async () => views.shift() ?? Response.json(testView()), async () => {
    const older = browser.refresh();
    const newer = browser.refresh();

    newerResponse.resolve(
      Response.json({
        cursor: 3,
        readOnly: false,
        events: [messageEvent('newer', 'e3')],
      }),
    );
    await newer;

    olderResponse.resolve(
      Response.json({
        cursor: 2,
        readOnly: false,
        events: [messageEvent('older', 'e2')],
      }),
    );
    await older;

    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /newer/);
    assert.doesNotMatch(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /older/);
  });
});

test('later refresh responses with lower cursors do not roll the transcript back', async () => {
  const { browser, doc } = renderApp();
  const firstResponse = pendingResponse();
  const secondResponse = pendingResponse();
  const views = [firstResponse.response, secondResponse.response];

  await withFetch(async () => views.shift() ?? Response.json(testView()), async () => {
    const first = browser.refresh();
    const second = browser.refresh();

    firstResponse.resolve(Response.json(testView(3, [messageEvent('higher first')])));
    await first;

    secondResponse.resolve(Response.json(testView(2, [messageEvent('lower second')])));
    await second;

    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /higher first/);
    assert.doesNotMatch(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /lower second/);
  });
});

test('older equal-cursor refresh responses do not re-enable read-only conversations', async () => {
  const { browser, doc } = renderApp();
  const olderResponse = pendingResponse();
  const newerResponse = pendingResponse();
  const views = [olderResponse.response, newerResponse.response];

  await withFetch(async () => views.shift() ?? Response.json(testView()), async () => {
    const older = browser.refresh();
    const newer = browser.refresh();

    newerResponse.resolve(Response.json(testView(2, [messageEvent('same cursor')], true)));
    await newer;
    assert.equal(doc.app.querySelector<TestNode>('.composer__input')!.disabled, true);

    olderResponse.resolve(Response.json(testView(2, [messageEvent('stale writable')], false)));
    await older;

    assert.equal(doc.app.querySelector<TestNode>('.composer__input')!.disabled, true);
    assert.match(doc.app.textContent, /Conversation storage limit reached/);
    assert.doesNotMatch(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /stale writable/);
  });
});

test('older equal-cursor refresh responses can still apply a read-only flip', async () => {
  const { browser, doc } = renderApp();
  const olderResponse = pendingResponse();
  const newerResponse = pendingResponse();
  const views = [olderResponse.response, newerResponse.response];

  await withFetch(async () => views.shift() ?? Response.json(testView()), async () => {
    const older = browser.refresh();
    const newer = browser.refresh();

    newerResponse.resolve(Response.json(testView(2, [messageEvent('newer writable')], false)));
    await newer;
    assert.equal(doc.app.querySelector<TestNode>('.composer__input')!.disabled, false);

    olderResponse.resolve(Response.json(testView(2, [messageEvent('older read-only')], true)));
    await older;

    assert.equal(doc.app.querySelector<TestNode>('.composer__input')!.disabled, true);
    assert.match(doc.app.textContent, /Conversation storage limit reached/);
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /newer writable/);
    assert.doesNotMatch(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /older read-only/);
  });
});

test('same-cursor writable refreshes cannot override an active read-only view', async () => {
  const { browser, doc } = renderApp({ view: testView(2, [messageEvent('read-only current')], true) });

  await withFetch(async () => Response.json(testView(2, [messageEvent('writable later')], false)), async () => {
    await browser.refresh();

    assert.equal(doc.app.querySelector<TestNode>('.composer__input')!.disabled, true);
    assert.match(doc.app.textContent, /Conversation storage limit reached/);
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /read-only current/);
    assert.doesNotMatch(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /writable later/);
  });
});

test('stale missing refresh responses do not clear a newer active view', async () => {
  const { browser, doc } = renderApp();
  const olderResponse = pendingResponse();
  const newerResponse = pendingResponse();
  const views = [olderResponse.response, newerResponse.response];

  await withFetch(async () => views.shift() ?? Response.json(testView()), async () => {
    const older = browser.refresh();
    const newer = browser.refresh();

    newerResponse.resolve(Response.json(testView(2, [messageEvent('still here')])));
    await newer;

    olderResponse.resolve(new Response(JSON.stringify({ error: 'missing' }), { status: 404 }));
    await older;

    assert.equal(browser.conversationId, 'c1');
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /still here/);
    assert.doesNotMatch(doc.live.textContent, /no longer exists/);
  });
});

test('retryable view HTTP failures do not clear the active conversation', async () => {
  const { browser, doc } = renderApp({ view: testView(1, [messageEvent('still here')]) });

  await withFetch(async () => new Response('temporary failure', { status: 500 }), async () => {
    await browser.refresh();

    assert.equal(browser.conversationId, 'c1');
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /still here/);
    assert.doesNotMatch(doc.live.textContent, /Conversation no longer exists/);
  });
});

test('refresh sequence tracking stays monotonic after an older higher-cursor response applies', async () => {
  const { browser, doc } = renderApp();
  const firstResponse = pendingResponse();
  const secondResponse = pendingResponse();
  const thirdResponse = pendingResponse();
  const views = [firstResponse.response, secondResponse.response, thirdResponse.response];

  await withFetch(async () => views.shift() ?? Response.json(testView()), async () => {
    const first = browser.refresh();
    const second = browser.refresh();
    const third = browser.refresh();

    thirdResponse.resolve(Response.json(testView(3, [messageEvent('third applied')])));
    await third;

    firstResponse.resolve(Response.json(testView(4, [messageEvent('first higher cursor')])));
    await first;

    secondResponse.resolve(new Response(JSON.stringify({ error: 'missing' }), { status: 404 }));
    await second;

    assert.equal(browser.conversationId, 'c1');
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /first higher cursor/);
    assert.doesNotMatch(doc.live.textContent, /Conversation no longer exists/);
  });
});

test('fresh missing refresh responses clear the active conversation', async () => {
  const { browser, doc } = renderApp();

  await withFetch(async (input) => {
    if (String(input) === '/api/conversations') return Response.json({ conversations: [] });
    return new Response(JSON.stringify({ error: 'missing' }), { status: 404 });
  }, async () => {
    await browser.refresh();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assert.equal(browser.conversationId, null);
    assert.match(doc.live.textContent, /Conversation no longer exists/);
    assert.match(doc.app.textContent, /No conversation open/);
  });
});

test('fresh missing refresh removes stale chat before the list reload finishes', async () => {
  const { browser, doc } = renderApp({ view: testView(1, [messageEvent('stale chat')]) });

  await withFetch(async (input) => {
    const path = String(input);
    if (path === '/api/conversations/c1') return new Response(JSON.stringify({ error: 'missing' }), { status: 404 });
    if (path === '/api/conversations') return neverResponse();
    return Response.json(testView());
  }, async () => {
    await browser.refresh();

    assert.equal(browser.conversationId, null);
    assert.match(doc.live.textContent, /Conversation no longer exists/);
    assert.match(doc.app.textContent, /No conversation open/);
    assert.doesNotMatch(doc.app.textContent, /stale chat/);
    assert.equal(doc.app.querySelector<TestNode>('.composer__input'), null);
  });
});

test('stale post-missing list responses do not restore the missing row', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(1, [messageEvent('missing chat')]),
  });
  let listRequests = 0;

  await withFetch(async (input) => {
    const path = String(input);
    if (path === '/api/conversations/c1') return new Response(JSON.stringify({ error: 'missing' }), { status: 404 });
    if (path === '/api/conversations') {
      listRequests++;
      return Response.json({ conversations: [conversation('c1', 'One stale'), conversation('c2', 'Two refreshed')] });
    }
    return Response.json(testView());
  }, async () => {
    await browser.refresh();
    await tick();

    assert.equal(listRequests, 1);
    assert.equal(browser.conversationId, null);
    assert.match(doc.app.textContent, /Two refreshed/);
    assert.doesNotMatch(doc.app.textContent, /One stale/);
    assert.doesNotMatch(doc.app.textContent, /missing chat/);
  });
});

test('deleting the active conversation removes stale chat before the list reload finishes', async () => {
  const { browser, doc } = renderApp({ view: testView(1, [messageEvent('deleted chat')]) });
  const host = globalThis as unknown as Record<string, unknown>;
  const originalWindow = host.window;
  host.window = { confirm: () => true } as Pick<Window, 'confirm'>;

  try {
    await withFetch(async (input) => {
      const path = String(input);
      if (path === '/api/conversations/c1') return Response.json({ ok: true });
      if (path === '/api/conversations') return neverResponse();
      return Response.json(testView());
    }, async () => {
      void browser.deleteConversation(conversation());
      await tick();

      assert.equal(browser.conversationId, null);
      assert.match(doc.live.textContent, /Conversation deleted/);
      assert.match(doc.app.textContent, /No conversation open/);
      assert.doesNotMatch(doc.app.textContent, /deleted chat/);
      assert.doesNotMatch(doc.app.textContent, /Chat/);
      assert.equal(doc.app.querySelector<TestNode>('.composer__input'), null);
    });
  } finally {
    if (originalWindow !== undefined) host.window = originalWindow;
    else Reflect.deleteProperty(host, 'window');
  }
});

test('deleting another conversation removes its sidebar row and preserves the active draft', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(1, [messageEvent('active chat')]),
  });
  const host = globalThis as unknown as Record<string, unknown>;
  const originalWindow = host.window;
  host.window = { confirm: () => true } as Pick<Window, 'confirm'>;

  try {
    await withFetch(async (input) => {
      const path = String(input);
      if (path === '/api/conversations/c2') return Response.json({ ok: true });
      if (path === '/api/conversations') return neverResponse();
      return Response.json(testView());
    }, async () => {
      const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
      textarea.value = 'active draft';
      textarea.selectionStart = textarea.selectionEnd = 6;
      textarea.oninput?.();
      textarea.focus();

      await browser.deleteConversation(conversation('c2', 'Two'));

      assert.equal(browser.conversationId, 'c1');
      assert.doesNotMatch(doc.app.textContent, /Two/);
      assert.match(doc.app.textContent, /One/);
      assert.equal(doc.app.querySelector<TestNode>('.composer__input'), textarea);
      assert.equal(doc.activeElement, textarea);
      assert.equal(textarea.value, 'active draft');
      assert.equal(textarea.selectionStart, 6);
      assert.equal(textarea.selectionEnd, 6);
    });
  } finally {
    if (originalWindow !== undefined) host.window = originalWindow;
    else Reflect.deleteProperty(host, 'window');
  }
});

test('stale post-delete list responses do not restore the deleted row', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
    view: testView(1, [messageEvent('active chat')]),
  });
  let listRequests = 0;
  const host = globalThis as unknown as Record<string, unknown>;
  const originalWindow = host.window;
  host.window = { confirm: () => true } as Pick<Window, 'confirm'>;

  try {
    await withFetch(async (input) => {
      const path = String(input);
      if (path === '/api/conversations/c2') return Response.json({ ok: true });
      if (path === '/api/conversations') {
        listRequests++;
        return Response.json({ conversations: [conversation('c1', 'One refreshed'), conversation('c2', 'Two stale')] });
      }
      return Response.json(testView());
    }, async () => {
      await browser.deleteConversation(conversation('c2', 'Two'));
      await tick();

      assert.equal(listRequests, 1);
      assert.match(doc.app.textContent, /One refreshed/);
      assert.doesNotMatch(doc.app.textContent, /Two stale/);
      assert.doesNotMatch(doc.app.textContent, /Two/);
    });
  } finally {
    if (originalWindow !== undefined) host.window = originalWindow;
    else Reflect.deleteProperty(host, 'window');
  }
});

test('jump-to-bottom button appears away from the bottom and scrolls back down', () => {
  const { doc } = renderApp();

  const log = doc.app.querySelector<TestNode>('.chat__log')!;
  const button = doc.app.querySelector<TestNode>('.jump-bottom')!;
  log.scrollHeight = 1000;
  log.clientHeight = 300;
  log.scrollTop = 350;

  log.onscroll?.({} as Event);
  assert.equal(button.hidden, false);

  button.onclick?.();
  assert.equal(log.scrollTop, 1000);
  assert.equal(button.hidden, true);
});
