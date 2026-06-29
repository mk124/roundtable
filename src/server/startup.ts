import { chmod, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConversationLog, newEventId } from '../storage/event-log.ts';
import { StorageLock } from '../storage/lock.ts';
import { ConversationStore } from '../conversations/store.ts';
import { ProjectStore } from '../projects/store.ts';
import type { ProjectMetadata, SizeLimits } from '../types.ts';
import { createServer, type ProjectWithConversations, type RoundtableApp } from './http.ts';
import { RedactingLogger } from './logging.ts';
import { SseHub, type SseClient } from './sse.ts';

interface ConversationContext {
  log: ConversationLog;
  sse: SseHub;
  /** The store this conversation belongs to — its project's ConversationStore. */
  store: ConversationStore;
}

/**
 * Wires storage + SSE into the RoundtableApp the HTTP layer drives. roundtable is
 * a passive chat room: `say` appends a message to the conversation's Markdown log
 * and broadcasts a cursor bump; `view` reads the log. No process is ever spawned.
 *
 * Conversations live per project under `~/.roundtable/projects/<encoded>/conversations/`.
 * The agent contract stays by-id: a globally-unique conversation id is resolved to
 * its owning project's ConversationStore via an in-memory map, rebuilt by scanning
 * registered projects on a cold miss. Contexts are keyed by conversation id (which
 * is globally unique), so the concurrency model is unchanged.
 */
export class RoundtableService implements RoundtableApp {
  private readonly projects: ProjectStore;
  private readonly limits?: SizeLimits;
  private readonly stores = new Map<string, ConversationStore>(); // projectId → store
  private readonly convToProject = new Map<string, string>(); // conversationId → projectId
  private readonly contexts = new Map<string, ConversationContext>();
  private readonly opening = new Map<string, Promise<ConversationContext | null>>();
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly removing = new Set<string>(); // project ids mid-teardown — never (re)resolved

  /** `limits` overrides the per-conversation size caps; production uses the
   *  defaults, tests inject small caps to exercise the read-only path. */
  constructor(deps: { home: string; limits?: SizeLimits }) {
    this.projects = new ProjectStore(deps.home);
    this.limits = deps.limits;
  }

  /** The full sidebar: every registered project with its conversations embedded,
   *  ordered by recent activity (a project's newest conversation, else addedAt). */
  async listProjects(): Promise<ProjectWithConversations[]> {
    const projects = await this.projects.list();
    const groups = await Promise.all(
      projects.map(async (project) => ({ project, conversations: await this.storeFor(project).list() })),
    );
    const activity = (g: ProjectWithConversations) => g.conversations[0]?.lastActivityAt ?? g.project.addedAt;
    return groups.sort((a, b) => activity(b).localeCompare(activity(a)));
  }

