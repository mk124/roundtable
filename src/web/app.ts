import type { RenderNode } from '../server/render.ts';

/* ── DTO mirrors (shape of the server's display-safe responses) ─────────── */

interface EventDTO {
  id: string;
  type: 'message' | 'system';
  timestamp: string;
  author?: string;
  content?: RenderNode[];
}

interface ViewDTO {
  readOnly: boolean;
  events: EventDTO[];
  cursor: number;
}

interface ConversationDTO {
  id: string;
  title: string;
  readOnly: boolean;
}

interface ActivityEntry {
  author: string;
  state: string;
  since: string;
}

/* ── Testable safe rendering (R28, AE13) ───────────────────────────────── */

/**
 * Build DOM from the server's allowlisted render tree using only
 * createElement/createTextNode — never innerHTML — so untrusted conversation
 * content can never become markup.
 */
export function renderContent(nodes: RenderNode[], doc: Document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  for (const node of nodes) fragment.appendChild(renderNode(node, doc));
  return fragment;
}

function renderNode(node: RenderNode, doc: Document): Node {
  switch (node.type) {
    case 'text':
      return doc.createTextNode(node.value ?? '');
    case 'break':
      return doc.createElement('br');
    case 'code': {
      const el = doc.createElement('code');
      el.textContent = node.value ?? '';
      return el;
    }
    case 'codeblock': {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = node.value ?? '';
      pre.appendChild(code);
      return pre;
    }
    case 'link': {
      const el = doc.createElement('a');
      el.setAttribute('href', node.href ?? '#');
      el.setAttribute('rel', 'noopener noreferrer nofollow');
      appendChildren(el, node, doc);
      return el;
    }
    case 'list':
      return wrap(node.ordered ? 'ol' : 'ul', node, doc);
    case 'heading':
      return wrap(`h${Math.min(6, Math.max(1, node.level ?? 1))}`, node, doc);
    case 'tablecell':
      return wrap(node.header ? 'th' : 'td', node, doc);
    default:
      return wrap(TAG[node.type] ?? 'span', node, doc);
  }
}

const TAG: Partial<Record<RenderNode['type'], string>> = {
  paragraph: 'p',
  blockquote: 'blockquote',
  strong: 'strong',
  emphasis: 'em',
  span: 'span',
  listitem: 'li',
  table: 'table',
  tablerow: 'tr',
};

function wrap(tag: string, node: RenderNode, doc: Document): HTMLElement {
  const el = doc.createElement(tag);
  appendChildren(el, node, doc);
  return el;
}

function appendChildren(el: HTMLElement, node: RenderNode, doc: Document): void {
  for (const child of node.children ?? []) el.appendChild(renderNode(child, doc));
}

/* ── Testable UI-state helper ──────────────────────────────────────────── */

export type ComposerState = { disabled: boolean; reason: string | null };

/** Whether the composer accepts input, and why not. */
export function composerState(opts: { hasConversation: boolean; readOnly: boolean }): ComposerState {
  if (!opts.hasConversation) return { disabled: true, reason: 'Create a conversation to begin.' };
  if (opts.readOnly) return { disabled: true, reason: 'This conversation is read-only.' };
  return { disabled: false, reason: null };
}

/** Map an author to a model-family accent, so a bubble's edge signals who spoke.
 *  Recognises each family's common names (e.g. Sonnet/Haiku/Fable → Claude), not
 *  just the brand word. Substring match, case-insensitive; unknown → no accent. */
export function agentAccent(author: string | undefined): 'claude' | 'gpt' | 'gemini' | null {
  const name = author?.toLowerCase() ?? '';
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(name)) return 'claude';
  if (/gpt|codex/.test(name)) return 'gpt';
  if (/gemini|antigravity|\bagy\b/.test(name)) return 'gemini';
  return null;
}

/* ── Below this point is browser-only wiring (manually verified) ────────── */

declare const window: Window & typeof globalThis;

