import type { AgentConfigInput, AgentDto, AgentKind } from './client.ts';
import type { AgentAccent } from './ui-state.ts';
import { el } from './ui-state.ts';

export const AGENT_KIND_META: Record<AgentKind, { label: string; accent: AgentAccent }> = {
  claude: { label: 'Claude Code', accent: 'claude' },
  codex: { label: 'Codex', accent: 'gpt' },
  antigravity: { label: 'Antigravity', accent: 'gemini' },
};
const KIND_ORDER = Object.keys(AGENT_KIND_META) as AgentKind[];

// Mirrors of record.ts's per-kind sets — the static server only serves src/web, so
// the browser cannot value-import them. Each mirror is pinned to the server
// constant's literal type, so any drift fails the web typecheck. Head = default.
type ServerRecord = typeof import('../agents/record.ts');
const AGENT_EFFORTS: ServerRecord['AGENT_EFFORTS'] = {
  claude: ['max', 'xhigh', 'high', 'medium', 'low'],
  codex: ['xhigh', 'high', 'medium', 'low'],
  antigravity: [],
};
const AGENT_PERMISSION_MODES: ServerRecord['AGENT_PERMISSION_MODES'] = {
  claude: ['auto', 'bypassPermissions', 'default', 'acceptEdits', 'dontAsk', 'plan'],
  codex: ['bypass', 'danger-full-access', 'workspace-write', 'read-only'],
  antigravity: ['bypass', 'prompt', 'sandbox'],
};
// Codex-only `-a` approval policy; the bypass permission ignores it.
const AGENT_APPROVAL_POLICIES: ServerRecord['AGENT_APPROVAL_POLICIES'] = {
  claude: [],
  codex: ['never', 'untrusted', 'on-request'],
  antigravity: [],
};
const MODEL_SUGGESTIONS: Record<AgentKind, readonly string[]> = {
  claude: ['opus[1m]', 'opus', 'sonnet', 'haiku', 'fable'],
  codex: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
  antigravity: ['Gemini 3.1 Pro (High)', 'Gemini 3.1 Pro (Low)', 'Gemini 3.5 Flash (High)', 'Gemini 3.5 Flash (Medium)', 'Gemini 3.5 Flash (Low)'],
};
const defaultMode = (kind: AgentKind): string => AGENT_PERMISSION_MODES[kind][0]!;
const defaultApproval = (kind: AgentKind): string => AGENT_APPROVAL_POLICIES[kind][0] ?? '';

const NOT_SPECIFIED = 'Not specified';
const STATUS_TEXT: Record<AgentDto['status'], string> = {
  starting: 'starting...',
  running: 'running',
  stopped: 'stopped',
  errored: 'error',
};

export const TMUX_REQUIRED = 'Agent launching needs tmux on PATH';
/** Shared disabled hints, kept together so the two edit surfaces cannot drift. */
export const EDIT_REQUIRES_STOPPED = 'Stop the agent to change its launch settings';
export const ATTACH_REQUIRES_LIVE = 'Available once the tmux session is live';

/** Current values of the launch controls; '' means "not specified". */
export interface AgentConfigDraft {
  model: string;
  effort: string;
  permissionMode: string;
  approvalPolicy: string;
}

/** The all-unset draft: a new agent's baseline, and the seed for the create form. */
const EMPTY_DRAFT: AgentConfigDraft = { model: '', effort: '', permissionMode: '', approvalPolicy: '' };

interface ConfigControls {
  element: HTMLElement;
  read: () => AgentConfigDraft;
  focusFirst: () => void;
}

/** Build the shared model/effort/permission controls, seeded with `initial`. The
 *  add-menu form and the popover editor both use this, so they cannot drift. */
