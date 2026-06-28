import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentAccent, App, composerState, renderContent, streamEvents } from '../../src/web/app.ts';
import type { RenderNode } from '../../src/server/render.ts';

/* A minimal DOM substitute, enough for rendering and App refresh tests without
   pulling in a browser DOM library. */
class TestNode {
  attrs: Record<string, string> = {};
  children: TestNode[] = [];
  className = '';
  clientHeight = 0;
  disabled = false;
  onclick: (() => void) | null = null;
  oninput: (() => void) | null = null;
  onkeydown: ((e: KeyboardEvent) => void) | null = null;
  parent: TestNode | null = null;
  placeholder = '';
  rows = 0;
  scrollHeight = 0;
  scrollTop = 0;
  selectionEnd = 0;
  selectionStart = 0;
  value = '';
  _text = '';
  readonly tag: string;

  constructor(tag: string) {
    this.tag = tag;
  }

  get textContent(): string {
    return this._text || this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this._text = value;
    this.children = [];
  }

  append(...nodes: TestNode[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node: TestNode): TestNode {
    node.parent = this;
    this._text = '';
    this.children.push(node);
    return node;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  querySelector<T>(selector: string): T | null {
    const className = selector.startsWith('.') ? selector.slice(1) : selector;
    return findByClass(this, className) as T | null;
  }
}

class TestDocument {
  readonly app = new TestNode('div');
  readonly live = new TestNode('div');

  createDocumentFragment(): TestNode {
    return new TestNode('#fragment');
  }

  createElement(tag: string): TestNode {
    return new TestNode(tag);
  }

  createTextNode(text: string): TestNode {
    const node = new TestNode('#text');
    node.textContent = text;
    return node;
  }

  getElementById(id: string): TestNode | null {
    if (id === 'app') return this.app;
    if (id === 'live') return this.live;
    return null;
  }
}

function findByClass(node: TestNode, className: string): TestNode | null {
  if (node.className.split(/\s+/).includes(className)) return node;
  for (const child of node.children) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

const fakeDoc = () => new TestDocument() as unknown as Document;

function serialize(node: TestNode): string {
  if (node.tag === '#text') return node._text;
  const inner = node._text || node.children.map(serialize).join('');
  return node.tag === '#fragment' ? inner : `<${node.tag}>${inner}</${node.tag}>`;
}

const render = (nodes: RenderNode[]) => serialize(renderContent(nodes, fakeDoc()) as unknown as TestNode);

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

test('message refresh preserves an in-progress composer draft', async () => {
  const doc = new TestDocument();
  const app = new App(doc as unknown as Document);
  const browser = app as unknown as {
    conversations: unknown[];
    conversationId: string;
    refresh(): Promise<void>;
    render(): void;
    view: unknown;
  };
  const originalFetch = globalThis.fetch;
  let cursor = 1;

  globalThis.fetch = (async (input) => {
    assert.equal(String(input), '/api/conversations/c1');
    cursor += 1;
    return Response.json({
      cursor,
      readOnly: false,
      events: [{ id: `e${cursor}`, type: 'message', timestamp: 't', author: 'agent', content: [{ type: 'text', value: 'new' }] }],
    });
  }) as typeof fetch;

  try {
    browser.conversations = [{ id: 'c1', title: 'Chat', readOnly: false }];
    browser.conversationId = 'c1';
    browser.view = { cursor: 1, readOnly: false, events: [] };
    browser.render();

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

    assert.equal(doc.app.querySelector<HTMLTextAreaElement>('.composer__input')!.value, 'half typed\n');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('IME composition Enter does not send the composer draft', () => {
  const doc = new TestDocument();
  const app = new App(doc as unknown as Document);
  const browser = app as unknown as {
    conversations: unknown[];
    conversationId: string;
    render(): void;
    view: unknown;
  };
  const originalFetch = globalThis.fetch;
  let sent = false;
  let defaultPrevented = false;

  globalThis.fetch = (async () => {
    sent = true;
    return Response.json({ ok: false }, { status: 400 });
  }) as typeof fetch;

  try {
    browser.conversations = [{ id: 'c1', title: 'Chat', readOnly: false }];
    browser.conversationId = 'c1';
    browser.view = { cursor: 1, readOnly: false, events: [] };
    browser.render();

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
  } finally {
    globalThis.fetch = originalFetch;
  }
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
