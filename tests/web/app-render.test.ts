import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderContent } from '../../src/web/render-content.ts';
import { agentAccent, composerState } from '../../src/web/ui-state.ts';
import { fakeDoc, messageEvent, render, renderApp, testView } from './app-test-harness.ts';
import type { TestNode } from './app-test-harness.ts';

test('text content becomes a text node, never markup (AE13)', () => {
  const frag = renderContent([{ type: 'text', value: '<script>alert(1)</script>' }], fakeDoc()) as unknown as TestNode;
  assert.equal(frag.children[0]!.tag, '#text'); // created via createTextNode, not parsed
  assert.equal(frag.children[0]!._text, '<script>alert(1)</script>');
});

test('renders paragraphs, strong, and code via real elements', () => {
  assert.equal(render([{ type: 'paragraph', children: [{ type: 'text', value: 'hi' }] }]), '<p>hi</p>');
  assert.equal(render([{ type: 'strong', children: [{ type: 'text', value: 'b' }] }]), '<strong>b</strong>');
  assert.equal(render([{ type: 'code', value: 'x' }]), '<code>x</code>');
});

test('renders lists and headings', () => {
  assert.equal(
    render([{ type: 'list', ordered: false, children: [{ type: 'listitem', children: [{ type: 'text', value: 'a' }] }] }]),
    '<ul><li>a</li></ul>',
  );
  assert.equal(render([{ type: 'heading', level: 3, children: [{ type: 'text', value: 't' }] }]), '<h3>t</h3>');
});

test('links carry an href and rel attributes', () => {
  const frag = renderContent([{ type: 'link', href: 'https://e.com', children: [{ type: 'text', value: 'x' }] }], fakeDoc()) as unknown as TestNode;
  const anchor = frag.children[0]!;
  assert.equal(anchor.tag, 'a');
  assert.equal(anchor.attrs.href, 'https://e.com');
  assert.match(anchor.attrs.rel!, /noopener/);
});

test('composerState disables with a reason for each blocked condition', () => {
  const base = { hasConversation: true, readOnly: false };
  assert.deepEqual(composerState(base), { disabled: false, reason: null });
  assert.equal(composerState({ ...base, hasConversation: false }).disabled, true);
  assert.match(composerState({ ...base, readOnly: true }).reason!, /read-only/);
});

test('agentAccent maps a model family to its bubble accent', () => {
  for (const name of ['Claude Opus 4.8', 'Sonnet 4.6', 'Haiku 4.5', 'Fable 5', 'Mythos']) {
    assert.equal(agentAccent(name), 'claude', name);
  }
  for (const name of ['GPT-5.5', 'Codex']) {
    assert.equal(agentAccent(name), 'gpt', name);
  }
  for (const name of ['Gemini 3.1 Pro', 'Antigravity', 'agy']) {
    assert.equal(agentAccent(name), 'gemini', name);
  }
  assert.equal(agentAccent('user'), null);
  assert.equal(agentAccent(undefined), null);
});

test('renders today message timestamps as time only', () => {
  const date = new Date();
  date.setHours(3, 4, 5, 0);
  const { time, timestamp } = renderMessageTime(date);

  assert.equal(time.textContent, new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date));
  assert.equal(time.attrs.datetime, timestamp);
  assert.equal(time.attrs.title, new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date));
});

test('renders yesterday message timestamps with a localized relative day', () => {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  date.setHours(3, 4, 5, 0);
  const { time, timestamp } = renderMessageTime(date);

  const day = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-1, 'day');
  const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  assert.equal(time.textContent, `${day} ${clock}`);
  assert.equal(time.attrs.datetime, timestamp);
});

test('renders older message timestamps with date and time', () => {
  const date = new Date();
  date.setDate(date.getDate() - 2);
  date.setHours(3, 4, 5, 0);
  const { time, timestamp } = renderMessageTime(date);

  assert.equal(time.textContent, new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date));
  assert.equal(time.attrs.datetime, timestamp);
});

test('renders system event timestamps without an author role', () => {
  const date = new Date();
  date.setHours(3, 4, 5, 0);
  const timestamp = date.toISOString();
  const { doc } = renderApp({
    view: testView(1, [
      {
        id: 'e1',
        type: 'system',
        timestamp,
        content: [{ type: 'text', value: 'notice' }],
      },
    ]),
  });

  const system = doc.app.querySelector<TestNode>('.msg--system')!;
  const meta = system.querySelector<TestNode>('.msg__meta')!;
  const time = system.querySelector<TestNode>('time')!;
  assert.match(meta.className, /msg__meta--system/);
  assert.equal(system.querySelector<TestNode>('.msg__role'), null);
  assert.equal(time.attrs.datetime, timestamp);
});

test('refresh updates existing timestamp labels after local day changes', () => {
  const sentAt = new Date(2026, 0, 2, 22, 0, 0);
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 2, 23, 30, 0) });
  try {
    const event = { ...messageEvent('hello', 'e1'), timestamp: sentAt.toISOString() };
    const { browser, doc } = renderApp({ view: testView(1, [event]) });
    const time = doc.app.querySelector<TestNode>('time')!;
    const todayLabel = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(sentAt);
    assert.equal(time.textContent, todayLabel);

    mock.timers.setTime(new Date(2026, 0, 3, 0, 30, 0).getTime());
    browser.view = testView(2, [event, messageEvent('new', 'e2')]);
    browser.render();

    const day = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-1, 'day');
    assert.equal(time.textContent, `${day} ${todayLabel}`);
  } finally {
    mock.timers.reset();
  }
});

function renderMessageTime(date: Date): { time: TestNode; timestamp: string } {
  const timestamp = date.toISOString();
  const { doc } = renderApp({
    view: testView(1, [{ ...messageEvent('hello', 'e1'), timestamp }]),
  });
  return { time: doc.app.querySelector<TestNode>('time')!, timestamp };
}
