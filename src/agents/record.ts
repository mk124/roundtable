/**
 * Agent domain records: the kinds roundtable can launch, their lifecycle status,
 * and the per-conversation record persisted in the conversation's meta sidecar.
 *
 * The runtime kind/status lists are the single source of truth; the union types
 * are derived from them, so validation and typing never drift apart.
 */
import { isRecord } from '../storage/sidecar.ts';

export const AGENT_KINDS = ['claude', 'codex', 'antigravity'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const AGENT_STATUSES = ['starting', 'running', 'stopped', 'errored'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Per-kind reasoning-effort sets, injected as CLI flags in `buildCommand`. An
 *  empty set (antigravity) means the kind has no such control. */
export const AGENT_EFFORTS = {
  claude: ['max', 'xhigh', 'high', 'medium', 'low'],
  codex: ['xhigh', 'high', 'medium', 'low'],
  antigravity: [],
} as const satisfies Record<AgentKind, readonly string[]>;
export type AgentEffort = (typeof AGENT_EFFORTS)[AgentKind][number];

/** Per-kind permission modes; each token maps to an argv fragment in `buildCommand`.
 *  The array head is the default used when unset (and the picker's preselection). */
export const AGENT_PERMISSION_MODES = {
  claude: ['auto', 'bypassPermissions', 'default', 'acceptEdits', 'dontAsk', 'plan'],
  codex: ['bypass', 'danger-full-access', 'workspace-write', 'read-only'],
  antigravity: ['bypass', 'prompt', 'sandbox'],
} as const satisfies Record<AgentKind, readonly string[]>;
export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[AgentKind][number];

/** Codex-only approval policy (`-a`), independent of the sandbox mode. Head `never`
 *  keeps a sandboxed codex unattended; the `bypass` permission ignores it. */
export const AGENT_APPROVAL_POLICIES = {
  claude: [],
  codex: ['never', 'untrusted', 'on-request'],
  antigravity: [],
} as const satisfies Record<AgentKind, readonly string[]>;
export type AgentApprovalPolicy = (typeof AGENT_APPROVAL_POLICIES)[AgentKind][number];

/** Closed set of launch-failure markers surfaced on the record and DTO. */
export const AGENT_LAUNCH_ERRORS = ['configured-launch-failed'] as const;
export type AgentLaunchError = (typeof AGENT_LAUNCH_ERRORS)[number];

/** Raw launch overrides before validation: `undefined` = unchanged/unset,
 *  `null`/`''` = clear to the CLI default, anything else is validated per kind. */
export interface AgentConfigInput {
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  approvalPolicy?: string | null;
}

/**
 * One launched agent within a conversation. `instanceId` is non-recycling, so the
 * tmux session name stays bound to a single logical agent over time. `sessionId`
 * is the CLI's own session id, absent until capture completes. Without it, a live
 * Codex/Antigravity agent can still run and be stopped, but cannot be resumed
 * after it exits. The launch overrides are optional (absent = the CLI's default);
 * `launchError` marks a configured launch that failed before its session started.
 */
export interface AgentRecord {
  kind: AgentKind;
  instanceId: string;
  name: string;
  sessionId?: string;
  createdAt: string;
  status: AgentStatus;
  model?: string;
  effort?: AgentEffort;
  permissionMode?: AgentPermissionMode;
  approvalPolicy?: AgentApprovalPolicy;
  launchError?: AgentLaunchError;
}

export interface AgentDto {
  instanceId: string;
  kind: AgentKind;
  name: string;
  status: AgentStatus;
  /** Whether the roster should expose Resume for this record. */
  resumable: boolean;
  createdAt: string;
  sessionId?: string;
  model?: string;
  effort?: AgentEffort;
  permissionMode?: AgentPermissionMode;
  approvalPolicy?: AgentApprovalPolicy;
  /** The `tmux attach` command; present only while the session is live (copyable). */
  attachCommand?: string;
  launchError?: AgentLaunchError;
}

export const isAgentKind = (value: unknown): value is AgentKind =>
  typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value);

const isAgentStatus = (value: unknown): value is AgentStatus =>
  typeof value === 'string' && (AGENT_STATUSES as readonly string[]).includes(value);

/** True when `value` is a valid effort for `kind` (always false for antigravity). */
export const isEffortFor = (kind: AgentKind, value: string): value is AgentEffort =>
  (AGENT_EFFORTS[kind] as readonly string[]).includes(value);

/** True when `value` is a valid permission mode for `kind`. */
export const isPermissionModeFor = (kind: AgentKind, value: string): value is AgentPermissionMode =>
  (AGENT_PERMISSION_MODES[kind] as readonly string[]).includes(value);

/** True when `value` is a valid approval policy for `kind` (codex only). */
export const isApprovalPolicyFor = (kind: AgentKind, value: string): value is AgentApprovalPolicy =>
  (AGENT_APPROVAL_POLICIES[kind] as readonly string[]).includes(value);

const isAgentLaunchError = (value: unknown): value is AgentLaunchError =>
  typeof value === 'string' && (AGENT_LAUNCH_ERRORS as readonly string[]).includes(value);

function agentRecord(value: unknown): AgentRecord | null {
  if (!isRecord(value) || !isAgentKind(value.kind) || typeof value.instanceId !== 'string' || !isSafeAgentToken(value.instanceId)) return null;
  const name = typeof value.name === 'string' ? value.name : null;
  if (name === null || !isSafeAgentToken(name)) return null;
  if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || !isSafeAgentSessionId(value.sessionId))) return null;
  if (typeof value.createdAt !== 'string' || !isAgentStatus(value.status)) return null;
  if (value.model !== undefined && (typeof value.model !== 'string' || !isSafeAgentModel(value.model))) return null;
  if (value.effort !== undefined && (typeof value.effort !== 'string' || !isEffortFor(value.kind, value.effort))) return null;
  if (value.permissionMode !== undefined && (typeof value.permissionMode !== 'string' || !isPermissionModeFor(value.kind, value.permissionMode))) return null;
  if (value.approvalPolicy !== undefined && (typeof value.approvalPolicy !== 'string' || !isApprovalPolicyFor(value.kind, value.approvalPolicy))) return null;
  if (value.launchError !== undefined && !isAgentLaunchError(value.launchError)) return null;
  const record: AgentRecord = { kind: value.kind, instanceId: value.instanceId, name, createdAt: value.createdAt, status: value.status };
  if (value.sessionId !== undefined) record.sessionId = value.sessionId;
  if (value.model !== undefined) record.model = value.model;
  if (value.effort !== undefined) record.effort = value.effort;
  if (value.permissionMode !== undefined) record.permissionMode = value.permissionMode;
  if (value.approvalPolicy !== undefined) record.approvalPolicy = value.approvalPolicy;
  if (value.launchError !== undefined) record.launchError = value.launchError;
  return record;
}

export function agentRecordArray(value: unknown): AgentRecord[] | null {
  if (!Array.isArray(value)) return null;
  const records = value.map(agentRecord);
  return records.every((record): record is AgentRecord => record !== null) ? records : null;
}

/**
 * Allowlist for values that flow into an agent's argv or tmux session name. Reject
 * anything outside `[A-Za-z0-9_-]` so names cannot carry shell, quote, control, or
 * tmux target-separator characters. The 16-hex conversation id already satisfies it.
 */
export const isSafeAgentToken = (value: string): boolean => /^[A-Za-z0-9_-]+$/.test(value);

/** Model-id allowlist, wider than `isSafeAgentToken` (dots, `sonnet[1m]`, spaced
 *  antigravity labels). Safe because the value only enters the launch argv, never
 *  the tmux session name; the leading char forbids `-` so it cannot read as a flag. */
export const isSafeAgentModel = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9 ._()[\]-]{0,63}$/.test(value);

export const isSafeAgentSessionId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
