import { ConversationApi, RECONNECT_DELAY_MS, streamEvents, streamProjectEvents } from './client.ts';
import type { ActivityEntry, AgentConfigInput, AgentDto, AgentKind, ConversationDTO, EventDTO, ProjectDTO, ViewDTO } from './client.ts';
import { AGENT_KIND_META, fillAgentRoster, isAgentEditable, readConfigDraft, renderAgentBar, syncAgentAddButton, syncAgentMenu, type AgentBarActions, type AgentBarState, type AgentConfigDraft } from './agent-bar.ts';
import { renderContent } from './render-content.ts';
import { agentAccent, composerState, el } from './ui-state.ts';

interface SidebarFocus {
  action: string;
  conversationId: string | null;
  projectId: string | null;
}

/** Which popover config control holds focus, and any text selection within it, so a
 *  surgical roster rebuild mid-edit can put the caret back where the user left it. */
interface PopoverFocus {
  field: string;
  selStart: number | null;
  selEnd: number | null;
}

declare const window: Window & typeof globalThis;

/** Foreground heartbeat cadence: far below the server's inactivity window, so
 *  ordinary scheduling jitter can never cause a spurious stop while the page is watched. */
const HEARTBEAT_INTERVAL_MS = 10_000;

function main(doc: Document): void {
  void new App(doc).start();
}

