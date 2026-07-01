/**
 * Shared domain types for roundtable: a passive chat room.
 *
 * Type-only by design: the only runtime config lives in `src/config/limits.ts`,
 * so every layer can `import type` from here without a runtime dependency cycle.
 */

/* Events */

/** Event kinds persisted in the Markdown log. */
export type EventType = 'message' | 'system';

/** Metadata stamped into each event's `<!-- roundtable:event ... -->` comment. */
export interface EventMetadata {
  id: string;
  type: EventType;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
}

/**
 * A chat message. `author` is a free-form display name self-reported by the
 * sender: `user` for the human, a model like `Claude Opus 4.8`, or an assigned
 * room name plus model label such as `Claude-a1b2 · Claude Opus 4.8`.
 */
export interface MessageEvent extends EventMetadata {
  type: 'message';
  author: string;
  body: string;
}

/**
 * A machine-actionable system event. The only kind a passive chat room produces
 * is `quarantine-fence`, written by crash recovery when an interrupted trailing
 * write is fenced off. The human-readable `body` is never parsed.
 */
export interface SystemEvent extends EventMetadata {
  type: 'system';
  payload: SystemEventPayload;
  body: string;
}

export type RoundtableEvent = MessageEvent | SystemEvent;

export interface SystemEventPayload {
  kind: 'quarantine-fence';
}

/* Storage records */

/**
 * Conversation metadata (sidecar). The `id` is never written into the
 * human-readable Markdown.
 */
export interface ConversationMetadata {
  id: string;
  title: string;
  /** Markdown filename: English slug + short id. */
  filename: string;
  createdAt: string;
  lastActivityAt: string;
  /** Set once the conversation-total storage limit is reached. */
  readOnly?: boolean;
}

/**
 * Project registration record (sidecar `project.json`). `id` is the public,
 * URL-safe handle used in `/api/projects/:id`; `path` is the canonical absolute
 * filesystem path and the sole authority; the encoded directory name is never
 * the public id.
 */
export interface ProjectMetadata {
  id: string;
  path: string;
  /** Display title: the path basename. */
  title: string;
  addedAt: string;
}

/* Size-limit outcomes */

export type SizeLimitOutcome =
  | 'ok'
  | 'rejected' //                message over the single-message limit; not written
  | 'conversation-readonly'; //  conversation total reached; marked read-only

/**
 * Byte budgets for stored content. Every count is UTF-8 bytes of the
 * final framed text, so framing and metadata overhead are included.
 */
export interface SizeLimits {
  messageBytes: number;
  singleEventBytes: number;
  conversationTotalBytes: number;
}