  async addProject(path: string) {
    try {
      return { ok: true as const, project: await this.projects.add(path) };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }

  /** Deregister a project (non-destructive): delete its `project.json` so cold
   *  resolution can no longer reach it, then tear down every conversation still
   *  mapped to it — closing SSE, dropping contexts, and pruning the id map. The
   *  transcript files are retained on disk; the ids simply stop resolving. */
  async removeProject(id: string) {
    const project = await this.projects.get(id);
    if (!project) return { ok: false as const, error: 'unknown project' };
    // Tombstone the id for the whole teardown so a concurrent resolveStore can't
    // re-create its store from a stale project list and resurrect the conversation.
    this.removing.add(id);
    try {
      await this.projects.remove(id);
      // The sidecar is gone, so resolveStore's cold scan can no longer reach this
      // project. Drain any in-flight first-access opens so the contexts they create
      // become visible, then evict every conversation still mapped to it — including
      // ones that warmed during the teardown — closing its SSE and dropping it.
      await Promise.allSettled([...this.opening.values()]);
      for (const [convId, pid] of [...this.convToProject]) {
        if (pid !== id) continue;
        await this.mutate(convId, async () => {
          this.contexts.get(convId)?.sse.close();
          this.contexts.delete(convId);
          this.convToProject.delete(convId);
        });
      }
      this.stores.delete(id);
    } finally {
      this.removing.delete(id);
    }
    return { ok: true as const };
  }

  async createConversation(projectId: string, title: string) {
    const project = await this.projects.get(projectId);
    if (!project) return { ok: false as const, error: 'unknown project' };
    try {
      const conversation = await this.storeFor(project).create(title);
      // The project may have been deregistered while the transcript was being
      // written. If so, drop the store we just (re)created and refuse, so a removed
      // project never gains a resolvable conversation; the file stays on disk like
      // any other retained transcript.
      if (!(await this.projects.get(project.id))) {
        this.stores.delete(project.id);
        return { ok: false as const, error: 'unknown project' };
      }
      this.convToProject.set(conversation.id, project.id);
      return { ok: true as const, conversation };
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
      const store = await this.resolveStore(conversationId);
      const removed = store ? await store.delete(conversationId) : false;
      if (!removed) return { ok: false as const, error: 'unknown conversation' };
      this.contexts.get(conversationId)?.sse.close();
      this.contexts.delete(conversationId);
      this.convToProject.delete(conversationId);
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
        // Persist the flip once so the sidebar's read-only badge survives a restart.
        if (!wasReadOnly) await ctx.store.update(conversationId, { readOnly: true });
        return { ok: false as const, error: 'conversation is read-only' };
      }

      const cursor = ctx.log.events.length;
      // The message is durably appended; the lastActivityAt sidecar is best-effort
      // sidebar ordering, so a failed write must not turn a stored message into a
      // 500 that makes the client retry and duplicate it.
      await ctx.store.update(conversationId, { lastActivityAt: new Date().toISOString() }).catch(() => {});
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
   *  Presence is in-memory, so an unopened conversation simply has none. This
   *  resolves directly rather than opening a context, keeping a frequent presence
   *  poll cheap; the trade-off is that a poll racing its project's removal may read
   *  an empty snapshot for one cycle before the id stops resolving — never a stale
   *  message, since the message paths go through the coordinated teardown. */
  async getActivity(conversationId: string) {
    const store = await this.resolveStore(conversationId);
    if (!store || !(await store.get(conversationId))) return null;
    return this.contexts.get(conversationId)?.sse.activitySnapshot() ?? [];
  }

  async subscribe(conversationId: string, client: SseClient, lastEventId: number) {
    const ctx = await this.context(conversationId);
    return ctx ? ctx.sse.subscribe(client, lastEventId) : null;
  }

  close(): void {
    for (const ctx of this.contexts.values()) ctx.sse.close();
    this.contexts.clear();
    this.convToProject.clear();
    this.stores.clear();
  }

  /** A project's ConversationStore, cached by project id. */
  private storeFor(project: ProjectMetadata): ConversationStore {
    let store = this.stores.get(project.id);
    if (!store) {
      store = new ConversationStore(this.projects.projectDir(project));
      this.stores.set(project.id, store);
    }
    return store;
  }

  /** Resolve a conversation id to its owning project's store. Warm ids hit the
   *  in-memory map (O(1)); a cold miss scans registered projects once and caches
   *  the result. A deregistered project drops out of the scan, so its ids stop
   *  resolving — invisible, but their files are retained on disk. */
  private async resolveStore(conversationId: string): Promise<ConversationStore | null> {
    const known = this.convToProject.get(conversationId);
    if (known) {
      const store = this.stores.get(known);
      if (store) return store;
      this.convToProject.delete(conversationId); // project gone — fall back to a rescan
    }
    for (const project of await this.projects.list()) {
      if (this.removing.has(project.id)) continue; // mid-teardown — don't re-create its store
      const store = this.storeFor(project);
      if (await store.get(conversationId)) {
        this.convToProject.set(conversationId, project.id);
        return store;
      }
    }
    return null;
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
    const store = await this.resolveStore(conversationId);
    if (!store) return null;
    const meta = await store.get(conversationId);
    if (!meta) return null;
    const log = await ConversationLog.open(store.conversationFilePath(meta), this.limits);
    if (log.readOnly && !meta.readOnly) await store.update(conversationId, { readOnly: true });
    const ctx: ConversationContext = { log, sse: new SseHub(), store };
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
  await mkdir(join(home, 'projects'), { recursive: true, mode: 0o700 });
}

/** Tighten storage directories to user-private; fail closed if they cannot be secured. */
async function verifyPermissions(home: string): Promise<void> {
  await securePrivateDir(home, '~/.roundtable');
  await securePrivateDir(join(home, 'projects'), '~/.roundtable/projects');
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
