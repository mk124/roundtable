export interface SseClient {
  write(chunk: string): void;
  /** End the underlying stream (the conversation is gone). Optional so tests and
   *  non-HTTP callers can omit it. */
  close?(): void;
}

/** An author's ephemeral presence: "thinking", "investigating code", etc.
 *  Held in memory only, never persisted; gone on restart. */
export interface ActivityEntry {
  author: string;
  state: string;
  /** ISO-8601 timestamp the state was set, for elapsed-time display. */
  since: string;
}

/** Format a presence frame: a named event with no id, so it never enters the
 *  cursor/replay flow (stale presence must not be replayed). */
function activityChunk(active: ActivityEntry[]): string {
  return `event: activity\ndata: ${JSON.stringify({ active })}\n\n`;
}

/**
 * The live channel for one conversation. It carries two kinds of update:
 * durable message bumps (tagged with the event-count cursor, buffered for
 * Last-Event-ID replay), and ephemeral presence (`activity`, in-memory,
 * snapshot-broadcast, never buffered or replayed).
 */
export class SseHub {
  private readonly clients = new Set<SseClient>();
  private readonly buffer: { id: number; chunk: string }[] = [];
  private readonly bufferLimit: number;
  private readonly activity = new Map<string, ActivityEntry>();
  private closed = false;

  constructor(bufferLimit = 100) {
    this.bufferLimit = bufferLimit;
  }

  /** Broadcast a message update tagged with the caller's monotonic cursor (the
   *  conversation's event count after the append). */
  publish(id: number, data: unknown): void {
    const chunk = `id: ${id}\nevent: message\ndata: ${JSON.stringify(data)}\n\n`;
    this.buffer.push({ id, chunk });
    if (this.buffer.length > this.bufferLimit) this.buffer.shift();
    for (const client of this.clients) client.write(chunk);
  }

  /**
   * Set or clear an author's presence. A null/blank state clears it. Re-setting
   * the same state is idempotent; it keeps the original `since` and emits
   * nothing, so heartbeats don't reset the elapsed timer or spam clients.
   */
  setActivity(author: string, state: string | null): void {
    const name = author.trim();
    if (!name) return;
    const label = (state ?? '').trim();
    const current = this.activity.get(name);
    if (!label) {
      if (!current) return;
      this.activity.delete(name);
    } else {
      if (current && current.state === label) return;
      this.activity.set(name, { author: name, state: label, since: new Date().toISOString() });
    }
    const chunk = activityChunk(this.activitySnapshot());
    for (const client of this.clients) client.write(chunk);
  }

  activitySnapshot(): ActivityEntry[] {
    return [...this.activity.values()];
  }

  /** Add a client, replaying buffered message events after lastEventId and
   *  sending the current presence snapshot once. Returns an unsubscribe. */
  subscribe(client: SseClient, lastEventId = 0): () => void {
    if (this.closed) {
      client.close?.(); // the conversation was torn down between context resolution and here
      return () => {};
    }
    for (const entry of this.buffer) {
      if (entry.id > lastEventId) client.write(entry.chunk);
    }
    if (this.activity.size) client.write(activityChunk(this.activitySnapshot()));
    this.clients.add(client);
    return () => void this.clients.delete(client);
  }

  /** End every open stream and drop all clients. Used when the conversation is
   *  deleted, so live browsers stop reconnecting to something that's gone. */
  close(): void {
    this.closed = true;
    for (const client of this.clients) client.close?.();
    this.clients.clear();
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