export class App {
  private readonly api = new ConversationApi();
  private projects: ProjectDTO[] = [];
  private conversationId: string | null = null;
  private renderedConvId: string | null = null;
  private view: ViewDTO | null = null;
  private activity: ActivityEntry[] = [];
  private activityHost: HTMLElement | null = null;
  private agents: AgentDto[] = [];
  private agentsHost: HTMLElement | null = null;
  private tmuxAvailable = false;
  private agentMenuOpen = false;
  private agentMenuConfigKind: AgentKind | null = null;
  private agentMenuDismiss: ((e: Event) => void) | null = null;
  private openPopoverId: string | null = null;
  private agentPopoverDraft: AgentConfigDraft | null = null;
  private agentPopoverDismiss: ((e: Event) => void) | null = null;
  private jumpToBottomButton: HTMLButtonElement | null = null;
  private activityTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private sse: 'connected' | 'reconnecting' | 'disconnected' = 'disconnected';
  private sseAbort: AbortController | null = null;
  private projectSseAbort: AbortController | null = null;
  private conversationEpoch = 0;
  private refreshSeq = 0;
  private appliedRefreshSeq = 0;
  private agentRefreshSeq = 0;
  private listSeq = 0;
  private readonly removedConversationIds = new Set<string>();
  private readonly collapsedProjects = new Set<string>();
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
    // Foreground-view heartbeats keep browser-launched agents alive only while this
    // tab is actually being watched; recompute eligibility whenever that changes.
    const sync = () => this.syncHeartbeat();
    this.doc.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    await this.loadProjects();
    this.connectProjectEvents();
    const first = this.firstConversation();
    if (first) await this.openConversation(first.id); // open straight into the first conversation, not an empty pane
  }

  /** The server counts a foreground heartbeat as activity only while the document is
   *  visible and the window is focused; a background tab or blurred window sends none. */
  private foregroundActive(): boolean {
    return !!this.conversationId && this.doc.visibilityState === 'visible' && this.doc.hasFocus();
  }

  /** Start, stop, or re-target the ~10s heartbeat loop to match the current
   *  conversation and foreground state; sends immediately so a switch resets promptly. */
  private syncHeartbeat(): void {
    if (this.foregroundActive()) {
      this.heartbeatTimer ??= window.setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
      this.sendHeartbeat();
    } else if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    const id = this.conversationId;
    if (id && this.foregroundActive()) void this.api.heartbeat(id).catch(() => {});
  }

  private announce(message: string): void {
    this.live.textContent = message;
  }

  private async loadProjects(expected?: { id: string; epoch: number }): Promise<void> {
    const seq = ++this.listSeq;
    let result: { projects: ProjectDTO[] };
    try {
      result = await this.api.listProjects();
    } catch {
      return;
    }
    if (seq !== this.listSeq || !Array.isArray(result?.projects)) return;
    if (expected && !this.isCurrentConversation(expected.id, expected.epoch)) return;
    this.projects = result.projects.map((project) => ({
      ...project,
      conversations: project.conversations.filter((conv) => !this.removedConversationIds.has(conv.id)),
    }));
    if (this.renderedConvId === this.conversationId && this.updateRenderedSidebar()) return;
    this.renderFull();
  }

  /** The most recently active conversation across all projects (the server orders
   *  projects and their conversations by activity), or undefined when none exist. */
  private firstConversation(): ConversationDTO | undefined {
    for (const project of this.projects) {
      if (project.conversations[0]) return project.conversations[0];
    }
    return undefined;
  }

  private findConversation(id: string | null): ConversationDTO | undefined {
    if (id === null) return undefined;
    for (const project of this.projects) {
      const conv = project.conversations.find((c) => c.id === id);
      if (conv) return conv;
    }
    return undefined;
  }

  private async openConversation(id: string): Promise<void> {
    if (id === this.conversationId && this.view && this.renderedConvId === id) {
      await this.refresh();
      void this.refreshAgents(id);
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
    this.agents = [];
    this.setAgentMenu(false);
    this.resetPopover();
    this.sse = 'connected';
    this.render();
    this.syncHeartbeat(); // begin foreground heartbeats for the newly opened conversation
    void this.refreshAgents(id);
    await this.refresh();
    if (!this.isCurrentConversation(id, epoch)) return;
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
    if (!this.isCurrentConversation(id, epoch) || this.view) return;
    await this.refresh();
    if (!this.isCurrentConversation(id, epoch)) return;
    if (this.view) this.connect(id);
    else this.retryOpen(id, epoch);
  }

  private connect(id: string): void {
    this.sseAbort?.abort(); // end any prior stream before opening a new one
    const controller = new AbortController();
    const epoch = this.conversationEpoch;
    this.sseAbort = controller;
    void streamEvents(id, this.view?.cursor ?? 0, controller.signal, {
      onOpen: () => {
        if (controller.signal.aborted || this.sseAbort !== controller || !this.isCurrentConversation(id, epoch)) return;
        this.sse = 'connected';
        void this.refreshAgents(id);
        this.render();
      },
      onMessage: () => {
        if (!controller.signal.aborted && this.isCurrentConversation(id, epoch)) void this.refreshAfterMessage(id, epoch);
      },
      onActivity: (active) => {
        if (!controller.signal.aborted && this.isCurrentConversation(id, epoch)) this.onActivity(active);
      },
      onAgents: () => {
        if (!controller.signal.aborted && this.isCurrentConversation(id, epoch)) void this.refreshAgents(id);
      },
      onMissing: () => {
        if (!controller.signal.aborted && this.sseAbort === controller && this.isCurrentConversation(id, epoch)) this.clearMissingConversation(id);
      },
      onDrop: () => this.onSseDrop(controller),
    });
  }

  private connectProjectEvents(): void {
    this.projectSseAbort?.abort();
    const controller = new AbortController();
    this.projectSseAbort = controller;
    void streamProjectEvents(controller.signal, {
      onProjects: () => {
        if (!controller.signal.aborted && this.projectSseAbort === controller) void this.loadProjects();
      },
      onDrop: () => this.onProjectSseDrop(controller),
    });
  }

  private onProjectSseDrop(controller: AbortController): void {
    if (controller.signal.aborted || this.projectSseAbort !== controller) return;
    window.setTimeout(() => {
      if (!controller.signal.aborted && this.projectSseAbort === controller) this.connectProjectEvents();
    }, RECONNECT_DELAY_MS);
  }

  private onSseDrop(controller: AbortController): void {
    if (controller.signal.aborted || this.sseAbort !== controller) return; // closed deliberately (switch/delete); do not reconnect
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

  private async refresh(): Promise<boolean> {
    if (!this.conversationId) return false;
    const id = this.conversationId;
    const epoch = this.conversationEpoch;
    const seq = ++this.refreshSeq;
    let view: ViewDTO | null;
    try {
      view = await this.api.view(id);
    } catch {
      return false;
    }
    if (!this.isCurrentConversation(id, epoch)) return false;
    if (!view) {
      if (seq < this.appliedRefreshSeq) return false;
      this.clearMissingConversation(id);
      return true;
    }
    if (this.view) {
      if (view.cursor < this.view.cursor) return false;
      if (view.cursor === this.view.cursor && this.view.readOnly && !view.readOnly) return false;
      if (seq < this.appliedRefreshSeq && view.cursor === this.view.cursor) {
        if (view.readOnly && !this.view.readOnly) {
          this.view = { ...this.view, readOnly: true };
          this.render();
          return true;
        }
        return false;
      }
    }
    this.view = view;
    this.appliedRefreshSeq = Math.max(this.appliedRefreshSeq, seq);
    this.render();
    return true;
  }

  private async refreshAfterMessage(id: string, epoch: number): Promise<void> {
    if (await this.refresh() && this.isCurrentConversation(id, epoch)) await this.loadProjects({ id, epoch });
  }

  /** Tear down the active conversation's view + live stream, leaving no
   *  conversation open. The caller announces the reason and re-renders. */
  private detachConversation(): void {
    this.sseAbort?.abort();
    this.sseAbort = null;
    this.sse = 'disconnected';
    this.conversationId = null;
    this.composerDraft = '';
    this.composerVersion++;
    this.view = null;
    this.clearActivity();
    this.syncHeartbeat(); // no conversation open → stop heartbeating
    this.agents = [];
    this.agentsHost = null;
    this.setAgentMenu(false);
    this.resetPopover();
  }

  private clearMissingConversation(id: string): void {
    if (this.conversationId !== id) return;
    this.detachConversation();
    this.removeConversation(id);
    this.announce('Conversation no longer exists.');
    this.render();
    void this.loadProjects();
  }

  /* Rendering */

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
    const conv = this.findConversation(this.conversationId);
    if (title) title.textContent = conv?.title ?? 'Conversation';
    return true;
  }

  /** Render the sidebar: a top-level "+ Project" action, then one group per
   *  project with its conversations and an in-project "+ New conversation". With
   *  no projects, only the add-project action and an empty-state hint show; there
   *  is no way to create a conversation before a project exists. */
  private fillSidebar(scroll: HTMLElement): void {
    const add = el(this.doc, 'button', 'nav-item nav-item--add', '+ Project') as HTMLButtonElement;
    add.setAttribute('data-sidebar-action', 'add-project');
    add.onclick = () => void this.addProject();
    scroll.appendChild(add);

    if (this.projects.length === 0) {
      scroll.appendChild(el(this.doc, 'div', 'sidebar__empty', 'Add a project to start.'));
      return;
    }

    const labels = this.projectLabels();
    for (const project of this.projects) {
      scroll.appendChild(this.renderProjectGroup(project, labels.get(project.id) ?? project.title));
    }
  }

  private renderProjectGroup(project: ProjectDTO, label: string): HTMLElement {
    const collapsed = this.collapsedProjects.has(project.id);
    const group = el(this.doc, 'div', collapsed ? 'project project--collapsed' : 'project');
    const head = el(this.doc, 'div', 'project__head');

    const toggle = el(this.doc, 'button', 'project__title', label) as HTMLButtonElement;
    toggle.type = 'button';
    toggle.setAttribute('title', project.path); // hover reveals the full absolute path
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('data-sidebar-action', 'toggle-project');
    toggle.setAttribute('data-project-id', project.id);
    toggle.onclick = () => this.toggleProject(project.id);

    const remove = el(this.doc, 'button', 'project__del', '✕') as HTMLButtonElement;
    remove.type = 'button';
    remove.title = 'Remove this project from the list';
    remove.setAttribute('aria-label', `Remove project ${project.title}`);
    remove.setAttribute('data-sidebar-action', 'remove-project');
    remove.setAttribute('data-project-id', project.id);
    remove.onclick = () => void this.removeProject(project);

    head.append(toggle, remove);
    group.appendChild(head);
    if (collapsed) return group; // body hidden while collapsed

    for (const conv of project.conversations) group.appendChild(this.renderConversationRow(conv));
    const create = el(this.doc, 'button', 'nav-item nav-item--add', '+ New conversation') as HTMLButtonElement;
    create.setAttribute('data-sidebar-action', 'create');
    create.setAttribute('data-project-id', project.id);
    create.onclick = () => void this.createConversation(project.id);
    group.appendChild(create);
    return group;
  }

  /** Collapse or expand a project's conversation list. State is in-memory, keyed
   *  by project id, so it survives the sidebar's surgical re-renders. */
  private toggleProject(projectId: string): void {
    if (!this.collapsedProjects.delete(projectId)) this.collapsedProjects.add(projectId);
    this.updateRenderedSidebar();
  }

  private renderConversationRow(conv: ConversationDTO): HTMLElement {
    const row = el(this.doc, 'div', 'nav-row');
    const item = el(this.doc, 'button', 'nav-item') as HTMLButtonElement;
    item.appendChild(el(this.doc, 'span', 'nav-item__title', conv.title));
    const agentDots = this.renderSidebarAgentDots(conv.activeAgentKinds ?? []);
    if (agentDots) item.appendChild(agentDots);
    item.setAttribute('aria-current', String(conv.id === this.conversationId));
    item.setAttribute('data-sidebar-action', 'open');
    item.setAttribute('data-conversation-id', conv.id);
    if (conv.readOnly) item.appendChild(el(this.doc, 'span', 'badge badge--readonly', 'read-only'));
    item.onclick = () => void this.openConversation(conv.id);
    const rename = el(this.doc, 'button', 'nav-row__btn', '✎') as HTMLButtonElement;
    rename.type = 'button';
    rename.title = 'Rename this conversation';
    rename.setAttribute('aria-label', `Rename ${conv.title}`);
    rename.setAttribute('data-sidebar-action', 'rename');
    rename.setAttribute('data-conversation-id', conv.id);
    rename.onclick = () => void this.renameConversation(conv);
    const del = el(this.doc, 'button', 'nav-row__btn nav-row__del', '✕') as HTMLButtonElement;
    del.type = 'button';
    del.title = 'Delete this conversation';
    del.setAttribute('aria-label', `Delete ${conv.title}`);
    del.setAttribute('data-sidebar-action', 'delete');
    del.setAttribute('data-conversation-id', conv.id);
    del.onclick = () => void this.deleteConversation(conv);
    row.append(item, rename, del);
    return row;
  }

  private renderSidebarAgentDots(kinds: AgentKind[]): HTMLElement | null {
    if (kinds.length === 0) return null;
    const group = el(this.doc, 'span', 'sidebar-agent-dots');
    const label = `Active agents: ${kinds.map((kind) => AGENT_KIND_META[kind].label).join(', ')}`;
    group.title = label;
    group.setAttribute('aria-label', label);
    for (const kind of kinds) {
      const dot = el(this.doc, 'span', `sidebar-agent-dot accent-${AGENT_KIND_META[kind].accent}`);
      dot.setAttribute('aria-hidden', 'true');
      group.appendChild(dot);
    }
    return group;
  }

  /** Display label per project: the basename, or the last two path segments when
   *  two projects share a basename. The full path always lives in the hover title,
   *  so even deeper same-named paths stay distinguishable. */
  private projectLabels(): Map<string, string> {
    const byBasename = new Map<string, number>();
    for (const project of this.projects) byBasename.set(project.title, (byBasename.get(project.title) ?? 0) + 1);
    const labels = new Map<string, string>();
    for (const project of this.projects) {
      const ambiguous = (byBasename.get(project.title) ?? 0) > 1;
      labels.set(project.id, ambiguous ? lastTwoSegments(project.path) : project.title);
    }
    return labels;
  }

  private sidebarFocus(): SidebarFocus | null {
    const active = this.doc.activeElement;
    if (!active) return null;
    const action = active.getAttribute('data-sidebar-action');
    return action
      ? { action, conversationId: active.getAttribute('data-conversation-id'), projectId: active.getAttribute('data-project-id') }
      : null;
  }

  private restoreSidebarFocus(focus: SidebarFocus | null): void {
    if (!focus) return;
    let selector = `[data-sidebar-action="${focus.action}"]`;
    if (focus.conversationId) selector += `[data-conversation-id="${focus.conversationId}"]`;
    if (focus.projectId) selector += `[data-project-id="${focus.projectId}"]`;
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
      updateTimestamps(existing, events);
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
    const titleRow = el(this.doc, 'div', 'chat__titlerow');
    const conv = this.findConversation(this.conversationId);
    titleRow.appendChild(el(this.doc, 'h1', 'chat__title', conv?.title ?? 'Conversation'));
    const id = this.conversationId;
    if (id) {
      const copy = el(this.doc, 'button', 'chat__copy', `⧉ ${id}`) as HTMLButtonElement;
      copy.type = 'button';
      copy.title = 'Copy this conversation id — paste it to an agent to let it join';
      copy.onclick = () => void this.copyId(copy, id);
      titleRow.appendChild(copy);
    }
    header.appendChild(titleRow);
    if (id) header.appendChild(this.renderAgentBar(id));
    return header;
  }

  /** The control row beneath the title: the `+` add-agent button and the roster. */
  private renderAgentBar(conversationId: string): HTMLElement {
    const { bar, roster } = renderAgentBar(this.doc, this.agentBarState(conversationId), this.agentBarActions(conversationId));
    this.agentsHost = roster;
    return bar;
  }

  private agentBarState(conversationId: string): AgentBarState {
    return {
      conversationId,
      agents: this.agents,
      tmuxAvailable: this.tmuxAvailable,
      menuOpen: this.agentMenuOpen,
      menuConfigKind: this.agentMenuConfigKind,
      openPopoverId: this.openPopoverId,
      popoverDraft: this.agentPopoverDraft,
    };
  }

  private agentBarActions(conversationId: string): AgentBarActions {
    return {
      toggleMenu: () => this.setAgentMenu(!this.agentMenuOpen),
      addAgent: (kind) => void this.addAgent(conversationId, kind),
      configureKind: (kind) => this.setAgentMenuConfig(kind),
      cancelConfigure: () => this.setAgentMenuConfig(null),
      launchConfigured: (kind, config) => this.launchConfigured(conversationId, kind, config),
      togglePopover: (agent) => this.togglePopover(agent.instanceId),
      configureAgent: (agent, config) => void this.configureAgent(conversationId, agent.instanceId, config),
      copyAttach: (agent, button) => this.copyAttach(agent, button),
      stopAgent: (agent) => this.runAgentAction(conversationId, () => this.api.stopAgent(conversationId, agent.instanceId)),
      resumeAgent: (agent) => this.runAgentAction(conversationId, () => this.api.resumeAgent(conversationId, agent.instanceId)),
      removeAgent: (agent) => this.runAgentAction(conversationId, () => this.api.removeAgent(conversationId, agent.instanceId)),
      stopAgents: (agents) => this.runAgentBatch(conversationId, agents, (agent) => this.api.stopAgent(conversationId, agent.instanceId)),
      resumeAgents: (agents) => this.runAgentBatch(conversationId, agents, (agent) => this.api.resumeAgent(conversationId, agent.instanceId)),
      onActionError: () => {
        this.announce('Agent action failed.');
        void this.refreshAgents(conversationId);
      },
    };
  }

  /** Open or close the kind menu by class (CSP forbids inline style), wiring
   *  outside/Escape dismissal while open. Closing resets to the kind list. */
  private setAgentMenu(open: boolean): void {
    this.agentMenuOpen = open;
    if (!open) this.agentMenuConfigKind = null;
    const plus = this.root.querySelector<HTMLButtonElement>('.agentbar__plus');
    this.syncAgentMenu();
    plus?.setAttribute('aria-expanded', String(open));
    this.unbindDismiss(this.agentMenuDismiss);
    this.agentMenuDismiss = open
      ? this.bindDismiss('.agentbar__add', () => {
          this.setAgentMenu(false);
          plus?.focus();
        })
      : null;
  }

  /** Wire an outside-pointerdown / Escape dismissal, exempting clicks inside
   *  `exempt`. Returns the handler so the caller can later unbind it. */
  private bindDismiss(exempt: string, close: () => void): (e: Event) => void {
    const handler = (e: Event) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
      if (e.type === 'pointerdown' && (e.target as Element | null)?.closest(exempt)) return;
      close();
    };
    this.doc.addEventListener('pointerdown', handler);
    this.doc.addEventListener('keydown', handler);
    return handler;
  }

  private unbindDismiss(handler: ((e: Event) => void) | null): void {
    if (!handler) return;
    this.doc.removeEventListener('pointerdown', handler);
    this.doc.removeEventListener('keydown', handler);
  }

  /** Swap the open menu between the kind list and a kind's configured-launch form. */
  private setAgentMenuConfig(kind: AgentKind | null): void {
    this.agentMenuConfigKind = kind;
    this.syncAgentMenu();
  }

  private syncAgentMenu(): void {
    const conversationId = this.conversationId;
    if (!conversationId) return;
    syncAgentMenu(this.root, this.doc, this.agentBarState(conversationId), this.agentBarActions(conversationId));
  }

  private async addAgent(conversationId: string, kind: AgentKind): Promise<void> {
    this.setAgentMenu(false); // one-click launch: dismiss immediately so rapid adds stay fluid
    const res = await this.api.addAgent(conversationId, kind);
    if (!res.ok) this.announce(res.error ?? 'Could not add agent.'); // admission rejection: no record, no pill
    await this.refreshAgents(conversationId);
  }

  /** Configured launch: keep the form open with its values on failure so a filled
   *  form is never lost, and close the menu only once the record is admitted. */
  private async launchConfigured(conversationId: string, kind: AgentKind, config: AgentConfigInput): Promise<{ ok: boolean; error?: string }> {
    const res = await this.api.addAgent(conversationId, kind, config);
    if (res.ok) {
      this.setAgentMenu(false);
      this.announce(`${AGENT_KIND_META[kind].label} launching.`);
    }
    await this.refreshAgents(conversationId);
    return { ok: res.ok, error: res.error };
  }

  /** Toggle the agent's details popover (closing any other); focus moves into the
   *  panel on open, back to the trigger on close. */
  private togglePopover(instanceId: string): void {
    if (this.openPopoverId === instanceId) this.closePopover();
    else this.openPopover(instanceId);
  }

  private openPopover(instanceId: string): void {
    this.openPopoverId = instanceId;
    this.agentPopoverDraft = null;
    this.fillAgents();
    const panel = this.root.querySelector<HTMLElement>('.agent__popover');
    (panel?.querySelector<HTMLElement>('input:not([disabled]),select:not([disabled]),button:not([disabled])') ?? panel)?.focus();
    this.unbindDismiss(this.agentPopoverDismiss);
    // A click inside the open agent row (its trigger or panel) must not dismiss.
    this.agentPopoverDismiss = this.bindDismiss('.agent--popover-open', () => this.closePopover());
  }

  private closePopover(): void {
    const instanceId = this.openPopoverId;
    if (!instanceId) return;
    this.resetPopover();
    this.fillAgents();
    this.root.querySelector<HTMLElement>(`[data-agent-details="${instanceId}"]`)?.focus();
  }

  private resetPopover(): void {
    this.openPopoverId = null;
    this.agentPopoverDraft = null;
    this.unbindDismiss(this.agentPopoverDismiss);
    this.agentPopoverDismiss = null;
  }

  /** Snapshot unsaved popover input before a surgical roster rebuild, so typing
   *  survives a refresh while the agent stays editable (and is dropped otherwise). */
  private capturePopoverDraft(): void {
    if (!this.openPopoverId) {
      this.agentPopoverDraft = null;
      return;
    }
    const agent = this.agents.find((a) => a.instanceId === this.openPopoverId);
    const panel = this.root.querySelector<HTMLElement>('.agent__popover');
    this.agentPopoverDraft = agent && panel && isAgentEditable(agent) ? readConfigDraft(panel) : null;
  }

  /** Snapshot the focused config control before a rebuild, so an SSE-driven refresh
   *  cannot yank the caret out of the field the user is typing in. */
  private capturePopoverFocus(): PopoverFocus | null {
    if (!this.openPopoverId) return null;
    const active = this.doc.activeElement;
    const panel = this.root.querySelector<HTMLElement>('.agent__popover');
    if (!panel || !active || !panel.contains(active)) return null;
    const field = active.getAttribute('data-config-field');
    if (!field) return null;
    const input = active instanceof HTMLInputElement ? active : null;
    return { field, selStart: input?.selectionStart ?? null, selEnd: input?.selectionEnd ?? null };
  }

  private restorePopoverFocus(focus: PopoverFocus | null): void {
    if (!focus) return;
    const control = this.root.querySelector<HTMLElement>(`.agent__popover [data-config-field="${focus.field}"]`);
    if (!control) return;
    control.focus();
    if (focus.selStart !== null && control instanceof HTMLInputElement) {
      control.setSelectionRange(focus.selStart, focus.selEnd ?? focus.selStart);
    }
  }

  /** Save closes the popover at once; the write lands in the background and its
   *  outcome is announced. */
  private async configureAgent(conversationId: string, instanceId: string, config: AgentConfigInput): Promise<void> {
    this.closePopover();
    const res = await this.api.configureAgent(conversationId, instanceId, config);
    this.announce(res.ok ? 'Launch settings saved.' : res.error ?? 'Could not save launch settings.');
    await this.refreshAgents(conversationId);
  }

  private copyAttach(agent: AgentDto, button: HTMLButtonElement): Promise<void> {
    return agent.attachCommand
      ? this.flashCopy(button, agent.attachCommand, 'Attach command copied.', 'Copy failed — select the command in the details and copy manually.')
      : Promise.resolve();
  }

  /** Refetch the conversation's agents + tmux availability, then refill the roster. */
  private async refreshAgents(conversationId: string): Promise<void> {
    if (conversationId !== this.conversationId) return;
    const seq = ++this.agentRefreshSeq;
    let result: Awaited<ReturnType<ConversationApi['listAgents']>>;
    try {
      result = await this.api.listAgents(conversationId);
    } catch {
      return; // conversation gone; leave the roster as-is
    }
    if (seq !== this.agentRefreshSeq || conversationId !== this.conversationId || !Array.isArray(result.agents)) return;
    const tmuxAvailable = result.tmuxAvailable !== false;
    if (tmuxAvailable === this.tmuxAvailable && sameAgents(this.agents, result.agents)) return;
    const availabilityChanged = tmuxAvailable !== this.tmuxAvailable;
    this.tmuxAvailable = tmuxAvailable;
    this.agents = result.agents;
    if (availabilityChanged) {
      syncAgentAddButton(this.root, this.tmuxAvailable, () => this.setAgentMenu(!this.agentMenuOpen));
      if (!this.tmuxAvailable) this.setAgentMenu(false);
    }
    this.fillAgents();
  }

  /** Surgically refill the agent roster from current state into its own host
   *  (like fillActivity; the header is not rebuilt by the live update path). */
  private fillAgents(): void {
    const host = this.agentsHost;
    const conversationId = this.conversationId;
    if (!host || !conversationId) return;
    if (this.openPopoverId && !this.agents.some((a) => a.instanceId === this.openPopoverId)) this.resetPopover();
    const focus = this.capturePopoverFocus();
    this.capturePopoverDraft();
    fillAgentRoster(this.doc, host, this.agentBarState(conversationId), this.agentBarActions(conversationId));
    this.restorePopoverFocus(focus);
  }

  private async runAgentBatch(conversationId: string, agents: AgentDto[], action: (agent: AgentDto) => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    const failures: string[] = [];
    const results = await Promise.allSettled(agents.map((agent) => action(agent)));
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason instanceof Error ? result.reason.message : 'agent action failed');
      else if (!result.value.ok) failures.push(result.value.error ?? 'agent action failed');
    }
    await this.refreshAgents(conversationId);
    if (failures.length > 0) throw new Error(failures[0]);
  }

  private async runAgentAction(conversationId: string, action: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    const result = await action();
    if (!result.ok) throw new Error(result.error ?? 'agent action failed');
    await this.refreshAgents(conversationId);
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

  private copyId(btn: HTMLButtonElement, id: string): Promise<void> {
    return this.flashCopy(btn, id, 'Conversation id copied.', 'Copy failed — select the id and copy manually.');
  }

  /** Copy `text`, flash the button to a confirmation, and restore it after a beat.
   *  Announces success, or a manual-copy fallback when the clipboard is blocked. */
  private async flashCopy(button: HTMLButtonElement, text: string, ok: string, fail: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      this.announce(fail);
      return;
    }
    // Restore to the button's idle label, not whatever it shows now: a second click
    // inside the 1200ms window would otherwise capture "✓ Copied" and stick there.
    const idle = (button.dataset.flashIdle ??= button.textContent ?? '');
    button.textContent = '✓ Copied';
    this.announce(ok);
    window.setTimeout(() => { if (button.isConnected) button.textContent = idle; }, 1200);
  }

  private renderEvent(event: EventDTO): HTMLElement {
    if (event.type === 'system') {
      const box = el(this.doc, 'article', 'msg msg--system');
      box.setAttribute('data-event-id', event.id);
      const timestamp = renderTimestamp(this.doc, event.timestamp);
      if (timestamp) {
        const meta = el(this.doc, 'div', 'msg__meta msg__meta--system');
        meta.appendChild(timestamp);
        box.appendChild(meta);
      }
      const body = el(this.doc, 'div', 'msg__body');
      if (event.content) body.appendChild(renderContent(event.content, this.doc));
      box.appendChild(body);
      return box;
    }
    const isUser = event.author === 'user';
    const accent = isUser ? null : agentAccent(event.author);
    const box = el(this.doc, 'article', `msg ${isUser ? 'msg--user' : 'msg--agent'}${accent ? ` msg--${accent}` : ''}`);
    box.setAttribute('data-event-id', event.id);
    const meta = el(this.doc, 'div', 'msg__meta');
    meta.appendChild(el(this.doc, 'span', 'msg__role', event.author ?? 'agent'));
    const timestamp = renderTimestamp(this.doc, event.timestamp);
    if (timestamp) meta.appendChild(timestamp);
    box.appendChild(meta);
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

  /* Actions */

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
      await this.refreshAfterMessage(id, epoch);
    } else {
      this.sendError = result.error ?? 'Message rejected.';
      this.render();
      await this.refresh();
    }
  }

  private async addProject(): Promise<void> {
    const path = window.prompt('Project path (absolute):');
    if (!path) return; // cancelled or empty; no-op
    const result = await this.api.addProject(path);
    if (result.ok) await this.loadProjects();
    else window.alert(result.error ?? 'Could not add that project.'); // surface the server's reason, leave the sidebar as-is
  }

  /** Deregister a project (non-destructive): its transcripts stay on disk and
   *  re-adding the same path restores them. If the open conversation belonged to
   *  it, fall back to no conversation. */
  private async removeProject(project: ProjectDTO): Promise<void> {
    if (!window.confirm(`Remove "${project.title}" from the list? Its transcripts stay on disk; re-adding the same path restores them.`)) return;
    const result = await this.api.removeProject(project.id);
    if (!result.ok) {
      this.announce('Remove failed.');
      return;
    }
    this.collapsedProjects.delete(project.id); // drop dead collapse state (re-adding gets a fresh id)
    await this.loadProjects();
    // If the open conversation belonged to the removed project it is gone now;
    // resolve against the reloaded list (not the click-time snapshot, which may
    // predate a conversation opened during the request) and detach if it vanished.
    if (this.conversationId !== null && !this.findConversation(this.conversationId)) {
      this.detachConversation();
      this.announce('Project removed. No active conversation.');
      this.render();
    }
  }

  private async createConversation(projectId: string): Promise<void> {
    const title = window.prompt('Conversation title:') ?? 'Untitled';
    const result = await this.api.createConversation(projectId, title);
    if (result.ok && result.conversation) {
      await this.loadProjects();
      await this.openConversation(result.conversation.id);
    } else {
      window.alert(result.error ?? 'Could not create conversation.'); // surface the server's reason, leave the sidebar as-is
    }
  }

  /** Rename via a prompt prefilled with the current title. An empty or unchanged
   *  title is a no-op; the server is authoritative on the trimmed result, so the
   *  sidebar and header adopt the title it returns. */
  private async renameConversation(conv: ConversationDTO): Promise<void> {
    const input = window.prompt('Rename conversation:', conv.title);
    if (input === null) return; // cancelled
    const title = input.trim();
    if (!title || title === conv.title) return; // unchanged or empty: no request
    const result = await this.api.renameConversation(conv.id, title);
    if (!result.ok || !result.conversation) {
      this.announce('Rename failed.');
      return;
    }
    this.applyConversationTitle(conv.id, result.conversation.title);
    this.announce('Conversation renamed.');
  }

  /** Adopt a new title for one conversation across the sidebar and, when it is the
   *  open one, the chat header. */
  private applyConversationTitle(id: string, title: string): void {
    this.projects = this.projects.map((project) => ({
      ...project,
      conversations: project.conversations.map((conv) => (conv.id === id ? { ...conv, title } : conv)),
    }));
    if (!this.updateRenderedSidebar()) this.render();
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
      this.detachConversation(); // close the live stream to the now-deleted conversation
      this.render();
    } else if (this.renderedConvId === this.conversationId) {
      this.updateRenderedSidebar();
    }
    this.announce('Conversation deleted.');
    void this.loadProjects();
  }

  private removeConversation(id: string): void {
    this.removedConversationIds.add(id);
    this.projects = this.projects.map((project) => ({
      ...project,
      conversations: project.conversations.filter((conv) => conv.id !== id),
    }));
  }
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

