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

interface SidebarFocus {
  action: string;
  conversationId: string | null;
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

/* ── Below this point is browser-only wiring ───────────────────────────── */

declare const window: Window & typeof globalThis;

class Api {
  listConversations = () => this.get<{ conversations: ConversationDTO[] }>('/api/conversations');
  createConversation = (title: string) => this.post('/api/conversations', { title });
  deleteConversation = (id: string) => this.send('DELETE', `/api/conversations/${id}`);
  view = async (id: string): Promise<ViewDTO | null> => {
    const url = `/api/conversations/${id}`;
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${url} failed`);
    return (await res.json()) as ViewDTO;
  };
  say = (id: string, text: string) => this.post(`/api/conversations/${id}/say`, { author: 'user', text });

  private async get<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} failed`);
    return (await res.json()) as T;
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
  onOpen?: () => void;
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
  handlers.onOpen?.();
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
  private jumpToBottomButton: HTMLButtonElement | null = null;
  private activityTimer: number | null = null;
  private sse: 'connected' | 'reconnecting' | 'disconnected' = 'disconnected';
  private sseAbort: AbortController | null = null;
  private conversationEpoch = 0;
  private refreshSeq = 0;
  private appliedRefreshSeq = 0;
  private listSeq = 0;
  private readonly removedConversationIds = new Set<string>();
  private sendError: string | null = null;
  private composerDraft = '';
  private composerVersion = 0;
  private readonly sendingByConversation = new Map<string, number>();
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
    const seq = ++this.listSeq;
    let result: { conversations: ConversationDTO[] };
    try {
      result = await this.api.listConversations();
    } catch {
      return;
    }
    if (seq !== this.listSeq) return;
    this.conversations = result.conversations.filter((conv) => !this.removedConversationIds.has(conv.id));
    if (this.renderedConvId === this.conversationId && this.updateRenderedSidebar()) return;
    this.renderFull();
  }

  private async openConversation(id: string): Promise<void> {
    if (id === this.conversationId && this.view && this.renderedConvId === id) {
      await this.refresh();
      if (this.conversationId === id && this.view && (!this.sseAbort || this.sse !== 'connected')) this.connect(id);
      return;
    }
    this.sseAbort?.abort();
    this.sseAbort = null;
    this.conversationId = id;
    this.conversationEpoch++;
    const epoch = this.conversationEpoch;
    this.view = null;
    this.renderedConvId = null;
    this.composerDraft = '';
    this.composerVersion++;
    this.sendError = null;
    this.clearActivity();
    this.sse = 'connected';
    this.render();
    await this.refresh();
    if (this.conversationId !== id || this.conversationEpoch !== epoch) return;
    if (this.view) this.connect(id);
    else this.retryOpen(id, epoch);
  }

  private retryOpen(id: string, epoch: number): void {
    this.sse = 'reconnecting';
    this.render();
    window.setTimeout(() => {
      void this.retryOpenNow(id, epoch);
    }, RECONNECT_DELAY_MS);
  }

  private async retryOpenNow(id: string, epoch: number): Promise<void> {
    if (this.conversationId !== id || this.conversationEpoch !== epoch || this.view) return;
    await this.refresh();
    if (this.conversationId !== id || this.conversationEpoch !== epoch) return;
    if (this.view) this.connect(id);
    else this.retryOpen(id, epoch);
  }

  private connect(id: string): void {
    this.sseAbort?.abort(); // end any prior stream before opening a new one
    const controller = new AbortController();
    this.sseAbort = controller;
    void streamEvents(id, this.view?.cursor ?? 0, controller.signal, {
      onOpen: () => {
        if (controller.signal.aborted || this.sseAbort !== controller || this.conversationId !== id) return;
        this.sse = 'connected';
        this.render();
      },
      onMessage: () => {
        if (!controller.signal.aborted && this.conversationId === id) void this.refresh();
      },
      onActivity: (active) => {
        if (!controller.signal.aborted && this.conversationId === id) this.onActivity(active);
      },
      onMissing: () => {
        if (!controller.signal.aborted && this.sseAbort === controller && this.conversationId === id) this.clearMissingConversation(id);
      },
      onDrop: () => this.onSseDrop(controller),
    });
  }

