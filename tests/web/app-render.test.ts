import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderContent } from '../../src/web/render-content.ts';
import { agentAccent, composerState } from '../../src/web/ui-state.ts';
import { fakeDoc, render } from './app-test-harness.ts';
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
