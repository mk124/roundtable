import { App, renderContent } from '../../src/web/app.ts';
import type { RenderNode } from '../../src/server/render.ts';

/* A minimal DOM substitute, enough for rendering and App interaction tests without
   pulling in a browser DOM library. */
export class TestNode {
  attrs: Record<string, string> = {};
  children: TestNode[] = [];
  className = '';
  clientHeight = 0;
  disabled = false;
  hidden = false;
  onclick: (() => void) | null = null;
  oninput: (() => void) | null = null;
  onkeydown: ((e: KeyboardEvent) => void) | null = null;
  onscroll: ((e: Event) => void) | null = null;
  placeholder = '';
  rows = 0;
  scrollHeight = 0;
  scrollTop = 0;
  selectionEnd = 0;
  selectionStart = 0;
  value = '';
  _text = '';
  readonly tag: string;
  private readonly doc: TestDocument | null;

  constructor(tag: string, doc: TestDocument | null = null) {
    this.tag = tag;
    this.doc = doc;
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
    this._text = '';
    this.children.push(node);
    return node;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  focus(): void {
    if (this.doc) this.doc.activeElement = this;
  }

  querySelector<T>(selector: string): T | null {
    if (selector.startsWith('.')) return findByClass(this, selector.slice(1)) as T | null;
    if (selector.startsWith('[')) return findByAttrs(this, selector) as T | null;
    return findByTag(this, selector) as T | null;
  }
}

export class TestDocument {
  activeElement: TestNode | null = null;
  readonly app = new TestNode('div');
  readonly live = new TestNode('div');

  createDocumentFragment(): TestNode {
    return new TestNode('#fragment', this);
  }

  createElement(tag: string): TestNode {
    return new TestNode(tag, this);
  }

  createTextNode(text: string): TestNode {
    const node = new TestNode('#text', this);
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

function findByTag(node: TestNode, tag: string): TestNode | null {
  if (node.tag === tag) return node;
  for (const child of node.children) {
    const found = findByTag(child, tag);
    if (found) return found;
  }
  return null;
}

function findByAttrs(node: TestNode, selector: string): TestNode | null {
  const attrs: [string, string][] = [];
  for (const match of selector.matchAll(/\[([^=\]]+)="([^"]*)"\]/g)) {
    if (match[1] !== undefined && match[2] !== undefined) attrs.push([match[1], match[2]]);
  }
  if (attrs.length && attrs.every(([name, value]) => node.attrs[name] === value)) return node;
  for (const child of node.children) {
    const found = findByAttrs(child, selector);
    if (found) return found;
  }
  return null;
}

export function findByText(node: TestNode, text: string): TestNode | null {
  if (node._text === text) return node;
  for (const child of node.children) {
    const found = findByText(child, text);
    if (found) return found;
  }
  return null;
}

export const fakeDoc = () => new TestDocument() as unknown as Document;

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function serialize(node: TestNode): string {
  if (node.tag === '#text') return node._text;
  const inner = node._text || node.children.map(serialize).join('');
  return node.tag === '#fragment' ? inner : `<${node.tag}>${inner}</${node.tag}>`;
}

export const render = (nodes: RenderNode[]) => serialize(renderContent(nodes, fakeDoc()) as unknown as TestNode);

export type TestConversation = { id: string; title: string; readOnly: boolean };
export type TestEvent = {
  id: string;
  type: 'message' | 'system';
  timestamp: string;
  author?: string;
  content?: RenderNode[];
};
export type TestView = { cursor: number; readOnly: boolean; events: TestEvent[] };
type AppInternals = {
  connect(id: string): void;
  conversations: TestConversation[];
  conversationId: string | null;
  deleteConversation(conv: TestConversation): Promise<void>;
  loadConversations(): Promise<void>;
  onSseDrop(controller: AbortController): void;
  onSend(textarea: HTMLTextAreaElement): Promise<void>;
  openConversation(id: string): Promise<void>;
  refresh(): Promise<void>;
  render(): void;
  sse: 'connected' | 'reconnecting' | 'disconnected';
  sseAbort: AbortController | null;
  view: TestView | null;
};

export type AppDriver = Omit<AppInternals, 'conversations'>;

export const conversation = (id = 'c1', title = 'Chat', readOnly = false): TestConversation => ({ id, title, readOnly });
export const messageEvent = (value: string, id = value): TestEvent => ({
  id,
  type: 'message',
  timestamp: 't',
  author: 'agent',
  content: [{ type: 'text', value }],
});
export const testView = (cursor = 1, events: TestEvent[] = [], readOnly = false): TestView => ({ cursor, readOnly, events });

export function pendingResponse(): { response: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void;
  const response = new Promise<Response>((done) => (resolve = done));
  return { response, resolve };
}

export const neverResponse = (): Promise<Response> => new Promise<Response>(() => {});

export async function withWindowTimeout<T>(run: (flush: () => void) => Promise<T>): Promise<T> {
  type WindowTimeoutStub = {
    clearInterval(): void;
    setInterval(): number;
    setTimeout(callback: () => void): number;
  };
  const host = globalThis as unknown as Record<string, unknown>;
  const originalWindow = host.window;
  let scheduled: (() => void) | null = null;
  host.window = {
    clearInterval() {},
    setInterval() {
      return 1;
    },
    setTimeout(callback: () => void) {
      scheduled = () => {
        callback();
      };
      return 1;
    },
  } satisfies WindowTimeoutStub;
  try {
    return await run(() => {
      const callback = scheduled;
      scheduled = null;
      callback?.();
    });
  } finally {
    if (originalWindow !== undefined) host.window = originalWindow;
    else Reflect.deleteProperty(host, 'window');
  }
}

export function eventStream(): { response: Response; send: (frame: string) => void } {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (stream) => (controller = stream) });
  return {
    response: new Response(body),
    send: (frame) => controller.enqueue(encoder.encode(frame)),
  };
}

export function renderApp(opts: { conversations?: TestConversation[]; conversationId?: string | null; view?: TestView | null } = {}): {
  browser: AppDriver;
  doc: TestDocument;
} {
  const doc = new TestDocument();
  const app = new App(doc as unknown as Document);
  const internals = app as unknown as AppInternals;
  internals.conversations = opts.conversations ?? [conversation()];
  internals.conversationId = opts.conversationId === undefined ? 'c1' : opts.conversationId;
  internals.view = opts.view === undefined ? testView() : opts.view;
  const browser = internals as AppDriver;
  browser.render();
  return { browser, doc };
}

export async function withFetch<T>(fetch: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