  private onSseDrop(controller: AbortController): void {
    if (controller.signal.aborted || this.sseAbort !== controller) return; // closed deliberately (switch/delete) — don't reconnect
    this.sse = 'reconnecting';
    this.render();
    const id = this.conversationId;
    if (!id) return;
    // Delay the retry so a server restart or a vanished conversation can't spin a
    // tight reconnect loop; skip if we switched away or aborted in the meantime.
    window.setTimeout(() => {
      if (!controller.signal.aborted && this.sseAbort === controller && this.conversationId === id) this.connect(id);
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
    const epoch = this.conversationEpoch;
    const seq = ++this.refreshSeq;
    let view: ViewDTO | null;
    try {
      view = await this.api.view(id);
    } catch {
      return;
    }
    if (this.conversationId !== id) return;
    if (this.conversationEpoch !== epoch) return;
    if (!view) {
      if (seq < this.appliedRefreshSeq) return;
      return this.clearMissingConversation(id);
    }
    if (this.view) {
      if (view.cursor < this.view.cursor) return;
      if (view.cursor === this.view.cursor && this.view.readOnly && !view.readOnly) return;
      if (seq < this.appliedRefreshSeq && view.cursor === this.view.cursor) {
        if (view.readOnly && !this.view.readOnly) {
          this.view = { ...this.view, readOnly: true };
          this.render();
        }
        return;
      }
    }
    this.view = view;
    this.appliedRefreshSeq = Math.max(this.appliedRefreshSeq, seq);
    this.render();
  }

  private clearMissingConversation(id: string): void {
    if (this.conversationId !== id) return;
    this.sseAbort?.abort();
    this.sseAbort = null;
    this.sse = 'disconnected';
    this.conversationId = null;
    this.removeConversation(id);
    this.composerDraft = '';
    this.composerVersion++;
    this.view = null;
    this.clearActivity();
    this.announce('Conversation no longer exists.');
    this.render();
    void this.loadConversations();
  }

  /* ── Rendering ── */

  private render(): void {
    if (this.conversationId && this.view && this.renderedConvId === this.conversationId) {
      if (this.updateRenderedChat(this.view)) return;
    }
    this.renderFull();
  }

  /** A full re-render is only for structural changes such as opening a
   *  conversation. Live updates reuse the existing composer textarea. */
  private renderFull(): void {
    const log = this.root.querySelector<HTMLElement>('.chat__log');
    const sidebarScroll = this.root.querySelector<HTMLElement>('.sidebar__scroll');
    const sameConversation = this.renderedConvId === this.conversationId;
    const keepPosition = log !== null && sameConversation && !atBottom(log);
    const prevTop = log?.scrollTop ?? 0;
    const prevSidebarTop = sidebarScroll?.scrollTop ?? 0;

    this.root.setAttribute('aria-busy', 'false');
    this.root.textContent = '';
    this.activityHost = null; // rebuilt by renderChat when a conversation is open
    this.jumpToBottomButton = null;
    const app = el(this.doc, 'div', 'app');
    app.appendChild(this.renderSidebar());
    app.appendChild(this.renderMain());
    this.root.appendChild(app);
    this.renderedConvId = this.conversationId;

    const newLog = this.root.querySelector<HTMLElement>('.chat__log');
    const newSidebarScroll = this.root.querySelector<HTMLElement>('.sidebar__scroll');
    if (newLog) {
      newLog.scrollTop = keepPosition ? prevTop : newLog.scrollHeight;
      this.updateJumpToBottom(newLog);
    }
    if (newSidebarScroll && sameConversation) newSidebarScroll.scrollTop = prevSidebarTop;
  }

  private updateRenderedChat(view: ViewDTO): boolean {
    const banners = this.root.querySelector<HTMLElement>('.chat__banners');
    const log = this.root.querySelector<HTMLElement>('.chat__log');
    const messages = this.root.querySelector<HTMLElement>('.chat__messages');
    if (!banners || !log || !messages) return false;

    const keepPosition = !atBottom(log);
    const prevTop = log.scrollTop;
    this.fillBanners(banners, view);
    this.fillMessages(messages, view.events);
    this.updateComposer(view);
    this.fillActivity();
    log.scrollTop = keepPosition ? prevTop : log.scrollHeight;
    this.updateJumpToBottom(log);
    return true;
  }

  private renderSidebar(): HTMLElement {
    const aside = el(this.doc, 'aside', 'sidebar');
    const scroll = el(this.doc, 'div', 'sidebar__scroll');
    this.fillSidebar(scroll);
    aside.appendChild(scroll);
    return aside;
  }

  private updateRenderedSidebar(): boolean {
    const scroll = this.root.querySelector<HTMLElement>('.sidebar__scroll');
    if (!scroll) return false;
    const focused = this.sidebarFocus();
    const scrollTop = scroll.scrollTop;
    scroll.textContent = '';
    this.fillSidebar(scroll);
    scroll.scrollTop = scrollTop;
    this.restoreSidebarFocus(focused);

    const title = this.root.querySelector<HTMLElement>('.chat__title');
    const conv = this.conversations.find((c) => c.id === this.conversationId);
    if (title) title.textContent = conv?.title ?? 'Conversation';
    return true;
  }

  private fillSidebar(scroll: HTMLElement): void {
    scroll.appendChild(el(this.doc, 'div', 'sidebar__title', 'Conversations'));
    for (const conv of this.conversations) {
      const row = el(this.doc, 'div', 'nav-row');
      const item = el(this.doc, 'button', 'nav-item', conv.title) as HTMLButtonElement;
      item.setAttribute('aria-current', String(conv.id === this.conversationId));
      item.setAttribute('data-sidebar-action', 'open');
      item.setAttribute('data-conversation-id', conv.id);
      if (conv.readOnly) item.appendChild(el(this.doc, 'span', 'badge badge--readonly', 'read-only'));
      item.onclick = () => void this.openConversation(conv.id);
      const del = el(this.doc, 'button', 'nav-row__del', '✕') as HTMLButtonElement;
      del.type = 'button';
      del.title = 'Delete this conversation';
      del.setAttribute('aria-label', `Delete ${conv.title}`);
      del.setAttribute('data-sidebar-action', 'delete');
      del.setAttribute('data-conversation-id', conv.id);
      del.onclick = () => void this.deleteConversation(conv);
      row.append(item, del);
      scroll.appendChild(row);
    }
    const create = el(this.doc, 'button', 'nav-item nav-item--add', '+ New conversation') as HTMLButtonElement;
    create.setAttribute('data-sidebar-action', 'create');
    create.onclick = () => void this.createConversation();
    scroll.appendChild(create);
  }

  private sidebarFocus(): SidebarFocus | null {
    const active = this.doc.activeElement;
    if (!active) return null;
    const action = active.getAttribute('data-sidebar-action');
    return action ? { action, conversationId: active.getAttribute('data-conversation-id') } : null;
  }

  private restoreSidebarFocus(focus: SidebarFocus | null): void {
    if (!focus) return;
    const id = focus.conversationId;
    const selector = id ? `[data-sidebar-action="${focus.action}"][data-conversation-id="${id}"]` : `[data-sidebar-action="${focus.action}"]`;
    this.root.querySelector<HTMLElement>(selector)?.focus();
  }

  private renderMain(): HTMLElement {
    if (this.conversationId && this.view) return this.renderChat(this.view);
    const main = el(this.doc, 'section', 'chat');
    if (this.conversationId) {
      main.appendChild(emptyState(this.doc, this.sse === 'reconnecting' ? 'Reconnecting' : 'Loading conversation', ''));
    } else {
      main.appendChild(emptyState(this.doc, 'No conversation open', 'Select or create a conversation. Any local HTTP client can post here as any author.'));
    }
    return main;
  }

  private renderChat(view: ViewDTO): HTMLElement {
    const main = el(this.doc, 'section', 'chat');
    main.appendChild(this.renderHeader());

    const banners = el(this.doc, 'div', 'chat__banners');
    this.fillBanners(banners, view);
    main.appendChild(banners);

    const log = el(this.doc, 'div', 'chat__log');
    log.onscroll = () => this.updateJumpToBottom(log);
    const messages = el(this.doc, 'div', 'chat__messages');
    messages.setAttribute('role', 'log');
    this.fillMessages(messages, view.events);
    log.appendChild(messages);

    const dock = el(this.doc, 'div', 'chat__dock');
    dock.appendChild(this.renderJumpToBottom(log));
    this.activityHost = el(this.doc, 'div', 'activity-host');
    this.activityHost.setAttribute('aria-live', 'polite');
    dock.appendChild(this.activityHost);
    this.fillActivity();

    dock.appendChild(this.renderComposer(view));
    log.appendChild(dock);
    main.appendChild(log);
    return main;
  }

  private fillMessages(messages: HTMLElement, events: EventDTO[]): void {
    const existing = Array.from(messages.children) as HTMLElement[];
    const appendOnly =
      existing.length <= events.length && existing.every((node, index) => node.getAttribute('data-event-id') === events[index]?.id);
    if (appendOnly) {
      for (const event of events.slice(existing.length)) messages.appendChild(this.renderEvent(event));
      return;
    }
    messages.textContent = '';
    for (const event of events) messages.appendChild(this.renderEvent(event));
  }

  private renderJumpToBottom(log: HTMLElement): HTMLButtonElement {
    const button = el(this.doc, 'button', 'jump-bottom', '↓') as HTMLButtonElement;
    button.type = 'button';
    button.hidden = true;
    button.title = 'Scroll to bottom';
    button.setAttribute('aria-label', 'Scroll to bottom');
    button.onclick = () => {
      log.scrollTop = log.scrollHeight;
      this.updateJumpToBottom(log);
    };
    this.jumpToBottomButton = button;
    return button;
  }

  private updateJumpToBottom(log: HTMLElement): void {
    const button = this.jumpToBottomButton;
    if (button) button.hidden = atBottom(log);
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

  private fillBanners(host: HTMLElement, view: ViewDTO): void {
    host.textContent = '';
    if (view.readOnly) {
      host.appendChild(el(this.doc, 'div', 'banner banner--warn', 'Conversation storage limit reached — read-only.'));
    }
    if (this.sse === 'reconnecting') {
      host.appendChild(el(this.doc, 'div', 'banner banner--info', 'Reconnecting to live updates…'));
    }
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
      box.setAttribute('data-event-id', event.id);
      const body = el(this.doc, 'div', 'msg__body');
      if (event.content) body.appendChild(renderContent(event.content, this.doc));
      box.appendChild(body);
      return box;
    }
    const isUser = event.author === 'user';
    const accent = isUser ? null : agentAccent(event.author);
    const box = el(this.doc, 'article', `msg ${isUser ? 'msg--user' : 'msg--agent'}${accent ? ` msg--${accent}` : ''}`);
    box.setAttribute('data-event-id', event.id);
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
    textarea.placeholder = state.disabled ? (state.reason ?? '') : 'Type a message...';
    textarea.value = this.composerDraft;
    textarea.oninput = () => {
      this.composerDraft = textarea.value;
      this.composerVersion++;
    };

    const btn = el(this.doc, 'button', 'composer__btn', '↑') as HTMLButtonElement;
    btn.setAttribute('aria-label', 'Send');
    btn.disabled = state.disabled || this.isSendingCurrentConversation();
    btn.onclick = () => void this.onSend(textarea);

    textarea.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      if (e.isComposing) return;
      if (e.altKey) {
        e.preventDefault();
        insertNewline(textarea); // Alt+Enter inserts a newline
        this.composerDraft = textarea.value;
        this.composerVersion++;
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

  private updateComposer(view: ViewDTO): void {
    const state = composerState({ hasConversation: !!this.conversationId, readOnly: view.readOnly });
    const textarea = this.root.querySelector<HTMLTextAreaElement>('.composer__input');
    const button = this.root.querySelector<HTMLButtonElement>('.composer__btn');
    const error = this.root.querySelector<HTMLElement>('.field-error');
    if (textarea) {
      textarea.disabled = state.disabled;
      textarea.placeholder = state.disabled ? (state.reason ?? '') : 'Type a message...';
    }
    if (button) button.disabled = state.disabled || this.isSendingCurrentConversation();
    if (error) error.textContent = this.sendError ?? '';
  }

  private isSendingCurrentConversation(): boolean {
    return this.conversationId !== null && this.sendingByConversation.get(this.conversationId) === this.conversationEpoch;
  }

  private isCurrentConversation(id: string, epoch: number): boolean {
    return this.conversationId === id && this.conversationEpoch === epoch;
  }

  /* ── Actions ── */

  private async onSend(textarea: HTMLTextAreaElement): Promise<void> {
    if (this.root.querySelector<HTMLTextAreaElement>('.composer__input') !== textarea) return;
    const text = textarea.value;
    this.composerDraft = text;
    if (!text.trim() || !this.conversationId) return;
    const id = this.conversationId;
    const epoch = this.conversationEpoch;
    if (this.sendingByConversation.get(id) === epoch) return;
    const version = this.composerVersion;
    this.sendingByConversation.set(id, epoch);
    if (this.view) this.updateComposer(this.view);
    let result: { ok: boolean; error?: string };
    try {
      result = await this.api.say(id, text);
    } catch {
      if (this.isCurrentConversation(id, epoch)) {
        this.sendError = 'Send failed. Check your connection and try again.';
        this.render();
      }
      return;
    } finally {
      if (this.sendingByConversation.get(id) === epoch) {
        this.sendingByConversation.delete(id);
        if (this.view && this.conversationId === id) this.updateComposer(this.view);
      }
    }
    if (!this.isCurrentConversation(id, epoch)) {
      return;
    }
    const currentTextarea = this.root.querySelector<HTMLTextAreaElement>('.composer__input');
    if (result.ok) {
      if (this.composerVersion === version && currentTextarea?.value === text) {
        this.composerDraft = '';
        currentTextarea.value = '';
        this.composerVersion++;
      } else if (currentTextarea) {
        this.composerDraft = currentTextarea.value;
      }
      this.sendError = null;
      this.announce('Message sent.');
      await this.refresh();
    } else {
      this.sendError = result.error ?? 'Message rejected.';
      this.render();
      await this.refresh();
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
    this.removeConversation(conv.id);
    if (this.conversationId === conv.id) {
      this.sseAbort?.abort(); // close the live stream to the now-deleted conversation
      this.conversationId = null;
      this.composerDraft = '';
      this.composerVersion++;
      this.view = null;
      this.clearActivity();
      this.render();
    } else if (this.renderedConvId === this.conversationId) {
      this.updateRenderedSidebar();
    }
    this.announce('Conversation deleted.');
    void this.loadConversations();
  }

  private removeConversation(id: string): void {
    this.removedConversationIds.add(id);
    this.conversations = this.conversations.filter((conv) => conv.id !== id);
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
  if (body) box.appendChild(el(doc, 'p', 'notice', body));
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