class Api {
  listConversations = () => this.get<{ conversations: ConversationDTO[] }>('/api/conversations');
  createConversation = (title: string) => this.post('/api/conversations', { title });
  deleteConversation = (id: string) => this.send('DELETE', `/api/conversations/${id}`);
  view = (id: string) => this.get<ViewDTO>(`/api/conversations/${id}`);
  say = (id: string, text: string) => this.post(`/api/conversations/${id}/say`, { author: 'user', text });

  private async get<T>(url: string): Promise<T | null> {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  }
  private post(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
    return this.send('POST', url, body);
  }
  private async send(method: string, url: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return { ok: res.ok && data.ok !== false, error: data.error };
  }
}

/** Delay before reconnecting a dropped SSE stream — long enough that a server
 *  restart or a deleted conversation can't spin a tight retry loop. */
const RECONNECT_DELAY_MS = 2000;

export interface StreamHandlers {
  onMessage: () => void;
  onActivity: (active: ActivityEntry[]) => void;
  onMissing: () => void;
  onDrop: () => void;
}

/** Read an SSE stream, parsing frames and dispatching by event type. Message
 *  frames trigger a transcript refetch; activity frames carry a full presence
 *  snapshot. Comment/keepalive frames (no data) are ignored. */
export async function streamEvents(id: string, lastEventId: number, signal: AbortSignal, handlers: StreamHandlers): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/conversations/${id}/events`, { headers: { 'Last-Event-ID': String(lastEventId) }, signal });
  } catch {
    handlers.onDrop();
    return;
  }
  if (res.status === 404) {
    handlers.onMissing();
    return;
  }
  if (!res.ok || !res.body) {
    handlers.onDrop();
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      break;
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      dispatchFrame(buf.slice(0, sep), handlers);
      buf = buf.slice(sep + 2);
    }
  }
  handlers.onDrop();
}

function dispatchFrame(frame: string, handlers: StreamHandlers): void {
  let event = 'message';
  let data = '';
  let hasData = false;
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      data += line.slice(5).trim();
      hasData = true;
    }
  }
  if (!hasData) return; // ': connected' and keepalive comments carry no data
  if (event === 'activity') {
    try {
      handlers.onActivity((JSON.parse(data) as { active: ActivityEntry[] }).active);
    } catch {
      /* ignore a malformed frame */
    }
  } else if (event === 'message') {
    handlers.onMessage();
  }
}

function main(doc: Document): void {
  void new App(doc).start();
}

export class App {
  private readonly api = new Api();
  private conversations: ConversationDTO[] = [];
  private conversationId: string | null = null;
  private renderedConvId: string | null = null;
  private view: ViewDTO | null = null;
  private activity: ActivityEntry[] = [];
  private activityHost: HTMLElement | null = null;
  private activityTimer: number | null = null;
  private sse: 'connected' | 'reconnecting' | 'disconnected' = 'disconnected';
  private sseAbort: AbortController | null = null;
  private sendError: string | null = null;
  private composerDraft = '';
  private readonly root: HTMLElement;
  private readonly live: HTMLElement;
  private readonly doc: Document;

  constructor(doc: Document) {
    this.doc = doc;
    this.root = doc.getElementById('app')!;
    this.live = doc.getElementById('live')!;
  }

  async start(): Promise<void> {
    await this.loadConversations();
    const first = this.conversations[0];
    if (first) await this.openConversation(first.id); // open straight into the first conversation, not an empty pane
  }

  private announce(message: string): void {
    this.live.textContent = message;
  }

  private async loadConversations(): Promise<void> {
    this.conversations = (await this.api.listConversations())?.conversations ?? [];
    this.render();
  }

  private async openConversation(id: string): Promise<void> {
    this.conversationId = id;
    this.composerDraft = '';
    this.sendError = null;
    this.clearActivity();
    this.sse = 'connected';
    await this.refresh(); // a single render, already reflecting the connected state
    if (this.conversationId === id && this.view) this.connect(id);
  }

  private connect(id: string): void {
    this.sseAbort?.abort(); // end any prior stream before opening a new one
    const controller = new AbortController();
    this.sseAbort = controller;
    void streamEvents(id, this.view?.cursor ?? 0, controller.signal, {
      onMessage: () => void this.refresh(),
      onActivity: (active) => this.onActivity(active),
      onMissing: () => this.clearMissingConversation(id),
      onDrop: () => this.onSseDrop(controller),
    });
  }

  private onSseDrop(controller: AbortController): void {
    if (controller.signal.aborted) return; // closed deliberately (switch/delete) — don't reconnect
    this.sse = 'reconnecting';
    this.render();
    const id = this.conversationId;
    if (!id) return;
    // Delay the retry so a server restart or a vanished conversation can't spin a
    // tight reconnect loop; skip if we switched away or aborted in the meantime.
    window.setTimeout(() => {
      if (!controller.signal.aborted && this.conversationId === id) this.connect(id);
    }, RECONNECT_DELAY_MS);
  }

  /** Presence frames update only the indicator, never a full re-render, so they
   *  never wipe an in-progress composer draft. */
  private onActivity(active: ActivityEntry[]): void {
    this.activity = active;
    this.fillActivity();
  }

  private clearActivity(): void {
    this.activity = [];
    this.ensureActivityTimer();
  }

  private async refresh(): Promise<void> {
    if (!this.conversationId) return;
    const id = this.conversationId;
    const view = await this.api.view(id);
    if (!view) return this.clearMissingConversation(id);
    this.view = view;
    this.render();
  }

  private clearMissingConversation(id: string): void {
    if (this.conversationId !== id) return;
    this.sseAbort?.abort();
    this.sseAbort = null;
    this.sse = 'disconnected';
    this.conversationId = null;
    this.composerDraft = '';
    this.view = null;
    this.clearActivity();
    this.announce('Conversation no longer exists.');
    void this.loadConversations();
  }

  /* ── Rendering ── */

  /** A full re-render tears down the scroll container, so capture the reader's
   *  place first: stay pinned to the bottom (the chat default) unless they've
   *  scrolled up within the *same* conversation to read history. */
  private render(): void {
    const log = this.root.querySelector<HTMLElement>('.chat__log');
    const keepPosition = log !== null && this.renderedConvId === this.conversationId && !atBottom(log);
    const prevTop = log?.scrollTop ?? 0;

    this.root.setAttribute('aria-busy', 'false');
    this.root.textContent = '';
    this.activityHost = null; // rebuilt by renderChat when a conversation is open
    const app = el(this.doc, 'div', 'app');
    app.appendChild(this.renderSidebar());
    app.appendChild(this.renderMain());
    this.root.appendChild(app);
    this.renderedConvId = this.conversationId;

    const newLog = this.root.querySelector<HTMLElement>('.chat__log');
    if (newLog) newLog.scrollTop = keepPosition ? prevTop : newLog.scrollHeight;
  }

  private renderSidebar(): HTMLElement {
    const aside = el(this.doc, 'aside', 'sidebar');
    const scroll = el(this.doc, 'div', 'sidebar__scroll');
    scroll.appendChild(el(this.doc, 'div', 'sidebar__title', 'Conversations'));
    for (const conv of this.conversations) {
      const row = el(this.doc, 'div', 'nav-row');
      const item = el(this.doc, 'button', 'nav-item', conv.title) as HTMLButtonElement;
      item.setAttribute('aria-current', String(conv.id === this.conversationId));
      if (conv.readOnly) item.appendChild(el(this.doc, 'span', 'badge badge--readonly', 'read-only'));
      item.onclick = () => void this.openConversation(conv.id);
      const del = el(this.doc, 'button', 'nav-row__del', '✕') as HTMLButtonElement;
      del.type = 'button';
      del.title = 'Delete this conversation';
      del.setAttribute('aria-label', `Delete ${conv.title}`);
      del.onclick = () => void this.deleteConversation(conv);
      row.append(item, del);
      scroll.appendChild(row);
    }
    const create = el(this.doc, 'button', 'nav-item nav-item--add', '+ New conversation') as HTMLButtonElement;
    create.onclick = () => void this.createConversation();
    scroll.appendChild(create);
    aside.appendChild(scroll);
    return aside;
  }

  private renderMain(): HTMLElement {
    if (this.conversationId && this.view) return this.renderChat(this.view);
    const main = el(this.doc, 'section', 'chat');
    main.appendChild(emptyState(this.doc, 'No conversation open', 'Select or create a conversation. Any local HTTP client can post here as any author.'));
    return main;
  }

  private renderChat(view: ViewDTO): HTMLElement {
    const main = el(this.doc, 'section', 'chat');
    main.appendChild(this.renderHeader());
    if (view.readOnly) main.appendChild(el(this.doc, 'div', 'banner banner--warn', 'Conversation storage limit reached — read-only.'));
    if (this.sse === 'reconnecting') main.appendChild(el(this.doc, 'div', 'banner banner--info', 'Reconnecting to live updates…'));

    const log = el(this.doc, 'div', 'chat__log');
    log.setAttribute('role', 'log');
    for (const event of view.events) log.appendChild(this.renderEvent(event));
    main.appendChild(log);

    this.activityHost = el(this.doc, 'div', 'activity-host');
    this.activityHost.setAttribute('aria-live', 'polite');
    main.appendChild(this.activityHost);
    this.fillActivity();

    main.appendChild(this.renderComposer(view));
    return main;
  }

  /** Surgically (re)fill the presence indicator from current state, and keep a
   *  timer running so elapsed time ticks up during a long, quiet task. */
  private fillActivity(): void {
    const host = this.activityHost;
    if (!host) return;
    host.textContent = '';
    for (const a of this.activity) {
      const row = el(this.doc, 'div', 'activity');
      row.appendChild(el(this.doc, 'span', 'activity__who', `${a.author} · ${a.state}`));
      const dots = el(this.doc, 'span', 'activity__dots');
      for (let i = 0; i < 3; i++) dots.appendChild(this.doc.createElement('span'));
      row.appendChild(dots);
      const elapsed = elapsedLabel(a.since);
      if (elapsed) row.appendChild(el(this.doc, 'span', 'activity__elapsed', elapsed));
      host.appendChild(row);
    }
    this.ensureActivityTimer();
  }

  private ensureActivityTimer(): void {
    if (this.activity.length && this.activityTimer === null) {
      this.activityTimer = window.setInterval(() => this.fillActivity(), 15000);
    } else if (!this.activity.length && this.activityTimer !== null) {
      window.clearInterval(this.activityTimer);
      this.activityTimer = null;
    }
  }

  private renderHeader(): HTMLElement {
    const header = el(this.doc, 'div', 'chat__header');
    const conv = this.conversations.find((c) => c.id === this.conversationId);
    header.appendChild(el(this.doc, 'h1', 'chat__title', conv?.title ?? 'Conversation'));
    const id = this.conversationId;
    if (id) {
      const copy = el(this.doc, 'button', 'chat__copy', `⧉ ${id}`) as HTMLButtonElement;
      copy.type = 'button';
      copy.title = 'Copy this conversation id — paste it to an agent to let it join';
      copy.onclick = () => void this.copyId(copy, id);
      header.appendChild(copy);
    }
    return header;
  }

  private async copyId(btn: HTMLButtonElement, id: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(id);
      btn.textContent = '✓ Copied';
      this.announce('Conversation id copied.');
      window.setTimeout(() => (btn.textContent = `⧉ ${id}`), 1200);
    } catch {
      this.announce('Copy failed — select the id and copy manually.');
    }
  }

  private renderEvent(event: EventDTO): HTMLElement {
    if (event.type === 'system') {
      const box = el(this.doc, 'article', 'msg msg--system');
      const body = el(this.doc, 'div', 'msg__body');
      if (event.content) body.appendChild(renderContent(event.content, this.doc));
      box.appendChild(body);
      return box;
    }
    const isUser = event.author === 'user';
    const accent = isUser ? null : agentAccent(event.author);
    const box = el(this.doc, 'article', `msg ${isUser ? 'msg--user' : 'msg--agent'}${accent ? ` msg--${accent}` : ''}`);
    box.appendChild(el(this.doc, 'div', 'msg__role', event.author ?? 'agent'));
    const body = el(this.doc, 'div', 'msg__body');
    if (event.content) body.appendChild(renderContent(event.content, this.doc));
    box.appendChild(body);
    return box;
  }

  private renderComposer(view: ViewDTO): HTMLElement {
    const composer = el(this.doc, 'div', 'composer');
    const state = composerState({ hasConversation: !!this.conversationId, readOnly: view.readOnly });

    const boxRow = el(this.doc, 'div', 'composer__box');
    const textarea = this.doc.createElement('textarea');
    textarea.className = 'composer__input';
    textarea.rows = 1;
    textarea.setAttribute('aria-label', 'Message');
    textarea.disabled = state.disabled;
    textarea.placeholder = state.disabled ? (state.reason ?? '') : 'Message the room…';
    textarea.value = this.composerDraft;
    textarea.oninput = () => (this.composerDraft = textarea.value);

    const btn = el(this.doc, 'button', 'composer__btn', '↑') as HTMLButtonElement;
    btn.setAttribute('aria-label', 'Send');
    btn.disabled = state.disabled;
    btn.onclick = () => void this.onSend(textarea);

    textarea.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      if (e.isComposing) return;
      if (e.altKey) {
        e.preventDefault();
        insertNewline(textarea); // Alt+Enter inserts a newline
        this.composerDraft = textarea.value;
      } else if (!e.shiftKey) {
        e.preventDefault(); // Enter sends; Shift+Enter keeps the native newline
        if (!state.disabled) void this.onSend(textarea);
      }
    };

    boxRow.append(textarea, btn);
    composer.appendChild(boxRow);
    composer.appendChild(el(this.doc, 'div', 'field-error', this.sendError ?? ''));
    return composer;
  }

  /* ── Actions ── */

  private async onSend(textarea: HTMLTextAreaElement): Promise<void> {
    const text = textarea.value;
    this.composerDraft = text;
    if (!text.trim() || !this.conversationId) return;
    const result = await this.api.say(this.conversationId, text);
    if (result.ok) {
      this.composerDraft = '';
      this.sendError = null;
      this.announce('Message sent.');
      await this.refresh();
    } else {
      this.sendError = result.error ?? 'Message rejected.';
      this.render();
    }
  }

  private async createConversation(): Promise<void> {
    const title = window.prompt('Conversation title:') ?? 'Untitled';
    const result = await this.api.createConversation(title);
    if (result.ok) await this.loadConversations();
  }

  private async deleteConversation(conv: ConversationDTO): Promise<void> {
    if (!window.confirm(`Delete "${conv.title}"? This permanently removes its transcript.`)) return;
    const result = await this.api.deleteConversation(conv.id);
    if (!result.ok) {
      this.announce('Delete failed.');
      return;
    }
    if (this.conversationId === conv.id) {
      this.sseAbort?.abort(); // close the live stream to the now-deleted conversation
      this.conversationId = null;
      this.composerDraft = '';
      this.view = null;
      this.clearActivity();
    }
    this.announce('Conversation deleted.');
    await this.loadConversations();
  }
}

function el(doc: Document, tag: string, className?: string, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Whether the log is scrolled to (or within a hair of) the bottom; the small
 *  tolerance absorbs fractional pixels from zoom / high-DPI displays. */
function atBottom(log: HTMLElement): boolean {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 4;
}

function emptyState(doc: Document, title: string, body: string): HTMLElement {
  const box = el(doc, 'div', 'empty');
  box.appendChild(el(doc, 'h2', undefined, title));
  box.appendChild(el(doc, 'p', 'notice', body));
  return box;
}

/** "· Nm" once a presence has lasted at least a minute, else empty. */
function elapsedLabel(since: string): string {
  const ms = Date.now() - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 60000) return '';
  return `· ${Math.floor(ms / 60000)}m`;
}

/** Insert a newline at the caret (Alt+Enter; the browser would not by default). */
function insertNewline(ta: HTMLTextAreaElement): void {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = `${ta.value.slice(0, start)}\n${ta.value.slice(end)}`;
  ta.selectionStart = ta.selectionEnd = start + 1;
}

if (typeof document !== 'undefined') main(document);
