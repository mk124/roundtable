import type { AgentDto, AgentKind } from './client.ts';
import type { AgentAccent } from './ui-state.ts';
import { el } from './ui-state.ts';

export const AGENT_KIND_META: Record<AgentKind, { label: string; accent: AgentAccent }> = {
  claude: { label: 'Claude Code', accent: 'claude' },
  codex: { label: 'Codex', accent: 'gpt' },
  antigravity: { label: 'Antigravity', accent: 'gemini' },
};
const KIND_ORDER = Object.keys(AGENT_KIND_META) as AgentKind[];
const STATUS_TEXT: Record<AgentDto['status'], string> = {
  starting: 'starting...',
  running: 'running',
  stopped: 'stopped',
  errored: 'error',
};

export const TMUX_REQUIRED = 'Agent launching needs tmux on PATH';

export interface AgentBarState {
  conversationId: string;
  agents: AgentDto[];
  tmuxAvailable: boolean;
  menuOpen: boolean;
}

export interface AgentBarActions {
  toggleMenu: () => void;
  addAgent: (kind: AgentKind) => void;
  stopAgent: (agent: AgentDto) => Promise<void>;
  resumeAgent: (agent: AgentDto) => Promise<void>;
  removeAgent: (agent: AgentDto) => Promise<void>;
  stopAgents: (agents: AgentDto[]) => Promise<void>;
  resumeAgents: (agents: AgentDto[]) => Promise<void>;
  onActionError: (err: unknown) => void;
}

export function renderAgentBar(doc: Document, state: AgentBarState, actions: AgentBarActions): { bar: HTMLElement; roster: HTMLElement } {
  const bar = el(doc, 'div', 'agentbar');
  const add = el(doc, 'div', 'agentbar__add');
  const plus = el(doc, 'button', 'agentbar__plus', '+') as HTMLButtonElement;
  plus.type = 'button';
  plus.setAttribute('aria-label', 'Add agent');
  plus.setAttribute('aria-expanded', String(state.menuOpen));
  configureAddButton(add, plus, state.tmuxAvailable, actions.toggleMenu);

  add.appendChild(plus);
  add.appendChild(renderAgentMenu(doc, state, actions));
  bar.appendChild(add);

  const roster = el(doc, 'div', 'agentbar__roster');
  bar.appendChild(roster);
  fillAgentRoster(doc, roster, state, actions);
  return { bar, roster };
}

export function syncAgentAddButton(root: HTMLElement, tmuxAvailable: boolean, toggleMenu: () => void): void {
  const add = root.querySelector<HTMLElement>('.agentbar__add');
  const plus = root.querySelector<HTMLButtonElement>('.agentbar__plus');
  if (!plus) return;
  configureAddButton(add, plus, tmuxAvailable, toggleMenu);
}

export function fillAgentRoster(doc: Document, host: HTMLElement, state: AgentBarState, actions: AgentBarActions): void {
  const { agents, conversationId, tmuxAvailable } = state;
  host.textContent = '';
  for (const agent of agents) {
    const row = el(doc, 'div', `agent agent--${agent.status} accent-${AGENT_KIND_META[agent.kind].accent}`);
    row.appendChild(el(doc, 'span', 'agent__dot'));
    row.appendChild(el(doc, 'span', 'agent__label', agent.name));
    row.appendChild(el(doc, 'span', 'agent__status', STATUS_TEXT[agent.status]));
    if (isLiveAgent(agent)) {
      row.appendChild(agentButton(doc, 'Stop', `Stop ${agent.name}`, () => actions.stopAgent(agent), actions.onActionError));
    } else if (isResumableAgent(agent)) {
      row.appendChild(agentButton(doc, 'Resume', `Resume ${agent.name}`, () => actions.resumeAgent(agent), actions.onActionError, { disabledReason: tmuxAvailable ? null : TMUX_REQUIRED }));
    }
    row.appendChild(agentButton(doc, 'x', `Remove ${agent.name}`, () => actions.removeAgent(agent), actions.onActionError, { cls: 'agent__remove' }));
    host.appendChild(row);
  }

  const live = agents.filter(isLiveAgent);
  const stopped = agents.filter(isResumableAgent);
  if (live.length > 0) {
    host.appendChild(agentButton(doc, 'Stop All', `Stop all agents in ${conversationId}`, () => actions.stopAgents(live), actions.onActionError, { cls: 'agent__resumeall agent__stopall' }));
  } else if (stopped.length > 0) {
    host.appendChild(agentButton(doc, 'Resume All', `Resume all agents in ${conversationId}`, () => actions.resumeAgents(stopped), actions.onActionError, { cls: 'agent__resumeall', disabledReason: tmuxAvailable ? null : TMUX_REQUIRED }));
  }
}

function isLiveAgent(agent: AgentDto): boolean {
  return agent.status === 'running' || agent.status === 'starting';
}

function isResumableAgent(agent: AgentDto): boolean {
  return agent.resumable;
}

function renderAgentMenu(doc: Document, state: AgentBarState, actions: AgentBarActions): HTMLElement {
  const menu = el(doc, 'div', `menu${state.menuOpen ? ' menu--open' : ''}`);
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Agent type');
  for (const kind of KIND_ORDER) {
    const { accent, label } = AGENT_KIND_META[kind];
    const item = el(doc, 'button', `menu__item accent-${accent}`, label) as HTMLButtonElement;
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.onclick = () => actions.addAgent(kind);
    menu.appendChild(item);
  }
  return menu;
}

function configureAddButton(add: HTMLElement | null, plus: HTMLButtonElement, tmuxAvailable: boolean, toggleMenu: () => void): void {
  if (add) add.title = tmuxAvailable ? '' : TMUX_REQUIRED;
  plus.disabled = !tmuxAvailable;
  plus.title = tmuxAvailable ? '' : TMUX_REQUIRED;
  plus.onclick = tmuxAvailable
    ? (e: MouseEvent) => {
        e.stopPropagation();
        toggleMenu();
      }
    : null;
}

function agentButton(
  doc: Document,
  text: string,
  ariaLabel: string,
  action: () => Promise<void>,
  onActionError: (err: unknown) => void,
  opts: { cls?: string; disabledReason?: string | null } = {},
): HTMLButtonElement {
  const { cls = 'agent__btn', disabledReason = null } = opts;
  const btn = el(doc, 'button', cls, text) as HTMLButtonElement;
  btn.type = 'button';
  btn.setAttribute('aria-label', ariaLabel);
  if (disabledReason) {
    btn.disabled = true;
    btn.title = disabledReason;
    return btn;
  }
  btn.onclick = () => {
    btn.disabled = true;
    void action()
      .catch(onActionError)
      .finally(() => {
        if ((btn as { isConnected?: boolean }).isConnected !== false) btn.disabled = false;
      });
  };
  return btn;
}
