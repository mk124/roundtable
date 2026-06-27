import { chmod, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConversationLog, newEventId } from '../storage/event-log.ts';
import { StorageLock } from '../storage/lock.ts';
import { ConversationStore } from '../conversations/store.ts';
import type { SizeLimits } from '../types.ts';
import { createServer, type RoundtableApp } from './http.ts';
import { RedactingLogger } from './logging.ts';
import { SseHub, type SseClient } from './sse.ts';

interface ConversationContext {
  log: ConversationLog;
  sse: SseHub;
}

/**
 * Wires storage + SSE into the RoundtableApp the HTTP layer drives. roundtable is
 * a passive chat room: `say` appends a message to the conversation's Markdown log
 * and broadcasts a cursor bump; `view` reads the log. No process is ever spawned.
 * Conversations live flat under `~/.roundtable/conversations/`; contexts are
 * opened lazily and cached.
 */
export class RoundtableService implements RoundtableApp {
  private readonly store: ConversationStore;
  private readonly limits?: SizeLimits;
  private readonly contexts = new Map<string, ConversationContext>();
  private readonly opening = new Map<string, Promise<ConversationContext | null>>();
  private readonly mutations = new Map<string, Promise<void>>();

  /** `limits` overrides the per-conversation size caps; production uses the
   *  defaults, tests inject small caps to exercise the read-only path. */
  constructor(deps: { home: string; limits?: SizeLimits }) {
    this.store = new ConversationStore(deps.home);
    this.limits = deps.limits;
  }

  listConversations() {
    return this.store.list();
  }

