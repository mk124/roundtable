import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversation, messageEvent, neverResponse, pendingResponse, projectList, renderApp, testView, withFetch } from './app-test-harness.ts';
import type { TestNode } from './app-test-harness.ts';

test('successful send clears the stable composer textarea', async () => {
  const { browser, doc } = renderApp();

  await withFetch(async (input) => {
    if (String(input).endsWith('/say')) return Response.json({ ok: true });
    return Response.json({ cursor: 2, readOnly: false, events: [] });
  }, async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    textarea.value = 'hello';
    textarea.oninput?.();

    await browser.onSend(textarea as unknown as HTMLTextAreaElement);

    assert.equal(doc.app.querySelector<TestNode>('.composer__input'), textarea);
    assert.equal(textarea.value, '');
  });
});

test('successful send preserves a newer draft typed before the response returns', async () => {
  const { browser, doc } = renderApp();
  const say = pendingResponse();

  await withFetch(async (input) => {
    if (String(input).endsWith('/say')) return say.response;
    return Response.json({ cursor: 2, readOnly: false, events: [] });
  }, async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    textarea.value = 'first';
    textarea.oninput?.();

    const send = browser.onSend(textarea as unknown as HTMLTextAreaElement);
    textarea.value = 'second';
    textarea.selectionStart = textarea.selectionEnd = 3;
    textarea.oninput?.();
    textarea.focus();
    say.resolve(Response.json({ ok: true }));
    await send;

    assert.equal(doc.app.querySelector<TestNode>('.composer__input'), textarea);
    assert.equal(doc.activeElement, textarea);
    assert.equal(textarea.value, 'second');
    assert.equal(textarea.selectionStart, 3);
    assert.equal(textarea.selectionEnd, 3);
  });
});

test('successful send preserves a newer same-text draft typed before the response returns', async () => {
  const { browser, doc } = renderApp();
  const say = pendingResponse();

  await withFetch(async (input) => {
    if (String(input).endsWith('/say')) return say.response;
    return Response.json(testView(2));
  }, async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    textarea.value = 'repeat';
    textarea.oninput?.();

    const send = browser.onSend(textarea as unknown as HTMLTextAreaElement);
    textarea.value = 'repeat';
    textarea.oninput?.();
    say.resolve(Response.json({ ok: true }));
    await send;

    assert.equal(doc.app.querySelector<TestNode>('.composer__input'), textarea);
    assert.equal(textarea.value, 'repeat');
  });
});

test('successful send preserves textarea changes not yet reflected by input events', async () => {
  const { browser, doc } = renderApp();
  const say = pendingResponse();

  await withFetch(async (input) => {
    if (String(input).endsWith('/say')) return say.response;
    return Response.json(testView(2));
  }, async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    textarea.value = 'first';
    textarea.oninput?.();

    const send = browser.onSend(textarea as unknown as HTMLTextAreaElement);
    textarea.value = 'composition text';
    say.resolve(Response.json({ ok: true }));
    await send;

    assert.equal(doc.app.querySelector<TestNode>('.composer__input'), textarea);
    assert.equal(textarea.value, 'composition text');
  });
});

test('pending send disables the button and ignores duplicate sends', async () => {
  const { browser, doc } = renderApp();
  const say = pendingResponse();
  let sayRequests = 0;

  await withFetch(async (input) => {
    if (String(input).endsWith('/say')) {
      sayRequests++;
      return say.response;
    }
    return Response.json(testView(2));
  }, async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    const button = doc.app.querySelector<TestNode>('.composer__btn')!;
    textarea.value = 'hello';
    textarea.oninput?.();

    const first = browser.onSend(textarea as unknown as HTMLTextAreaElement);
    const second = browser.onSend(textarea as unknown as HTMLTextAreaElement);

    assert.equal(sayRequests, 1);
    assert.equal(button.disabled, true);

    say.resolve(Response.json({ ok: true }));
    await Promise.all([first, second]);

    assert.equal(sayRequests, 1);
    assert.equal(button.disabled, false);
    assert.equal(textarea.value, '');
  });
});

test('pending send survives a same-conversation sidebar refresh', async () => {
  const { browser, doc } = renderApp();
  const say = pendingResponse();
  let sayRequests = 0;

  await withFetch(async (input) => {
    const path = String(input);
    if (path.endsWith('/say')) {
      sayRequests++;
      return say.response;
    }
    if (path === '/api/projects') return Response.json(projectList([conversation()]));
    if (path === '/api/conversations/c1') return Response.json(testView(2));
    return Response.json(testView());
  }, async () => {
    const oldTextarea = doc.app.querySelector<TestNode>('.composer__input')!;
    oldTextarea.value = 'hello';
    oldTextarea.oninput?.();

    const send = browser.onSend(oldTextarea as unknown as HTMLTextAreaElement);
    await browser.loadProjects();

    const newTextarea = doc.app.querySelector<TestNode>('.composer__input')!;
    const newButton = doc.app.querySelector<TestNode>('.composer__btn')!;
    assert.equal(newTextarea, oldTextarea);
    assert.equal(newTextarea.value, 'hello');
    assert.equal(newButton.disabled, true);

    await browser.onSend(newTextarea as unknown as HTMLTextAreaElement);
    assert.equal(sayRequests, 1);

    say.resolve(Response.json({ ok: true }));
    await send;

    assert.equal(newTextarea.value, '');
    assert.equal(newButton.disabled, false);
    assert.equal(sayRequests, 1);
  });
});

