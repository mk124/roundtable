import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversation,
  findAllByClass,
  messageEvent,
  project,
  projectList,
  renderApp,
  testView,
  withFetch,
  withWindow,
} from './app-test-harness.ts';
import type { TestNode } from './app-test-harness.ts';

const empty = { conversationId: null, view: null } as const;

test('with no projects the sidebar offers only "+ Project" and an empty hint', () => {
  const { doc } = renderApp({ projects: [], ...empty });
  assert.ok(doc.app.querySelector<TestNode>('[data-sidebar-action="add-project"]'));
  assert.match(doc.app.textContent, /Add a project to start/);
  assert.equal(doc.app.querySelector<TestNode>('[data-sidebar-action="create"]'), null); // no way to create a conversation yet
  assert.equal(doc.app.querySelector<TestNode>('[data-sidebar-action="open"]'), null);
});

test('projects render as groups with their own conversations nested', () => {
  const { doc } = renderApp({
    projects: [project('p1', 'alpha', [conversation('a1', 'Alpha chat')]), project('p2', 'beta', [conversation('b1', 'Beta chat')])],
    ...empty,
  });
  assert.ok(doc.app.querySelector<TestNode>('[data-sidebar-action="open"][data-conversation-id="a1"]'));
  assert.ok(doc.app.querySelector<TestNode>('[data-sidebar-action="open"][data-conversation-id="b1"]'));
  assert.ok(doc.app.querySelector<TestNode>('[data-sidebar-action="create"][data-project-id="p1"]'));
  assert.ok(doc.app.querySelector<TestNode>('[data-sidebar-action="create"][data-project-id="p2"]'));

  // Ownership: the first group holds only its own conversation.
  const firstGroup = doc.app.querySelector<TestNode>('.project')!;
  assert.match(firstGroup.textContent, /Alpha chat/);
  assert.doesNotMatch(firstGroup.textContent, /Beta chat/);
});

test('+ Project prompts for a path, posts it, and reloads the sidebar', async () => {
  const { browser, doc } = renderApp({ projects: [], ...empty });
  let postedPath: string | null = null;

  await withWindow({ prompt: () => '/abs/new' }, async () => {
    await withFetch(async (input, init) => {
      const path = String(input);
      if (path === '/api/projects' && init?.method === 'POST') {
        postedPath = (JSON.parse(String(init.body)) as { path: string }).path;
        return Response.json({ project: { id: 'p9', path: '/abs/new', title: 'new', conversations: [] } });
      }
      if (path === '/api/projects') return Response.json(projectList([], [project('p9', 'new', [])]));
      return Response.json(testView());
    }, async () => {
      await browser.addProject();
    });
  });

  assert.equal(postedPath, '/abs/new');
  assert.match(doc.app.textContent, /new/); // reloaded with the new project
});

test('a rejected project path alerts the reason and leaves the sidebar unchanged', async () => {
  const { browser, doc } = renderApp({ projects: [project('p1', 'proj', [conversation('c1', 'Chat')])], ...empty });
  let alerted = '';
  let reloads = 0;

  await withWindow({ prompt: () => '/bad', alert: (m: string) => { alerted = m; } }, async () => {
    await withFetch(async (input, init) => {
      const path = String(input);
      if (path === '/api/projects' && init?.method === 'POST') return Response.json({ ok: false, error: 'project path must be a directory' }, { status: 400 });
      if (path === '/api/projects') { reloads++; return Response.json(projectList([])); }
      return Response.json(testView());
    }, async () => {
      await browser.addProject();
    });
  });

  assert.match(alerted, /must be a directory/);
  assert.equal(reloads, 0); // failure does not reload
  assert.match(doc.app.textContent, /Chat/); // sidebar intact
});

test('a project\'s "+ New conversation" creates under that project', async () => {
  const { browser } = renderApp({ projects: [project('p1', 'proj', [])], ...empty });
  let createdUnder: string | null = null;

  await withWindow({ prompt: () => 'Fresh' }, async () => {
    await withFetch(async (input, init) => {
      const path = String(input);
      if (path === '/api/projects/p1/conversations' && init?.method === 'POST') {
        createdUnder = 'p1';
        return Response.json({ conversation: { id: 'cN', title: 'Fresh', readOnly: false } });
      }
      if (path === '/api/projects') return Response.json(projectList([conversation('cN', 'Fresh')]));
      return Response.json(testView());
    }, async () => {
      await browser.createConversation('p1');
    });
  });

  assert.equal(createdUnder, 'p1');
});