  async createConversation(title: string) {
    try {
      return { ok: true as const, conversation: await this.store.create(title) };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }

  /** Delete a conversation: remove its files, close its live SSE streams, and
   *  drop the cached context. Unknown id is reported, not thrown. */
  async deleteConversation(conversationId: string) {
    return this.mutate(conversationId, async () => {
      // Let any in-flight first-access open settle first, so it can't recreate the
      // file and cache a ghost context after we delete (concurrent delete + open).
      await this.opening.get(conversationId)?.catch(() => {});
      const removed = await this.store.delete(conversationId);
      if (!removed) return { ok: false as const, error: 'unknown conversation' };
      this.contexts.get(conversationId)?.sse.close();
      this.contexts.delete(conversationId);
      return { ok: true as const };
    });
  }

  async view(conversationId: string) {
    const ctx = await this.context(conversationId);
    if (!ctx) return null;
    return { readOnly: ctx.log.readOnly, events: [...ctx.log.events], cursor: ctx.log.events.length };
  }

  async say(conversationId: string, author: string, text: string) {
    const name = author.trim();
    const body = text;
    if (!name || !body.trim()) return { ok: false as const, error: 'author and text are required' };
    return this.mutate(conversationId, async () => {
      const ctx = await this.context(conversationId);
      if (!ctx) return { ok: false as const, error: 'unknown conversation' };

      const wasReadOnly = ctx.log.readOnly;
      const res = await ctx.log.append({ id: newEventId(), type: 'message', timestamp: new Date().toISOString(), author: name, body });
      if (res.outcome === 'rejected') return { ok: false as const, error: 'message exceeds the size limit' };
      if (res.outcome === 'conversation-readonly') {
        // Persist the flip once so the sidebar's read-only badge survives a restart (R48).
        if (!wasReadOnly) await this.store.update(conversationId, { readOnly: true });
        return { ok: false as const, error: 'conversation is read-only' };
      }

      const cursor = ctx.log.events.length;
      await this.store.update(conversationId, { lastActivityAt: new Date().toISOString() });
      ctx.sse.publish(cursor, { cursor }); // clients refetch the view on any bump
      ctx.sse.setActivity(name, null); // posting a message ends that author's presence
      return { ok: true as const, cursor };
    });
  }

  /** Set or clear an author's ephemeral presence (a null state clears it). */
  async setActivity(conversationId: string, author: string, state: string | null) {
    if (!author.trim()) return { ok: false as const, error: 'author is required' };
    return this.mutate(conversationId, async () => {
      const ctx = await this.context(conversationId);
      if (!ctx) return { ok: false as const, error: 'unknown conversation' };
      ctx.sse.setActivity(author, state);
      return { ok: true as const };
    });
  }

  /** Current presence snapshot, or null when the conversation is unknown.
   *  Presence is in-memory, so an unopened conversation simply has none. */
  async getActivity(conversationId: string) {
    if (!(await this.store.get(conversationId))) return null;
    return this.contexts.get(conversationId)?.sse.activitySnapshot() ?? [];
  }

  async subscribe(conversationId: string, client: SseClient, lastEventId: number) {
    const ctx = await this.context(conversationId);
    return ctx ? ctx.sse.subscribe(client, lastEventId) : null;
  }

  close(): void {
    for (const ctx of this.contexts.values()) ctx.sse.close();
    this.contexts.clear();
  }

  /** Resolve a conversation's context, opening it lazily. Concurrent first-access
   *  callers share one in-flight open (via `opening`) so a conversation never ends
   *  up with two ConversationLog/SseHub instances and a split, partly-invisible
   *  state. */
  private context(conversationId: string): Promise<ConversationContext | null> {
    const existing = this.contexts.get(conversationId);
    if (existing) return Promise.resolve(existing);
    const inflight = this.opening.get(conversationId);
    if (inflight) return inflight;
    const open = this.openContext(conversationId).finally(() => this.opening.delete(conversationId));
    this.opening.set(conversationId, open);
    return open;
  }

  private async openContext(conversationId: string): Promise<ConversationContext | null> {
    const meta = await this.store.get(conversationId);
    if (!meta) return null;
    const log = await ConversationLog.open(this.store.conversationFilePath(meta), this.limits);
    if (log.readOnly && !meta.readOnly) await this.store.update(conversationId, { readOnly: true });
    const ctx: ConversationContext = { log, sse: new SseHub() };
    this.contexts.set(conversationId, ctx);
    return ctx;
  }

  private mutate<T>(conversationId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(conversationId) ?? Promise.resolve();
    const run = previous.then(action, action);
    const settled = run.then(() => undefined, () => undefined);
    this.mutations.set(conversationId, settled);
    void settled.finally(() => {
      if (this.mutations.get(conversationId) === settled) this.mutations.delete(conversationId);
    });
    return run;
  }
}

// ── Startup sequence ────────────────────────────────────────────────────

async function ensureRoots(home: string): Promise<void> {
  // recursive creates ~/.roundtable too; both land at 0o700 when newly made.
  await mkdir(join(home, 'conversations'), { recursive: true, mode: 0o700 });
}

/** Tighten storage directories to user-private; fail closed if they cannot be secured. */
async function verifyPermissions(home: string): Promise<void> {
  await securePrivateDir(home, '~/.roundtable');
  await securePrivateDir(join(home, 'conversations'), '~/.roundtable/conversations');
}

async function securePrivateDir(path: string, label: string): Promise<void> {
  const info = await stat(path);
  if (info.mode & 0o077) {
    try {
      await chmod(path, 0o700);
    } catch {
      throw new Error(`cannot secure ${label} to private permissions`);
    }
  }
}

export interface StartedServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Boot the local chat room: secure roots, take the single-writer lock, build the
 * passive service over storage + SSE, and listen on loopback. Returns null when
 * the lock is held by a live instance (refuse a second writer).
 */
export async function startServer(opts: { home?: string; bindHost?: string; port?: number } = {}): Promise<StartedServer | null> {
  const home = opts.home ?? join(homedir(), '.roundtable');
  await ensureRoots(home);
  await verifyPermissions(home);

  const lock = await StorageLock.acquire(home);
  if (!lock) return null;

  const logger = new RedactingLogger();
  const service = new RoundtableService({ home });
  const bindHost = opts.bindHost ?? '127.0.0.1';
  const port = opts.port ?? 8787;
  const staticDir = join(dirname(new URL(import.meta.url).pathname), '..', 'web');

  try {
    const server = createServer({ app: service, logger, bindHost, port, staticDir });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); // surface a bind failure (e.g. EADDRINUSE) instead of crashing
      server.listen(port, bindHost, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return {
      url: `http://${bindHost}:${port}`,
      close: async () => {
        try {
          const closed = new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          });
          service.close();
          server.closeAllConnections();
          await closed;
        } finally {
          await lock.release();
        }
      },
    };
  } catch (err) {
    await lock.release(); // never keep the single-writer lock if we failed to bind
    throw err;
  }
}

if (import.meta.main) {
  const started = await startServer().catch((err: Error) => {
    console.error(`roundtable failed to start: ${err.message}`);
    process.exit(1);
  });
  if (!started) {
    console.error('roundtable is already running for this home (single-writer lock held).');
    process.exit(1);
  }
  console.log(`roundtable: ${started.url}`);
}