function renderConfigControls(doc: Document, kind: AgentKind, initial: AgentConfigDraft, disabled = false): ConfigControls {
  const wrap = el(doc, 'div', 'agent-config');

  // Per-kind id: two same-kind instances would carry identical suggestions anyway.
  const listId = `agent-models-${kind}`;
  const model = el(doc, 'input', 'agent-config__control') as HTMLInputElement;
  model.setAttribute('data-config-field', 'model');
  model.setAttribute('list', listId);
  model.placeholder = NOT_SPECIFIED;
  model.value = initial.model;
  model.autocomplete = 'off';
  model.spellcheck = false;
  model.disabled = disabled;
  const datalist = el(doc, 'datalist') as HTMLDataListElement;
  datalist.id = listId;
  for (const suggestion of MODEL_SUGGESTIONS[kind]) datalist.appendChild(optionEl(doc, suggestion));
  wrap.appendChild(configRow(doc, 'Model', model, datalist));

  let effort: HTMLSelectElement | null = null;
  if (AGENT_EFFORTS[kind].length > 0) {
    effort = el(doc, 'select', 'agent-config__control') as HTMLSelectElement;
    effort.setAttribute('data-config-field', 'effort');
    effort.appendChild(optionEl(doc, '', NOT_SPECIFIED));
    for (const value of AGENT_EFFORTS[kind]) effort.appendChild(optionEl(doc, value));
    effort.value = initial.effort;
    effort.disabled = disabled;
    wrap.appendChild(configRow(doc, 'Effort', effort));
  }

  const permission = el(doc, 'select', 'agent-config__control') as HTMLSelectElement;
  permission.setAttribute('data-config-field', 'permissionMode');
  const def = defaultMode(kind);
  fillModeOptions(doc, permission, AGENT_PERMISSION_MODES[kind], PROMPTING_PERMISSIONS[kind], def);
  permission.value = initial.permissionMode || def;
  permission.disabled = disabled;
  wrap.appendChild(configRow(doc, 'Permissions', permission));

  if (AGENT_APPROVAL_POLICIES[kind].length > 0) {
    const approval = el(doc, 'select', 'agent-config__control') as HTMLSelectElement;
    approval.setAttribute('data-config-field', 'approvalPolicy');
    const approvalDef = defaultApproval(kind);
    fillModeOptions(doc, approval, AGENT_APPROVAL_POLICIES[kind], PROMPTING_APPROVALS, approvalDef);
    approval.value = initial.approvalPolicy || approvalDef;
    // Approvals are inert under the bypass permission: reset and disable until a sandbox is chosen.
    const syncApproval = () => {
      const bypass = permission.value === def;
      if (bypass) approval.value = approvalDef;
      approval.disabled = disabled || bypass;
    };
    permission.addEventListener('change', syncApproval);
    syncApproval();
    wrap.appendChild(configRow(doc, 'Approval', approval));
  }

  return {
    element: wrap,
    read: () => readConfigDraft(wrap),
    focusFirst: () => model.focus(),
  };
}

/** Read the three launch controls out of a rendered `.agent-config` container.
 *  Data-attribute lookup keeps it stable across the roster's surgical rebuilds. */
