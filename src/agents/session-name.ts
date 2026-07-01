import { createHash } from 'node:crypto';
import { isConversationId } from '../conversations/naming.ts';
import { type AgentKind, isAgentKind, isSafeAgentToken } from './record.ts';

const PREFIX = 'roundtable';

export function agentSessionNamespace(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

export interface AgentSessionParts {
  namespace: string;
  kind: AgentKind;
  convId: string;
  instanceId: string;
}

export function agentSessionName(namespace: string, kind: AgentKind, convId: string, instanceId: string): string {
  return `${PREFIX}-${kind}-${namespace}-${convId}-${instanceId}`;
}

export function parseAgentSessionName(name: string): AgentSessionParts | null {
  const prefix = `${PREFIX}-`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const parts = rest.split('-');
  if (parts.length < 4) return null;
  const [kind, namespace, convId, ...instanceParts] = parts;
  const instanceId = instanceParts.join('-');
  return kind && isAgentKind(kind) && namespace && isSafeAgentToken(namespace) && convId && isConversationId(convId) && instanceId && isSafeAgentToken(instanceId)
    ? { namespace, kind, convId, instanceId }
    : null;
}

export function agentSessionInScope(name: string, namespace: string, convId?: string, instanceId?: string): boolean {
  const parsed = parseAgentSessionName(name);
  return Boolean(parsed && parsed.namespace === namespace && (!convId || parsed.convId === convId) && (!instanceId || parsed.instanceId === instanceId));
}