/** The last two segments of an absolute path (`/acme/src/web` -> `src/web`), used
 *  to disambiguate projects that share a basename. */
function lastTwoSegments(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || path;
}

/** Both sides come from the same `toDto` serialization, so key order is stable and
 *  a JSON comparison covers every field without a list that can fall out of date. */
function sameAgents(a: AgentDto[], b: AgentDto[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const shortTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const shortDateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const longTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const relativeDay = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function renderTimestamp(doc: Document, timestamp: string): HTMLElement | null {
  const time = el(doc, 'time', 'msg__time');
  return fillTimestamp(time, timestamp) ? time : null;
}

function updateTimestamps(nodes: HTMLElement[], events: EventDTO[]): void {
  for (let i = 0; i < nodes.length; i++) {
    const time = nodes[i]?.querySelector<HTMLElement>('.msg__time');
    const timestamp = events[i]?.timestamp;
    if (time && timestamp) fillTimestamp(time, timestamp);
  }
}

function fillTimestamp(time: HTMLElement, timestamp: string): boolean {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return false;
  time.textContent = timestampLabel(date);
  time.setAttribute('datetime', timestamp);
  time.setAttribute('title', longTime.format(date));
  return true;
}

function timestampLabel(date: Date): string {
  const now = new Date();
  if (sameLocalDay(date, now)) return shortTime.format(date);

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameLocalDay(date, yesterday)) return `${relativeDay.format(-1, 'day')} ${shortTime.format(date)}`;

  return shortDateTime.format(date);
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Presence elapsed label once it has lasted at least a minute, else empty. */
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
