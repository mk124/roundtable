/**
 * Session-id acquisition. Claude's id is caller-minted (passed via `--session-id`);
 * Codex and Antigravity write a session file after the launched agent responds;
 * its name carries the id, captured by diffing a directory snapshot around spawn.
 *
 * Pure by design: the supervisor walks the directory and supplies the basenames, so
 * the extraction logic is unit-testable without spawning anything.
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isSafeAgentSessionId, type AgentKind } from './record.ts';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Per-kind filename -> session-id candidate. Null for Claude (no capture). */
const EXTRACT: Record<AgentKind, RegExp | null> = {
  claude: null,
  codex: new RegExp(`(${UUID})\\.jsonl$`),
  antigravity: new RegExp(`(^|/)(${UUID})\\.db$`),
};

/** Session directory to watch for a kind, or null when none (Claude). */
export function sessionDir(kind: AgentKind): string | null {
  switch (kind) {
    case 'claude':
      return null;
    case 'codex':
      return join(homedir(), '.codex', 'sessions');
    case 'antigravity':
      return join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
  }
}

/** A fresh caller-supplied session id for Claude; null for kinds captured from disk. */
export function newSessionId(kind: AgentKind): string | null {
  return kind === 'claude' ? randomUUID() : null;
}

export function sessionIdFromFile(kind: AgentKind, file: string): string | null {
  const extract = EXTRACT[kind];
  if (!extract) return null;
  const match = normalizedSessionPath(file).match(extract);
  const id = match?.at(-1) ?? null;
  return id && isSafeAgentSessionId(id) ? id : null;
}

function normalizedSessionPath(file: string): string {
  return file.replace(/\\/g, '/');
}