export function readConfigDraft(container: HTMLElement): AgentConfigDraft {
  const value = (field: string) => container.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-config-field="${field}"]`)?.value ?? '';
  return { model: value('model').trim(), effort: value('effort'), permissionMode: value('permissionMode'), approvalPolicy: value('approvalPolicy') };
}

/** An agent's stored overrides as a control draft (unset fields become ''). */
function dtoDraft(agent: AgentDto): AgentConfigDraft {
  return { model: agent.model ?? '', effort: agent.effort ?? '', permissionMode: agent.permissionMode ?? '', approvalPolicy: agent.approvalPolicy ?? '' };
}

/** Editable exactly when a resume could pick up the change: stopped or errored. */
export function isAgentEditable(agent: AgentDto): boolean {
  return agent.status === 'stopped' || agent.status === 'errored';
}

/** Diff a draft against its original into a request body: only changed fields,
 *  with cleared (or reset-to-default) values sent as null. */
function configPatch(kind: AgentKind, original: AgentConfigDraft, draft: AgentConfigDraft): AgentConfigInput {
  const patch: AgentConfigInput = {};
  if (draft.model !== original.model) patch.model = draft.model || null;
  if (draft.effort !== original.effort) patch.effort = draft.effort || null;
  const originalMode = original.permissionMode || defaultMode(kind);
  if (draft.permissionMode !== originalMode) patch.permissionMode = draft.permissionMode === defaultMode(kind) ? null : draft.permissionMode;
  const originalApproval = original.approvalPolicy || defaultApproval(kind);
  if (draft.approvalPolicy !== originalApproval) patch.approvalPolicy = draft.approvalPolicy === defaultApproval(kind) ? null : draft.approvalPolicy;
  return patch;
}

function configRow(doc: Document, label: string, control: HTMLElement, extra?: HTMLElement): HTMLElement {
  const row = el(doc, 'label', 'agent-config__row');
  row.appendChild(el(doc, 'span', 'agent-config__label', label));
  row.appendChild(control);
  if (extra) row.appendChild(extra);
  return row;
}

function optionEl(doc: Document, value: string, label = value): HTMLOptionElement {
  const opt = el(doc, 'option', undefined, label) as HTMLOptionElement;
  opt.value = value;
  return opt;
}

/** Fill a permission/approval select: prompting values sink to the bottom flagged
 *  with ⚑, since they would pause an unattended agent. */
function fillModeOptions(doc: Document, select: HTMLSelectElement, values: readonly string[], prompting: readonly string[], def: string): void {
  const rank = (v: string) => (prompting.includes(v) ? 1 : 0);
  for (const value of [...values].sort((a, b) => rank(a) - rank(b))) {
    select.appendChild(optionEl(doc, value, rank(value) ? `⚑ ${value}` : value === def ? `${value} (default)` : value));
  }
}

/** Wire an async submit button: busy label while running, error + restore on
 *  failure; success is left to the caller's re-render. */
function bindSubmit(button: HTMLButtonElement, error: HTMLElement, busyLabel: string, run: () => Promise<{ ok: boolean; error?: string }>): void {
  const idle = button.textContent ?? '';
  button.onclick = () => {
    error.textContent = '';
    button.disabled = true;
    button.textContent = busyLabel;
    void run().catch(() => ({ ok: false, error: `${idle} failed.` })).then((res) => {
      if (res.ok) return;
      error.textContent = res.error ?? `${idle} failed.`;
      button.disabled = false;
      button.textContent = idle;
    });
  };
}

export interface AgentBarState {
  conversationId: string;
  agents: AgentDto[];
  tmuxAvailable: boolean;
  menuOpen: boolean;
  /** When set, the add menu shows the configured-launch form for this kind. */
  menuConfigKind: AgentKind | null;
  /** The instanceId whose details popover is open, if any. */
  openPopoverId: string | null;
  /** Unsaved edit carried across a roster rebuild while the popover stays editable. */
  popoverDraft: AgentConfigDraft | null;
}

export interface AgentBarActions {
  toggleMenu: () => void;
  addAgent: (kind: AgentKind) => void;
  configureKind: (kind: AgentKind) => void;
  cancelConfigure: () => void;
  launchConfigured: (kind: AgentKind, config: AgentConfigInput) => Promise<{ ok: boolean; error?: string }>;
  togglePopover: (agent: AgentDto) => void;
  configureAgent: (agent: AgentDto, config: AgentConfigInput) => Promise<{ ok: boolean; error?: string }>;
  copyAttach: (agent: AgentDto, button: HTMLButtonElement) => Promise<void>;
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
    const open = agent.instanceId === state.openPopoverId;
    const row = el(doc, 'div', `agent agent--${agent.status} accent-${AGENT_KIND_META[agent.kind].accent}${open ? ' agent--popover-open' : ''}`);
    row.appendChild(detailsTrigger(doc, agent, open, actions));
    if (isLiveAgent(agent)) {
      row.appendChild(agentButton(doc, 'Stop', `Stop ${agent.name}`, () => actions.stopAgent(agent), actions.onActionError));
    } else if (isResumableAgent(agent)) {
      row.appendChild(agentButton(doc, 'Resume', `Resume ${agent.name}`, () => actions.resumeAgent(agent), actions.onActionError, { disabledReason: tmuxAvailable ? null : TMUX_REQUIRED }));
    }
    row.appendChild(agentButton(doc, 'x', `Remove ${agent.name}`, () => actions.removeAgent(agent), actions.onActionError, { cls: 'agent__remove' }));
    if (open) row.appendChild(renderAgentPopover(doc, agent, actions, state.popoverDraft));
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
  fillAgentMenu(doc, menu, state, actions);
  return menu;
}

/** Refill the menu in place and reflect the open state, so switching between the
 *  kind list and a kind's configured-launch form is one class-and-content update. */
export function syncAgentMenu(root: HTMLElement, doc: Document, state: AgentBarState, actions: AgentBarActions): void {
  const menu = root.querySelector<HTMLElement>('.agentbar .menu');
  if (!menu) return;
  menu.classList.toggle('menu--open', state.menuOpen);
  fillAgentMenu(doc, menu, state, actions);
}

function fillAgentMenu(doc: Document, menu: HTMLElement, state: AgentBarState, actions: AgentBarActions): void {
  menu.textContent = '';
  menu.classList.toggle('menu--config', state.menuConfigKind !== null);
  if (state.menuConfigKind) fillConfigForm(doc, menu, state.menuConfigKind, actions);
  else fillKindList(doc, menu, actions);
}

/** Kind list: each kind is a one-click default launch plus a `⧉` that opens its
 *  configured-launch form (model/effort/permission before launching). */
function fillKindList(doc: Document, menu: HTMLElement, actions: AgentBarActions): void {
  menu.setAttribute('aria-label', 'Agent type');
  for (const kind of KIND_ORDER) {
    const { accent, label } = AGENT_KIND_META[kind];
    const row = el(doc, 'div', `menu__row accent-${accent}`);
    const launch = el(doc, 'button', 'menu__item', label) as HTMLButtonElement;
    launch.type = 'button';
    launch.setAttribute('role', 'menuitem');
    launch.onclick = () => actions.addAgent(kind);
    const options = el(doc, 'button', 'menu__options', '⧉') as HTMLButtonElement;
    options.type = 'button';
    options.setAttribute('aria-label', `Launch ${label} with options`);
    options.onclick = () => actions.configureKind(kind);
    row.append(launch, options);
    menu.appendChild(row);
  }
}

function fillConfigForm(doc: Document, menu: HTMLElement, kind: AgentKind, actions: AgentBarActions): void {
  const { label } = AGENT_KIND_META[kind];
  menu.setAttribute('aria-label', `Launch ${label} with options`);
  menu.appendChild(el(doc, 'div', 'menu__heading', `Launch ${label}`));
  const controls = renderConfigControls(doc, kind, EMPTY_DRAFT);
  menu.appendChild(controls.element);
  const error = el(doc, 'div', 'agent-config__error');
  menu.appendChild(error);

  const back = el(doc, 'button', 'agent-config__btn', 'Back') as HTMLButtonElement;
  back.type = 'button';
  back.onclick = () => actions.cancelConfigure();
  const launch = el(doc, 'button', 'agent-config__btn agent-config__btn--primary', 'Launch') as HTMLButtonElement;
  launch.type = 'button';
  bindSubmit(launch, error, 'Launching…', () => actions.launchConfigured(kind, configPatch(kind, EMPTY_DRAFT, controls.read())));
  const row = el(doc, 'div', 'agent-config__actions');
  row.append(back, launch);
  menu.appendChild(row);
  controls.focusFirst();
}

/** Values that pause for an in-tmux approval (flagged ⚑, sorted last). For codex
 *  the approval policy decides, not the sandbox mode, so its permission set is empty. */
const PROMPTING_PERMISSIONS: Record<AgentKind, readonly string[]> = {
  claude: ['default', 'acceptEdits', 'plan'],
  codex: [],
  antigravity: ['prompt', 'sandbox'],
} satisfies { [K in AgentKind]: readonly ServerRecord['AGENT_PERMISSION_MODES'][K][number][] };
const PROMPTING_APPROVALS: readonly string[] = ['untrusted', 'on-request'] satisfies readonly ServerRecord['AGENT_APPROVAL_POLICIES']['codex'][number][];

/** True when a live agent may pause for an approval in its tmux session (an unset
 *  field means the kind's default, always non-prompting). */
function needsApproval(agent: AgentDto): boolean {
  if (!isLiveAgent(agent) || agent.permissionMode === undefined) return false;
  if (agent.kind === 'codex') {
    return agent.permissionMode !== 'bypass' && PROMPTING_APPROVALS.includes(agent.approvalPolicy ?? '');
  }
  return PROMPTING_PERMISSIONS[agent.kind].includes(agent.permissionMode);
}

function approvalCue(doc: Document): HTMLElement {
  const cue = el(doc, 'span', 'agent__approval', '⚑');
  cue.title = 'Approvals happen in the tmux session';
  cue.setAttribute('aria-hidden', 'true'); // the trigger's aria-label carries the meaning
  return cue;
}

/** The pill body opens the details popover; Stop/Resume/Remove stay siblings so
 *  they never toggle it. */
function detailsTrigger(doc: Document, agent: AgentDto, open: boolean, actions: AgentBarActions): HTMLButtonElement {
  const approval = needsApproval(agent);
  const trigger = el(doc, 'button', 'agent__open') as HTMLButtonElement;
  trigger.type = 'button';
  trigger.setAttribute('aria-label', `Details for ${agent.name}${approval ? ', waiting for approvals in tmux' : ''}`);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', String(open));
  trigger.setAttribute('aria-controls', `agent-popover-${agent.instanceId}`);
  trigger.setAttribute('data-agent-details', agent.instanceId);
  trigger.onclick = () => actions.togglePopover(agent);
  trigger.appendChild(el(doc, 'span', 'agent__dot'));
  trigger.appendChild(el(doc, 'span', 'agent__label', agent.name));
  trigger.appendChild(el(doc, 'span', 'agent__status', STATUS_TEXT[agent.status]));
  if (approval) trigger.appendChild(approvalCue(doc));
  return trigger;
}

/** The details popover. The config controls double as the current-value display;
 *  the footer offers Save while editable, copy-attach while live. */
function renderAgentPopover(doc: Document, agent: AgentDto, actions: AgentBarActions, draft: AgentConfigDraft | null): HTMLElement {
  const panel = el(doc, 'div', 'agent__popover');
  panel.id = `agent-popover-${agent.instanceId}`;
  panel.tabIndex = -1; // focus target when no control is enabled (e.g. a live agent)
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `${agent.name} details`);

  const head = el(doc, 'div', 'agent-popover__head');
  const identity = el(doc, 'div', 'agent-popover__id');
  identity.appendChild(el(doc, 'span', 'agent-popover__name', agent.name));
  identity.appendChild(el(doc, 'span', 'agent-popover__kind', AGENT_KIND_META[agent.kind].label));
  head.append(identity, el(doc, 'span', `agent-popover__status agent-popover__status--${agent.status}`, STATUS_TEXT[agent.status]));
  panel.appendChild(head);

  const meta = el(doc, 'dl', 'agent-popover__meta');
  meta.append(...metaRow(doc, 'Created', formatCreated(agent.createdAt)));
  meta.append(...metaRow(doc, 'Session', agent.sessionId ?? 'capturing…', agent.sessionId ? 'agent-popover__mono' : 'agent-popover__pending'));
  panel.appendChild(meta);

  if (agent.launchError) panel.appendChild(cue(doc, 'error', '⚠', 'The configured launch failed before it started — review the settings below.'));
  if (needsApproval(agent)) panel.appendChild(cue(doc, 'warn', '⚑', 'This agent waits for approvals inside its tmux session; attach with the command below to answer them.'));

  const editable = isAgentEditable(agent);
  const controls = renderConfigControls(doc, agent.kind, editable && draft ? draft : dtoDraft(agent), !editable);
  panel.appendChild(controls.element);
  if (!editable) panel.appendChild(el(doc, 'div', 'agent-config__hint', EDIT_REQUIRES_STOPPED));
  const error = el(doc, 'div', 'agent-config__error');
  panel.appendChild(error);

  const foot = el(doc, 'div', 'agent-popover__foot');
  if (editable) {
    const save = el(doc, 'button', 'agent-config__btn agent-config__btn--primary', 'Save') as HTMLButtonElement;
    save.type = 'button';
    bindSubmit(save, error, 'Saving…', () => actions.configureAgent(agent, configPatch(agent.kind, dtoDraft(agent), controls.read())));
    foot.appendChild(save);
  } else {
    const copy = el(doc, 'button', 'agent-config__btn', 'Copy tmux command') as HTMLButtonElement;
    copy.type = 'button';
    if (agent.attachCommand) copy.onclick = () => void actions.copyAttach(agent, copy);
    else { copy.disabled = true; copy.title = ATTACH_REQUIRES_LIVE; }
    foot.appendChild(copy);
  }
  panel.appendChild(foot);
  return panel;
}

/** A `<dt>`/`<dd>` pair for the meta `<dl>`. */
function metaRow(doc: Document, key: string, value: string, valueClass?: string): [HTMLElement, HTMLElement] {
  const term = el(doc, 'dt', 'agent-popover__key', key);
  const detail = el(doc, 'dd', valueClass ? `agent-popover__val ${valueClass}` : 'agent-popover__val', value);
  return [term, detail];
}

function cue(doc: Document, tone: 'warn' | 'error', icon: string, text: string): HTMLElement {
  const box = el(doc, 'div', `agent-popover__cue agent-popover__cue--${tone}`);
  const glyph = el(doc, 'span', 'agent-popover__cue-icon', icon);
  glyph.setAttribute('aria-hidden', 'true');
  box.append(glyph, el(doc, 'span', undefined, text));
  return box;
}

function formatCreated(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : iso;
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
