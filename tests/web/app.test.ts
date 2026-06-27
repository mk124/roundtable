import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentAccent, composerState, renderContent, streamEvents } from '../../src/web/app.ts';
import type { RenderNode } from '../../src/server/render.ts';

/* A minimal Document substitute: just enough of the API renderContent uses, so
   tests run without a DOM library and still prove no innerHTML is involved. */
interface FakeNode {
  tag: string;
  attrs: Record<string, string>;
  children: FakeNode[];
  _text: string;
}
function fakeDoc(): Document {
  const makeEl = (tag: string): FakeNode & Record<string, unknown> => {
    const node = {
      tag,
      attrs: {} as Record<string, string>,
      children: [] as FakeNode[],
      _text: '',
      className: '',
      classList: { add() {} },
      get textContent() {
        return this._text;
      },
      set textContent(v: string) {
        this._text = v;
        this.children = [];
      },
      setAttribute(k: string, v: string) {
        node.attrs[k] = v;
      },
      appendChild(c: FakeNode) {
        node.children.push(c);
        return c;
      },
    };
    return node;
  };
  return {
    createElement: (tag: string) => makeEl(tag),
    createTextNode: (text: string) => ({ tag: '#text', attrs: {}, children: [], _text: text }),
    createDocumentFragment: () => makeEl('#fragment'),
  } as unknown as Document;
}

function serialize(node: FakeNode): string {
  if (node.tag === '#text') return node._text;
  const inner = node._text || node.children.map(serialize).join('');
  return node.tag === '#fragment' ? inner : `<${node.tag}>${inner}</${node.tag}>`;
}

const render = (nodes: RenderNode[]) => serialize(renderContent(nodes, fakeDoc()) as unknown as FakeNode);

test('text content becomes a text node, never markup (AE13)', () => {
  const frag = renderContent([{ type: 'text', value: '<script>alert(1)</script>' }], fakeDoc()) as unknown as FakeNode;
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
  const frag = renderContent([{ type: 'link', href: 'https://e.com', children: [{ type: 'text', value: 'x' }] }], fakeDoc()) as unknown as FakeNode;
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

test('streamEvents treats a 404 stream as a missing conversation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 })) as typeof fetch;
  const seen = { missing: 0, drop: 0 };
  try {
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
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(seen, { missing: 1, drop: 0 });
});