test('removing a project confirms, deletes, and reloads; cancelling makes no request', async () => {
  const proj = project('p1', 'proj', [conversation('c1', 'Chat')]);

  const confirmed = renderApp({ projects: [proj], ...empty });
  let deletes = 0;
  let reloads = 0;
  await withWindow({ confirm: () => true }, async () => {
    await withFetch(async (input, init) => {
      const path = String(input);
      if (path === '/api/projects/p1' && init?.method === 'DELETE') { deletes++; return Response.json({ ok: true }); }
      if (path === '/api/projects') { reloads++; return Response.json(projectList([], [])); }
      return Response.json(testView());
    }, async () => {
      await confirmed.browser.removeProject(proj);
    });
  });
  assert.equal(deletes, 1);
  assert.equal(reloads, 1);

  const cancelled = renderApp({ projects: [proj], ...empty });
  let calls = 0;
  await withWindow({ confirm: () => false }, async () => {
    await withFetch(async () => { calls++; return Response.json({ ok: true }); }, async () => {
      await cancelled.browser.removeProject(proj);
    });
  });
  assert.equal(calls, 0);
});

test('a failed project removal announces and leaves the sidebar intact', async () => {
  const proj = project('p1', 'proj', [conversation('c1', 'Chat')]);
  const { browser, doc } = renderApp({ projects: [proj], ...empty });
  let reloads = 0;

  await withWindow({ confirm: () => true }, async () => {
    await withFetch(async (input, init) => {
      const path = String(input);
      if (path === '/api/projects/p1' && init?.method === 'DELETE') return Response.json({ ok: false }, { status: 400 });
      if (path === '/api/projects') { reloads++; return Response.json(projectList([conversation('c1', 'Chat')])); }
      return Response.json(testView());
    }, async () => {
      await browser.removeProject(proj);
    });
  });

  assert.equal(reloads, 0); // a failed remove does not reload
  assert.match(doc.live.textContent, /Remove failed/);
  assert.match(doc.app.textContent, /Chat/); // sidebar intact
});

test('removing a project detaches the open conversation even when it is absent from the click-time snapshot', async () => {
  // A conversation opened during the remove request is not in the snapshot captured
  // when the ✕ was rendered; the detach decision must use the reloaded list instead.
  const staleSnapshot = project('p1', 'proj', []);
  const { browser, doc } = renderApp({ projects: [project('p1', 'proj', [conversation('c1', 'Chat')])], conversationId: 'c1', view: testView(1, [messageEvent('hi')]) });
  browser.sseAbort = new AbortController();

  await withWindow({ confirm: () => true }, async () => {
    await withFetch(async (input, init) => {
      const path = String(input);
      if (path === '/api/projects/p1' && init?.method === 'DELETE') return Response.json({ ok: true });
      if (path === '/api/projects') return Response.json(projectList([], [])); // p1 is gone
      return Response.json(testView());
    }, async () => {
      await browser.removeProject(staleSnapshot);
    });
  });

  assert.equal(browser.conversationId, null); // detached via the reloaded list, not the stale snapshot
  assert.match(doc.app.textContent, /No conversation open/);
});

test('a failed conversation creation alerts the reason and does not reload', async () => {
  const { browser } = renderApp({ projects: [project('p1', 'proj', [])], ...empty });
  let alerted = '';
  let reloads = 0;

  await withWindow({ prompt: () => 'Fresh', alert: (m: string) => { alerted = m; } }, async () => {
    await withFetch(async (input, init) => {
      const path = String(input);
      if (path === '/api/projects/p1/conversations' && init?.method === 'POST') return Response.json({ ok: false, error: 'unknown project' }, { status: 400 });
      if (path === '/api/projects') { reloads++; return Response.json(projectList([])); }
      return Response.json(testView());
    }, async () => {
      await browser.createConversation('p1');
    });
  });

  assert.match(alerted, /unknown project/);
  assert.equal(reloads, 0); // failure leaves the sidebar as-is
});

test('removing the project of the open conversation resets to no conversation', async () => {
  const proj = project('p1', 'proj', [conversation('c1', 'Chat')]);
  const { browser, doc } = renderApp({ projects: [proj], conversationId: 'c1', view: testView(1, [messageEvent('hi')]) });
  const sse = new AbortController();
  browser.sseAbort = sse;

  await withWindow({ confirm: () => true }, async () => {
    await withFetch(async (input, init) => {
      const path = String(input);
      if (path === '/api/projects/p1' && init?.method === 'DELETE') return Response.json({ ok: true });
      if (path === '/api/projects') return Response.json(projectList([], []));
      return Response.json(testView());
    }, async () => {
      await browser.removeProject(proj);
    });
  });

  assert.equal(browser.conversationId, null);
  assert.equal(browser.view, null);
  assert.equal(sse.signal.aborted, true);
  assert.match(doc.live.textContent, /Project removed/);
  assert.match(doc.app.textContent, /No conversation open/);
});