test('conversation reopen after switching away does not inherit an old pending send lock', async () => {
  const { browser, doc } = renderApp();
  const firstSay = pendingResponse();
  let sayRequests = 0;
  let viewRequests = 0;

  await withFetch(async (input) => {
    const path = String(input);
    if (path.endsWith('/say')) {
      sayRequests++;
      return sayRequests === 1 ? firstSay.response : Response.json({ ok: true });
    }
    if (path === '/api/conversations/c2') return Response.json(testView(2, [messageEvent('away')]));
    if (path === '/api/conversations/c1') {
      viewRequests++;
      if (viewRequests === 1) return Response.json(testView(3, [messageEvent('reopened')]));
      return Response.json(testView(3, [messageEvent('reopened'), messageEvent('second sent')]));
    }
    if (path.endsWith('/events')) return neverResponse();
    return Response.json(testView());
  }, async () => {
    const oldTextarea = doc.app.querySelector<TestNode>('.composer__input')!;
    oldTextarea.value = 'first';
    oldTextarea.oninput?.();

    void browser.onSend(oldTextarea as unknown as HTMLTextAreaElement);
    assert.equal(sayRequests, 1);

    await browser.openConversation('c2');
    await browser.openConversation('c1');

    const activeTextarea = doc.app.querySelector<TestNode>('.composer__input')!;
    activeTextarea.value = 'second';
    activeTextarea.oninput?.();
    await browser.onSend(activeTextarea as unknown as HTMLTextAreaElement);

    assert.equal(sayRequests, 2);
    assert.equal(activeTextarea.value, '');
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /second sent/);
  });
});

test('send completion from an old composer does not update the active chat', async () => {
  const { browser, doc } = renderApp({
    conversations: [conversation('c1', 'One'), conversation('c2', 'Two')],
  });
  const say = pendingResponse();

  await withFetch(async (input) => {
    if (String(input).endsWith('/say')) return say.response;
    if (String(input) === '/api/conversations/c2') return Response.json(testView(1, [messageEvent('c2 current')]));
    if (String(input).endsWith('/events')) return neverResponse();
    return Response.json(testView());
  }, async () => {
    const oldTextarea = doc.app.querySelector<TestNode>('.composer__input')!;
    oldTextarea.value = 'first';
    oldTextarea.oninput?.();

    const send = browser.onSend(oldTextarea as unknown as HTMLTextAreaElement);
    await browser.openConversation('c2');
    const activeTextarea = doc.app.querySelector<TestNode>('.composer__input')!;
    activeTextarea.value = 'second';
    activeTextarea.oninput?.();

    say.resolve(Response.json({ ok: true }));
    await send;

    assert.equal(doc.app.querySelector<TestNode>('.composer__input'), activeTextarea);
    assert.equal(activeTextarea.value, 'second');
    assert.doesNotMatch(doc.app.textContent, /Message rejected/);
  });
});

test('send completion from before switching away and back is ignored', async () => {
  const { browser, doc } = renderApp();
  const say = pendingResponse();
  let c1Views = 0;

  await withFetch(async (input) => {
    const path = String(input);
    if (path.endsWith('/say')) return say.response;
    if (path === '/api/conversations/c2') return Response.json(testView(2, [messageEvent('away')]));
    if (path === '/api/conversations/c1') {
      c1Views++;
      return Response.json(testView(3, [messageEvent('reopened')]));
    }
    if (path.endsWith('/events')) return neverResponse();
    return Response.json(testView());
  }, async () => {
    const oldTextarea = doc.app.querySelector<TestNode>('.composer__input')!;
    oldTextarea.value = 'first';
    oldTextarea.oninput?.();

    const send = browser.onSend(oldTextarea as unknown as HTMLTextAreaElement);
    await browser.openConversation('c2');
    await browser.openConversation('c1');
    const activeTextarea = doc.app.querySelector<TestNode>('.composer__input')!;
    activeTextarea.value = 'new draft';
    activeTextarea.oninput?.();

    say.resolve(Response.json({ ok: true }));
    await send;

    assert.equal(c1Views, 1);
    assert.notEqual(activeTextarea, oldTextarea);
    assert.equal(activeTextarea.value, 'new draft');
    assert.match(doc.app.querySelector<TestNode>('.chat__messages')!.textContent, /reopened/);
    assert.doesNotMatch(doc.app.textContent, /Message rejected/);
  });
});

