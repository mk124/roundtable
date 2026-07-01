/**
 * Agent domain records: the kinds roundtable can launch, their lifecycle status,
 * and the per-conversation record persisted in the `<id>.agents.json` sidecar.
 *
 * The runtime kind/status lists are the single source of truth; the union types
 * are derived from them, so validation and typing never drift apart.
 */
import { isRecord } from '../storage/sidecar.ts';

export const AGENT_KINDS = ['claude', 'codex', 'antigravity'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const AGENT_STATUSES = ['starting', 'running', 'stopped', 'errored'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * One launched agent within a conversation. `instanceId` is non-recycling, so the
 * tmux session name stays bound to a single logical agent over time. `sessionId`
 * is the CLI's own session id, absent until capture completes. Without it, a live
 * Codex/Antigravity agent can still run and be stopped, but cannot be resumed
 * after it exits.
 */
export interface AgentRecord {
  kind: AgentKind;
  instanceId: string;
  name: string;
  sessionId?: string;
  createdAt: string;
  status: AgentStatus;
}

export interface AgentDto {
  instanceId: string;
  kind: AgentKind;
  name: string;
  status: AgentStatus;
  /** Whether the roster should expose Resume for this record. */
  resumable: boolean;
}

export const isAgentKind = (value: unknown): value is AgentKind =>
  typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value);

const isAgentStatus = (value: unknown): value is AgentStatus =>
  typeof value === 'string' && (AGENT_STATUSES as readonly string[]).includes(value);

function agentRecord(value: unknown): AgentRecord | null {
  if (!isRecord(value) || !isAgentKind(value.kind) || typeof value.instanceId !== 'string' || !isSafeAgentToken(value.instanceId)) return null;
  const name = typeof value.name === 'string' ? value.name : null;
  if (name === null || !isSafeAgentToken(name)) return null;
  if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || !isSafeAgentSessionId(value.sessionId))) return null;
  if (typeof value.createdAt !== 'string' || !isAgentStatus(value.status)) return null;
  const record: AgentRecord = { kind: value.kind, instanceId: value.instanceId, name, createdAt: value.createdAt, status: value.status };
  if (value.sessionId !== undefined) record.sessionId = value.sessionId;
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

export const isSafeAgentSessionId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