test('a sole project shows its basename; shared basenames disambiguate by last two segments', () => {
  const sole = renderApp({ projects: [project('p1', 'web', [], '/acme/web')], ...empty });
  assert.equal(sole.doc.app.querySelector<TestNode>('.project__title')!.textContent, 'web');

  const { doc } = renderApp({ projects: [project('p1', 'web', [], '/acme/web'), project('p2', 'web', [], '/beta/web')], ...empty });
  const titles = findAllByClass(doc.app, 'project__title');
  assert.deepEqual(titles.map((t) => t.textContent), ['acme/web', 'beta/web']);
  assert.deepEqual(titles.map((t) => t.getAttribute('title')), ['/acme/web', '/beta/web']); // full path always on hover
});

test('projects with identical last-two segments still differ by their full-path hover title', () => {
  const { doc } = renderApp({ projects: [project('p1', 'web', [], '/a/src/web'), project('p2', 'web', [], '/b/src/web')], ...empty });
  const titles = findAllByClass(doc.app, 'project__title');
  assert.deepEqual(titles.map((t) => t.textContent), ['src/web', 'src/web']);
  assert.deepEqual(titles.map((t) => t.getAttribute('title')), ['/a/src/web', '/b/src/web']);
});

test('a project group collapses and expands on toggle, hiding its body', () => {
  const { doc } = renderApp({ projects: [project('p1', 'proj', [conversation('c1', 'Chat')])], ...empty });
  const toggle = doc.app.querySelector<TestNode>('[data-sidebar-action="toggle-project"][data-project-id="p1"]')!;
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(doc.app.querySelector<TestNode>('[data-sidebar-action="open"][data-conversation-id="c1"]'));

  toggle.onclick!(); // collapse

  const collapsed = doc.app.querySelector<TestNode>('[data-sidebar-action="toggle-project"][data-project-id="p1"]')!;
  assert.equal(collapsed.getAttribute('aria-expanded'), 'false');
  assert.equal(findAllByClass(doc.app, 'project--collapsed').length, 1);
  assert.equal(doc.app.querySelector<TestNode>('[data-sidebar-action="open"][data-conversation-id="c1"]'), null); // conversations hidden
  assert.equal(doc.app.querySelector<TestNode>('[data-sidebar-action="create"][data-project-id="p1"]'), null); // create hidden too

  collapsed.onclick!(); // expand again
  assert.ok(doc.app.querySelector<TestNode>('[data-sidebar-action="open"][data-conversation-id="c1"]'));
  assert.equal(findAllByClass(doc.app, 'project--collapsed').length, 0);
});

test('a collapsed project stays collapsed across a sidebar refresh', async () => {
  const { browser, doc } = renderApp({ projects: [project('p1', 'proj', [conversation('c1', 'Chat')])], ...empty });
  doc.app.querySelector<TestNode>('[data-sidebar-action="toggle-project"][data-project-id="p1"]')!.onclick!();

  await withFetch(async () => Response.json(projectList([conversation('c1', 'Chat')])), async () => {
    await browser.loadProjects();
  });

  const toggle = doc.app.querySelector<TestNode>('[data-sidebar-action="toggle-project"][data-project-id="p1"]')!;
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.app.querySelector<TestNode>('[data-sidebar-action="open"][data-conversation-id="c1"]'), null);
});

test('a sidebar refresh restores focus to the right project control by project id', async () => {
  const projects = [project('p1', 'alpha', [conversation('a1', 'A')]), project('p2', 'beta', [conversation('b1', 'B')])];
  const { browser, doc } = renderApp({ projects, ...empty });

  await withFetch(async (input) => {
    assert.equal(String(input), '/api/projects');
    return Response.json(projectList([], projects));
  }, async () => {
    doc.app.querySelector<TestNode>('[data-sidebar-action="create"][data-project-id="p2"]')!.focus();
    await browser.loadProjects();
    const restored = doc.app.querySelector<TestNode>('[data-sidebar-action="create"][data-project-id="p2"]')!;
    assert.equal(doc.activeElement, restored);
  });
});