test('network send failures keep the composer and show an error', async () => {
  const { browser, doc } = renderApp();

  await withFetch(async (input) => {
    if (String(input).endsWith('/say')) throw new Error('offline');
    return Response.json(testView());
  }, async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    const button = doc.app.querySelector<TestNode>('.composer__btn')!;
    textarea.value = 'hello';
    textarea.oninput?.();

    await browser.onSend(textarea as unknown as HTMLTextAreaElement);

    assert.equal(doc.app.querySelector<TestNode>('.composer__input'), textarea);
    assert.equal(textarea.value, 'hello');
    assert.equal(button.disabled, false);
    assert.match(doc.app.textContent, /Send failed/);
  });
});

test('failed send keeps the stable composer textarea and shows the error', async () => {
  const { browser, doc } = renderApp();

  await withFetch(async (input) => {
    if (String(input).endsWith('/say')) return Response.json({ ok: false, error: 'No room left.' }, { status: 400 });
    return Response.json(testView(1));
  }, async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    textarea.value = 'hello';
    textarea.oninput?.();

    await browser.onSend(textarea as unknown as HTMLTextAreaElement);

    assert.equal(doc.app.querySelector<TestNode>('.composer__input'), textarea);
    assert.equal(textarea.value, 'hello');
    assert.match(doc.app.textContent, /No room left/);
  });
});

test('failed send keeps its error when the follow-up refresh rejects', async () => {
  const { browser, doc } = renderApp();

  await withFetch(async (input) => {
    const path = String(input);
    if (path.endsWith('/say')) return Response.json({ ok: false, error: 'No room left.' }, { status: 400 });
    if (path === '/api/conversations/c1') throw new Error('view offline');
    return Response.json(testView());
  }, async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    textarea.value = 'hello';
    textarea.oninput?.();

    await browser.onSend(textarea as unknown as HTMLTextAreaElement);

    assert.equal(doc.app.querySelector<TestNode>('.composer__input'), textarea);
    assert.equal(textarea.value, 'hello');
    assert.match(doc.app.textContent, /No room left/);
  });
});

test('failed send refreshes a server-side read-only transition', async () => {
  const { browser, doc } = renderApp();

  await withFetch(async (input) => {
    const path = String(input);
    if (path.endsWith('/say')) return Response.json({ ok: false, error: 'conversation is read-only' }, { status: 400 });
    if (path === '/api/conversations/c1') return Response.json(testView(1, [], true));
    return Response.json(testView());
  }, async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    textarea.value = 'too much';
    textarea.oninput?.();

    await browser.onSend(textarea as unknown as HTMLTextAreaElement);

    assert.equal(doc.app.querySelector<TestNode>('.composer__input'), textarea);
    assert.equal(textarea.disabled, true);
    assert.match(doc.app.textContent, /conversation is read-only/);
    assert.match(doc.app.textContent, /Conversation storage limit reached/);
  });
});

test('failed send refreshes a missing conversation', async () => {
  const { browser, doc } = renderApp();

  await withFetch(async (input) => {
    const path = String(input);
    if (path.endsWith('/say')) return Response.json({ ok: false, error: 'unknown conversation' }, { status: 404 });
    if (path === '/api/conversations/c1') return new Response(JSON.stringify({ error: 'missing' }), { status: 404 });
    if (path === '/api/projects') return Response.json(projectList([]));
    return Response.json(testView());
  }, async () => {
    const textarea = doc.app.querySelector<TestNode>('.composer__input')!;
    textarea.value = 'hello';
    textarea.oninput?.();

    await browser.onSend(textarea as unknown as HTMLTextAreaElement);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assert.equal(browser.conversationId, null);
    assert.match(doc.live.textContent, /Conversation no longer exists/);
    assert.match(doc.app.textContent, /No conversation open/);
  });
});

test('IME composition Enter does not send the composer draft', async () => {
  const { doc } = renderApp();
  let sent = false;
  let defaultPrevented = false;

  await withFetch(async () => {
    sent = true;
    return Response.json({ ok: false }, { status: 400 });
  }, async () => {
    const textarea = doc.app.querySelector<HTMLTextAreaElement>('.composer__input')!;
    textarea.value = 'ni';
    textarea.oninput?.({} as InputEvent);
    textarea.onkeydown?.({
      altKey: false,
      isComposing: true,
      key: 'Enter',
      preventDefault() {
        defaultPrevented = true;
      },
      shiftKey: false,
    } as KeyboardEvent);

    assert.equal(sent, false);
    assert.equal(defaultPrevented, false);
  });
});
