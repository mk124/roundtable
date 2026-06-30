import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderContent } from '../../src/web/render-content.ts';
import { fakeDoc, messageEvent, renderApp, testView } from './app-test-harness.ts';
import type { TestNode } from './app-test-harness.ts';

test('text content becomes a text node, never markup', () => {
  const frag = renderContent([{ type: 'text', value: '<script>alert(1)</script>' }], fakeDoc()) as unknown as TestNode;
  assert.equal(frag.children[0]!.tag, '#text'); // created via createTextNode, not parsed
  assert.equal(frag.children[0]!._text, '<script>alert(1)</script>');
});

test('links carry an href and rel attributes', () => {
  const frag = renderContent([{ type: 'link', href: 'https://e.com', children: [{ type: 'text', value: 'x' }] }], fakeDoc()) as unknown as TestNode;
  const anchor = frag.children[0]!;

  assert.equal(anchor.tag, 'a');
  assert.equal(anchor.attrs.href, 'https://e.com');
  assert.match(anchor.attrs.rel!, /noopener/);
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
