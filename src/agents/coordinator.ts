/**
 * The agent lifecycle protocol: the concurrency core of the feature.
 *
 * It owns the per-conversation agent records and the `AgentSupervisor`, and keeps
 * the lifecycle rules in one place: record writes use the conversation lock,
 * spawn/capture runs outside that lock, finalize is keyed on a per-spawn token,
 * only one spawn may be in flight per instance, auto-stop follows watcher count,
 * and stop selection is based on live tmux sessions.
 *
 * It is deliberately decoupled from `RoundtableService` (which injects the lock, the
 * stores, the cwd resolution, and the live watcher count) so the protocol is testable
 * in isolation against simulated races.
 */
import { shortId } from '../ids.ts';
import type { ConversationStore } from '../conversations/store.ts';
import {
  isApprovalPolicyFor,
  isEffortFor,
  isPermissionModeFor,
  isSafeAgentModel,
  type AgentApprovalPolicy,
  type AgentConfigInput,
  type AgentDto,
  type AgentEffort,
  type AgentKind,
  type AgentPermissionMode,
  type AgentRecord,
  type AgentStatus,
} from './record.ts';
import { parseAgentSessionName } from './session-name.ts';
import { newSessionId } from './session-capture.ts';
import type { AgentSupervisor, LaunchResult } from './supervisor.ts';

export interface CoordinatorDeps {
  supervisor: AgentSupervisor;
  /** Serialize a function on a conversation's lock (= RoundtableService.mutate). */
  lock: <T>(convId: string, fn: () => Promise<T>) => Promise<T>;
  /** The conversation's agents store, or null when the id is unknown. */
  storeFor: (convId: string) => Promise<ConversationStore | null>;
  /** Store plus project working directory for launchable conversations. */
  agentContextFor: (convId: string) => Promise<{ store: ConversationStore; cwd: string } | null>;
  /** Absolute path of the roundtable repo (for the skill reference in the prompt). */
  roundtablePath: string;
  /** Runtime base URL for browser-launched agents. */
  baseUrl: string;
  /** Live browser-watcher count for a conversation (SSE clients). */
  watcherCount: (convId: string) => number;
  onChange?: (convId: string) => void;
  onError?: (err: unknown) => void;
  graceMs?: number;
  /** Unattended-inactivity window; defaults to the shared DEFAULT_STOP_MS. Tests inject a short one. */
  inactivityMs?: number;
  cap?: number;
}

type AddResult =
  | { ok: true; agent: AgentDto }
  | { ok: false; error: string; status: 400 | 404 | 429 | 503 };

type ManageAgentResult = { ok: boolean; error?: string; status?: 400 | 404 | 429 | 503 };
type ClosedResult = { ok: false; error: string; status: 503 };
type LaunchConfig = { model?: string; effort?: AgentEffort; permissionMode?: AgentPermissionMode; approvalPolicy?: AgentApprovalPolicy };
type SpawnSpec = { instanceId: string; kind: AgentKind; name: string; mode: 'new' | 'resume'; sessionId?: string; spawnId: number; cwd: string } & LaunchConfig;
type FinalizeSpec = Pick<SpawnSpec, 'instanceId' | 'kind' | 'mode' | 'spawnId'>;

const NAME_PREFIX: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
/** Both auto-stop timers — the no-watcher grace stop and the unattended-inactivity
 *  stop — reuse the same 60-minute duration. */
const DEFAULT_STOP_MS = 3_600_000;
export const STOP_UNCONFIRMED = 'agent stop could not be confirmed';
const SHUTTING_DOWN = 'server is shutting down';
const CORRUPT_AGENTS = 'agent records are corrupt';
const INVALID_CONFIG = 'invalid agent configuration';

export class AgentCoordinator {
  private readonly d: CoordinatorDeps;
  private readonly graceMs: number;
  private readonly inactivityMs: number;
  private readonly cap: number;
  /** Per-instance in-flight spawn token; presence means a spawn is pending, so a
   *  second add/resume for the same instance must not start (one in-flight per id). */
  private readonly inflight = new Map<string, number>();
  private spawnCounter = 0;
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-conversation unattended-inactivity window: a pending stop timer, or null
   *  while live-agent presence pauses the stop. An entry exists only for
   *  conversations that may have live agents. */
  private readonly inactivity = new Map<string, ReturnType<typeof setTimeout> | null>();
  private readonly operations = new Set<Promise<void>>();
  private closed = false;

  constructor(deps: CoordinatorDeps) {
    this.d = deps;
    this.graceMs = deps.graceMs ?? DEFAULT_STOP_MS;
    this.inactivityMs = deps.inactivityMs ?? DEFAULT_STOP_MS;
    this.cap = deps.cap ?? 10;
  }

  async list(convId: string, tmuxAvailable?: boolean): Promise<AgentDto[] | null> {
    const available = tmuxAvailable ?? (await this.d.supervisor.available());
    const sessions = available ? await this.d.supervisor.liveSessions(convId) : null;
    const live = sessions && (liveByConversation(sessions).get(convId) ?? new Set<string>());
    const records = await this.syncWithLive(convId, live);
    return records?.map((rec) => this.toDto(convId, rec, live)) ?? null;
  }

  /** List many conversations against a single tmux snapshot, so a sidebar listing
   *  costs one list-sessions query instead of one subprocess per conversation.
   *  An id that no longer resolves yields no agents. */
  async listMany(convIds: string[]): Promise<Map<string, AgentDto[]>> {
    const sessions = (await this.d.supervisor.available()) ? await this.d.supervisor.liveSessions() : null;
    const byConv = sessions && liveByConversation(sessions);
    const entries = await Promise.all(convIds.map(async (convId) => {
      const live = byConv && (byConv.get(convId) ?? new Set<string>());
      const records = await this.syncWithLive(convId, live);
      return [convId, records?.map((rec) => this.toDto(convId, rec, live)) ?? []] as const;
    }));
    return new Map(entries);
  }

  /** Add a new agent: persist `starting`, then launch and finalize in the background. */
  async add(convId: string, kind: AgentKind, config?: AgentConfigInput): Promise<AddResult> {
    return this.trackOperation(() => this.addImpl(convId, kind, config));
  }

  private async addImpl(convId: string, kind: AgentKind, config?: AgentConfigInput): Promise<AddResult> {
    if (this.closed) return closedResult();
    if (!(await this.d.agentContextFor(convId))) return { ok: false, error: 'unknown conversation', status: 404 };
    if (!(await this.d.supervisor.available())) return { ok: false, error: 'tmux is not available', status: 503 };

    // Validate before reserving a capture slot, so a direct service caller cannot
    // burn a slot (or persist a record) with values the HTTP route would reject.
    const launch = resolveConfig(kind, {}, config ?? {});
    if (launch === null) return { ok: false, error: INVALID_CONFIG, status: 400 };

    const instanceId = shortId();
    const sessionId = newSessionId(kind) ?? undefined;
    if (!this.d.supervisor.reserveCapture(convId, instanceId, kind)) {
      return { ok: false, error: 'too many agents starting; try again', status: 429 };
    }

    const name = `${NAME_PREFIX[kind]}-${instanceId.slice(0, 4)}`;
    type PreparedAdd =
      | { outcome: 'closed' }
      | { outcome: 'corrupt' }
      | { outcome: 'gone' }
      | { outcome: 'full' }
      | { outcome: 'go'; record: AgentRecord; spawnId: number; cwd: string };
    let prepared: PreparedAdd;
    try {
      prepared = await this.d.lock<PreparedAdd>(convId, async () => {
        if (this.closed) return { outcome: 'closed' };
        const ctx = await this.d.agentContextFor(convId);
        if (!ctx) return { outcome: 'gone' };
        const records = await this.readWritableAgents(ctx.store, convId);
        if (records === null) return { outcome: 'corrupt' };
        if (records.length >= this.cap) return { outcome: 'full' };
        const id = ++this.spawnCounter;
        const record: AgentRecord = { kind, instanceId, name, createdAt: new Date().toISOString(), status: 'starting', ...launch };
        if (sessionId) record.sessionId = sessionId;
        await ctx.store.writeAgents(convId, [...records, record]);
        this.changed(convId);
        this.inflight.set(key(convId, instanceId), id);
        return { outcome: 'go', record, spawnId: id, cwd: ctx.cwd };
      });
    } catch (err) {
      this.d.supervisor.releaseCapture(convId, instanceId);
      throw err;
    }

    if (prepared.outcome !== 'go') {
      this.d.supervisor.releaseCapture(convId, instanceId);
      switch (prepared.outcome) {
        case 'closed':
          return closedResult();
        case 'corrupt':
          return { ok: false, error: CORRUPT_AGENTS, status: 503 };
        case 'gone':
          return { ok: false, error: 'unknown conversation', status: 404 };
        case 'full':
          return { ok: false, error: `at most ${this.cap} agents per conversation`, status: 429 };
      }
    }
    if (this.closed) {
      await this.cancelPrepared(convId, instanceId, prepared.spawnId, 'new');
      this.d.supervisor.releaseCapture(convId, instanceId);
      return closedResult();
    }
    this.launchInBackground(convId, { instanceId, kind, name, mode: 'new', sessionId, spawnId: prepared.spawnId, cwd: prepared.cwd, ...launch });
    return { ok: true, agent: this.toDto(convId, prepared.record, null) };
  }

  /** Resume a stopped record: persist `starting`, then launch and finalize in the background. */
  async resume(convId: string, instanceId: string): Promise<ManageAgentResult> {
    return this.trackOperation(() => this.resumeImpl(convId, instanceId));
  }

  private async resumeImpl(convId: string, instanceId: string): Promise<ManageAgentResult> {
    if (this.closed) return closedResult();
    if (!(await this.d.agentContextFor(convId))) return { ok: false, error: 'unknown conversation', status: 404 };
    if (!(await this.d.supervisor.available())) return { ok: false, error: 'tmux is not available', status: 503 };

    type Prepared =
      | { outcome: 'closed' }
      | { outcome: 'corrupt' }
      | { outcome: 'gone' }
      | { outcome: 'skip' }
      | { outcome: 'busy' }
      | { outcome: 'not-resumable' }
      | { outcome: 'go'; rec: AgentRecord; launchMode: 'new' | 'resume'; spawnId: number; cwd: string };
    let prepared: Prepared;
    try {
      prepared = await this.d.lock<Prepared>(convId, async () => {
        if (this.closed) return { outcome: 'closed' };
        const ctx = await this.d.agentContextFor(convId);
        if (!ctx) return { outcome: 'gone' };
        const records = await this.readWritableAgents(ctx.store, convId);
        if (records === null) return { outcome: 'corrupt' };
        const rec = records.find((r) => r.instanceId === instanceId);
        if (!rec) return { outcome: 'gone' };
        if (this.inflight.has(key(convId, instanceId))) return { outcome: 'skip' };
        if (!canResume(rec)) return { outcome: 'not-resumable' };
        const launchMode = rec.sessionId ? 'resume' : 'new';
        const sessionId = rec.sessionId ?? newSessionId(rec.kind) ?? undefined;
        if (launchMode === 'new' && !this.d.supervisor.reserveCapture(convId, instanceId, rec.kind)) return { outcome: 'busy' };
        const id = ++this.spawnCounter;
        await ctx.store.writeAgents(convId, records.map((r) => (r.instanceId === instanceId ? startingRecord(r, sessionId) : r)));
        this.changed(convId);
        this.inflight.set(key(convId, instanceId), id);
        return { outcome: 'go', rec: startingRecord(rec, sessionId), launchMode, spawnId: id, cwd: ctx.cwd };
      });
    } catch (err) {
      this.d.supervisor.releaseCapture(convId, instanceId);
      throw err;
    }

    if (prepared.outcome === 'closed') return closedResult();
    if (prepared.outcome === 'corrupt') return { ok: false, error: CORRUPT_AGENTS, status: 503 };
    if (prepared.outcome === 'gone') return { ok: false, error: 'unknown agent', status: 404 };
    if (prepared.outcome === 'not-resumable') return { ok: false, error: 'agent is not resumable', status: 400 };
    if (prepared.outcome === 'busy') return { ok: false, error: 'too many agents starting; try again', status: 429 };
    if (prepared.outcome !== 'go') return { ok: true };
    if (this.closed) {
      await this.cancelPrepared(convId, instanceId, prepared.spawnId, 'resume');
      this.d.supervisor.releaseCapture(convId, instanceId);
      return closedResult();
    }
    this.launchInBackground(convId, {
      instanceId,
      kind: prepared.rec.kind,
      name: prepared.rec.name,
      mode: prepared.launchMode,
      sessionId: prepared.rec.sessionId,
      spawnId: prepared.spawnId,
      cwd: prepared.cwd,
      model: prepared.rec.model,
      effort: prepared.rec.effort,
      permissionMode: prepared.rec.permissionMode,
      approvalPolicy: prepared.rec.approvalPolicy,
    });
    return { ok: true };
  }

  /** Edit a stopped/errored agent's launch overrides; applies on the next resume.
   *  Runs under the conversation lock, so it can never race a spawn's finalize. */
  async configure(convId: string, instanceId: string, config: AgentConfigInput): Promise<ManageAgentResult> {
    return this.trackOperation(() => this.configureImpl(convId, instanceId, config));
  }

  private async configureImpl(convId: string, instanceId: string, config: AgentConfigInput): Promise<ManageAgentResult> {
    if (this.closed) return closedResult();
    const store = await this.d.storeFor(convId);
    if (!store) return { ok: false, error: 'unknown conversation', status: 404 };
    return this.d.lock(convId, async () => {
      if (this.closed) return closedResult();
      const records = await this.readWritableAgents(store, convId);
      if (records === null) return { ok: false, error: CORRUPT_AGENTS, status: 503 };
      const rec = records.find((r) => r.instanceId === instanceId);
      if (!rec) return { ok: false, error: 'unknown agent', status: 404 };
      if (this.inflight.has(key(convId, instanceId)) || !isEditable(rec)) return { ok: false, error: 'agent is not editable', status: 400 };
      const resolved = resolveConfig(rec.kind, rec, config);
      if (resolved === null) return { ok: false, error: INVALID_CONFIG, status: 400 };
      await store.writeAgents(convId, records.map((r) => (r.instanceId === instanceId ? applyConfig(r, resolved) : r)));
      this.changed(convId);
      return { ok: true };
    });
  }

  /** Stop a running agent: kill its session, keep the record as `stopped`. */
  async stop(convId: string, instanceId: string): Promise<{ ok: boolean; error?: string; status?: 404 | 503 }> {
    return this.trackOperation(() => this.terminate(convId, instanceId, 'stop'));
  }

  /** Remove an agent: kill its session (if any) and delete the record. */
  async remove(convId: string, instanceId: string): Promise<{ ok: boolean; error?: string; status?: 404 | 503 }> {
    return this.trackOperation(() => this.terminate(convId, instanceId, 'remove'));
  }

  /** Stop every live agent of a conversation (used by delete / project removal),
   *  before the SSE close that bypasses the watcher-edge stop. */
  async stopConversation(convId: string): Promise<boolean> {
    this.clearGrace(convId);
    this.clearInactivity(convId);
    return (await this.d.supervisor.stopAll(convId)).ok;
  }

  /** A watcher arrived: cancel any pending grace-stop for the conversation. */
  onWatch(convId: string): void {
    if (this.closed) return;
    this.clearGrace(convId);
  }

  /** The last watcher left: schedule a grace-stop (re-checked at fire time). */
  onUnwatch(convId: string): void {
    if (this.closed) return;
    this.maybeScheduleStop(convId);
  }

  /** Reconcile persisted records against live tmux sessions at startup: adopt a
   *  running record whose session is alive, reset every other non-terminal record
   *  to `stopped`, and kill orphan sessions with no record. */
  async reconcile(convIds: string[]): Promise<void> {
    const available = await this.d.supervisor.available();
    if (!available) return;
    const liveSessions = await this.d.supervisor.liveSessions();
    if (liveSessions === null) return;
    const liveByConv = liveByConversation(liveSessions);
    const reconciled = await Promise.all(convIds.map((convId) => this.d.lock(convId, async () => {
      const store = await this.d.storeFor(convId);
      if (!store) return { convId, unreadable: false, known: [] as string[] };
      const live = liveByConv.get(convId) ?? new Set();
      const records = await store.readAgentsForReconcile(convId);
      if (records === null) {
        return { convId, unreadable: true, known: [] as string[] };
      }
      const { records: synced, changed, stopIds } = reconcileRecords(records, live, (instanceId) => this.inflight.has(key(convId, instanceId)));
      const { records: next, stopped } = await this.applyStops(convId, synced, stopIds);
      if (changed || stopped) {
        await store.writeAgents(convId, next);
        this.changed(convId);
      }
      if (next.some((rec) => rec.status === 'running')) this.startInactivity(convId); // adopt a still-running session
      return { convId, unreadable: false, known: next.map((rec) => key(convId, rec.instanceId)) };
    })));
    const known = new Set(reconciled.flatMap((result) => result.known));
    const unreadable = new Set(reconciled.filter((result) => result.unreadable).map((result) => result.convId));
    await Promise.all(liveSessions.map(async (name) => {
      const parsed = parseAgentSessionName(name);
      if (parsed && !unreadable.has(parsed.convId) && !known.has(key(parsed.convId, parsed.instanceId)) && !(await this.d.supervisor.stop(parsed.convId, parsed.instanceId, parsed.kind))) {
        this.reportStopFailure(parsed.convId, parsed.instanceId);
      }
    }));
  }

  /** Stop every agent across all conversations (shutdown). */
  async stopAll(): Promise<void> {
    this.closed = true;
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    for (const timer of this.inactivity.values()) if (timer) clearTimeout(timer);
    this.inactivity.clear();
    const result = await this.d.supervisor.stopAll();
    while (this.operations.size > 0) await Promise.all([...this.operations]);
    const final = await this.d.supervisor.stopAll();
    if (!result.ok || !final.ok) {
      const err = new Error(STOP_UNCONFIRMED);
      this.d.onError?.(err);
      throw err;
    }
  }

  // Internals

  private async terminate(convId: string, instanceId: string, mode: 'stop' | 'remove') {
    if (this.closed) return { ok: false as const, error: SHUTTING_DOWN, status: 503 as const };
    const store = await this.d.storeFor(convId);
    if (!store) return { ok: false as const, error: 'unknown conversation', status: 404 as const };
    return this.d.lock(convId, async () => {
      if (this.closed) return { ok: false as const, error: SHUTTING_DOWN, status: 503 as const };
      const records = await this.readWritableAgents(store, convId);
      if (records === null) return { ok: false as const, error: CORRUPT_AGENTS, status: 503 as const };
      const rec = records.find((r) => r.instanceId === instanceId);
      if (!rec) return { ok: false as const, error: 'unknown agent', status: 404 as const };
      const stopped = await this.d.supervisor.stop(convId, instanceId, rec.kind); // kills session + aborts any capture
      if (!stopped) return { ok: false as const, error: STOP_UNCONFIRMED, status: 503 as const };
      const next: AgentRecord[] = mode === 'stop'
        ? records.map((r) => (r.instanceId === instanceId ? { ...r, status: 'stopped' } : r))
        : records.filter((r) => r.instanceId !== instanceId);
      await store.writeAgents(convId, next);
      if (!next.some((r) => r.status === 'running')) this.clearInactivity(convId); // last live agent gone
      this.changed(convId);
      return { ok: true as const };
    });
  }

  private async spawnAndFinalize(convId: string, s: SpawnSpec): Promise<void> {
    let launch: LaunchResult = { started: false, sessionId: null };
    try {
      launch = await this.d.supervisor.launch({ convId, roundtablePath: this.d.roundtablePath, baseUrl: this.d.baseUrl, ...s });
    } catch {
      launch = { started: false, sessionId: null };
    } finally {
      try {
        await this.finalize(convId, s, launch);
      } finally {
        if (this.inflight.get(key(convId, s.instanceId)) === s.spawnId) this.inflight.delete(key(convId, s.instanceId));
        this.d.supervisor.releaseCapture(convId, s.instanceId);
      }
    }
  }

  private launchInBackground(convId: string, s: SpawnSpec): void {
    const op = this.spawnAndFinalize(convId, s).then(
      () => this.maybeScheduleStop(convId),
      (err) => this.d.onError?.(err),
    );
    const done = op.then(() => undefined, () => undefined);
    this.operations.add(done);
    void done.finally(() => this.operations.delete(done));
  }

  private async finalize(convId: string, s: FinalizeSpec, launch: LaunchResult): Promise<void> {
    await this.d.lock(convId, async () => {
      if (this.inflight.get(key(convId, s.instanceId)) !== s.spawnId) return; // superseded; leave it alone
      this.inflight.delete(key(convId, s.instanceId));
      const store = await this.d.storeFor(convId);
      if (!store) {
        if (launch.started && !(await this.d.supervisor.stop(convId, s.instanceId, s.kind))) this.reportStopFailure(convId, s.instanceId);
        return;
      }
      const records = await this.readWritableAgents(store, convId);
      if (records === null) {
        this.reportCorruptAgents(convId);
        return;
      }
      const rec = records.find((r) => r.instanceId === s.instanceId);
      if (!rec || rec.status !== 'starting') {
        // stopped/removed during the spawn window. The in-flight guard guarantees
        // the session under this name is ours, so killing it is safe.
        if (!(await this.d.supervisor.stop(convId, s.instanceId, s.kind))) this.reportStopFailure(convId, s.instanceId);
        return;
      }
      if (launch.stopFailed) this.reportStopFailure(convId, s.instanceId);
      const next: AgentStatus = launch.started ? 'running' : this.closed || s.mode === 'resume' ? 'stopped' : 'errored';
      const updated: AgentRecord = { ...rec, status: next, sessionId: launch.sessionId ?? rec.sessionId };
      // The marker reflects only the latest attempt: cleared on start, set when a
      // configured launch never started.
      delete updated.launchError;
      if (!launch.started && isConfigured(rec)) updated.launchError = 'configured-launch-failed';
      // A live agent starts the inactivity window. Armed before the record is
      // published so anything that observes `running` finds the window in place.
      if (next === 'running') this.startInactivity(convId);
      await store.writeAgents(convId, records.map((r) => (r.instanceId === s.instanceId ? updated : r)));
      this.changed(convId);
    });
  }

  private maybeScheduleStop(convId: string): void {
    if (this.closed) return;
    if (this.d.watcherCount(convId) > 0) return;
    this.clearGrace(convId);
    const timer = setTimeout(() => {
      void this.fireGraceStop(convId).catch((err) => this.d.onError?.(err));
    }, this.graceMs);
    if (typeof timer === 'object') timer.unref?.();
    this.graceTimers.set(convId, timer);
  }

  private async fireGraceStop(convId: string): Promise<void> {
    this.graceTimers.delete(convId);
    await this.d.lock(convId, async () => {
      if (this.d.watcherCount(convId) > 0) return; // a watcher returned; keep them running
      await this.stopLiveAgents(convId);
    });
  }

  private clearGrace(convId: string): void {
    const timer = this.graceTimers.get(convId);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(convId);
    }
  }

  // Unattended-inactivity stop: independent of watcher count, it stops a
  // conversation's live agents once the window elapses with no successful message, no
  // live-agent presence, and no accepted foreground-view heartbeat.

  /** Launch/resume/reconcile entry: begin the window, but never overwrite an active
   *  presence pause — a working agent's presence covers every live agent in the
   *  conversation, so only a presence-clear (notePresence) re-arms it. */
  private startInactivity(convId: string): void {
    if (this.inactivity.get(convId) === null) return; // paused by presence
    this.armInactivity(convId);
  }

  /** Begin or reset the inactivity window for a conversation with live agents;
   *  replaces any prior timer so a fresh window starts now. The timer's own identity
   *  marks it current: a fire that no longer matches the map entry was superseded. */
  private armInactivity(convId: string): void {
    if (this.closed) return;
    const prev = this.inactivity.get(convId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      void this.fireInactivityStop(convId, timer).catch((err) => this.d.onError?.(err));
    }, this.inactivityMs);
    if (typeof timer === 'object') timer.unref?.();
    this.inactivity.set(convId, timer);
  }

  /** A durable message or accepted foreground heartbeat: reset the window, unless
   *  live-agent presence is currently pausing it. No-op without live agents. */
  noteActivity(convId: string): void {
    if (this.inactivity.get(convId)) this.armInactivity(convId);
  }

  /** Presence crossed the empty/non-empty boundary for a conversation with live
   *  agents: non-empty pauses the stop; clearing the last entry starts a fresh window. */
  notePresence(convId: string, active: boolean): void {
    const current = this.inactivity.get(convId);
    if (current === undefined) return; // no live agents
    if (!active) return this.armInactivity(convId);
    if (current) clearTimeout(current);
    this.inactivity.set(convId, null); // paused
  }

  private clearInactivity(convId: string): void {
    const timer = this.inactivity.get(convId);
    if (timer) clearTimeout(timer);
    this.inactivity.delete(convId);
  }

  private async fireInactivityStop(convId: string, timer: ReturnType<typeof setTimeout>): Promise<void> {
    await this.d.lock(convId, async () => {
      if (this.inactivity.get(convId) !== timer) return; // superseded by activity, a pause, or a clear
      this.inactivity.delete(convId);
      await this.stopLiveAgents(convId);
    });
  }

  /** Stop every live session for the conversation and fold the confirmed stops back
   *  into the records. Shared by the watcher-grace and inactivity stop paths; assumes
   *  the conversation lock is held. */
  private async stopLiveAgents(convId: string): Promise<void> {
    const store = await this.d.storeFor(convId);
    const result = await this.d.supervisor.stopAll(convId);
    if (!result.ok || result.sessions === null) {
      this.reportStopFailure(convId, '*');
      return;
    }
    this.clearInactivity(convId); // no live agents remain, so no window to keep
    if (!store || result.sessions.length === 0) return;
    const stopped = new Set(result.sessions.map((name) => parseAgentSessionName(name)?.instanceId));
    const records = await this.readWritableAgents(store, convId);
    if (records === null) {
      this.reportCorruptAgents(convId);
      return;
    }
    await store.writeAgents(convId, records.map((r) => (stopped.has(r.instanceId) ? { ...r, status: 'stopped' } : r)));
    this.changed(convId);
  }

  private async trackOperation<T>(fn: () => Promise<T>): Promise<T> {
    const op = Promise.resolve().then(fn);
    const done = op.then(() => undefined, () => undefined);
    this.operations.add(done);
    try {
      return await op;
    } finally {
      this.operations.delete(done);
    }
  }

  private async readWritableAgents(store: ConversationStore, convId: string): Promise<AgentRecord[] | null> {
    const records = await store.readAgentsForReconcile(convId);
    if (records === null) this.reportCorruptAgents(convId);
    return records;
  }

  /** Undo a prepared-but-never-launched spawn (server closed mid-spawn): drop a new
   *  record entirely, or reset a resumed one back to `stopped`. */
  private async cancelPrepared(convId: string, instanceId: string, spawnId: number, mode: 'new' | 'resume'): Promise<void> {
    await this.d.lock(convId, async () => {
      if (this.inflight.get(key(convId, instanceId)) !== spawnId) return;
      this.inflight.delete(key(convId, instanceId));
      const store = await this.d.storeFor(convId);
      if (!store) return;
      const records = await this.readWritableAgents(store, convId);
      if (records === null) return;
      await store.writeAgents(
        convId,
        mode === 'new'
          ? records.filter((r) => r.instanceId !== instanceId)
          : records.map((r) => (r.instanceId === instanceId ? { ...r, status: 'stopped' as const } : r)),
      );
      this.changed(convId);
    });
  }

  /** Kill the sessions reconcile flagged as orphaned and fold the confirmed stops
   *  back into the records; returns the updated records and whether any stop landed. */
  private async applyStops(convId: string, records: AgentRecord[], stopIds: AgentRecord[]): Promise<{ records: AgentRecord[]; stopped: boolean }> {
    const results = await Promise.all(stopIds.map(async (rec) => ({
      rec,
      ok: await this.d.supervisor.stop(convId, rec.instanceId, rec.kind),
    })));
    const stopped = new Set<string>();
    for (const { rec, ok } of results) {
      if (ok) stopped.add(rec.instanceId);
      else this.reportStopFailure(convId, rec.instanceId);
    }
    const next = stopped.size ? records.map((rec) => (stopped.has(rec.instanceId) ? { ...rec, status: 'stopped' as const } : rec)) : records;
    return { records: next, stopped: stopped.size > 0 };
  }

  /** Reconcile one conversation's records against `live` (its live instance ids)
   *  under the conversation lock; a null `live` means tmux could not answer, so
   *  the records are returned as stored. */
  private async syncWithLive(convId: string, live: ReadonlySet<string> | null): Promise<AgentRecord[] | null> {
    if (live === null) {
      return this.d.lock(convId, async () => {
        const current = await this.d.storeFor(convId);
        return current ? current.readAgents(convId) : null;
      });
    }
    return this.d.lock(convId, async () => {
      const current = await this.d.storeFor(convId);
      if (!current) return null;
      const records = await current.readAgents(convId);
      const synced = reconcileRecords(records, live, (instanceId) => this.inflight.has(key(convId, instanceId)));
      const { records: next, stopped } = await this.applyStops(convId, synced.records, synced.stopIds);
      if (synced.changed || stopped) {
        await current.writeAgents(convId, next);
        this.changed(convId);
      }
      return next;
    });
  }

  private reportStopFailure(convId: string, instanceId: string): void {
    this.d.onError?.(new Error(`${STOP_UNCONFIRMED} for ${convId}/${instanceId}`));
  }

  private reportCorruptAgents(convId: string): void {
    this.d.onError?.(new Error(`${CORRUPT_AGENTS} for ${convId}`));
  }

  private changed(convId: string): void {
    this.d.onChange?.(convId);
  }

  /** Map a record to its DTO. The attach command ships only when the session is in
   *  `live` (null = tmux unavailable): `starting` alone does not mean attachable. */
  private toDto(convId: string, rec: AgentRecord, live: ReadonlySet<string> | null): AgentDto {
    const dto: AgentDto = { instanceId: rec.instanceId, kind: rec.kind, name: rec.name, status: rec.status, resumable: canResume(rec), createdAt: rec.createdAt };
    if (rec.sessionId) dto.sessionId = rec.sessionId;
    if (rec.model) dto.model = rec.model;
    if (rec.effort) dto.effort = rec.effort;
    if (rec.permissionMode) dto.permissionMode = rec.permissionMode;
    if (rec.approvalPolicy) dto.approvalPolicy = rec.approvalPolicy;
    if (rec.launchError) dto.launchError = rec.launchError;
    if (live?.has(rec.instanceId)) dto.attachCommand = `tmux attach -t ${this.d.supervisor.sessionName(convId, rec.instanceId, rec.kind)}`;
    return dto;
  }
}

function canResume(rec: AgentRecord): boolean {
  return rec.status === 'errored' || (rec.status === 'stopped' && Boolean(rec.sessionId));
}

/** `configure` window: stopped or errored; in-flight spawns are checked separately. */
function isEditable(rec: AgentRecord): boolean {
  return rec.status === 'stopped' || rec.status === 'errored';
}

function isConfigured(rec: AgentRecord): boolean {
  return Boolean(rec.model || rec.effort || rec.permissionMode || rec.approvalPolicy);
}

const INVALID = Symbol('invalid');

/** Merge a raw input over a base: `undefined` keeps the base, `null`/`''` clears,
 *  anything else must validate for the kind (else null). Create and edit share
 *  this path, so a value create accepts can never be rejected on edit. */
function resolveConfig(kind: AgentKind, base: LaunchConfig, input: AgentConfigInput): LaunchConfig | null {
  const model = applyField(input.model, base.model, (v): v is string => isSafeAgentModel(v));
  const effort = applyField(input.effort, base.effort, (v): v is AgentEffort => isEffortFor(kind, v));
  const permissionMode = applyField(input.permissionMode, base.permissionMode, (v): v is AgentPermissionMode => isPermissionModeFor(kind, v));
  const approvalPolicy = applyField(input.approvalPolicy, base.approvalPolicy, (v): v is AgentApprovalPolicy => isApprovalPolicyFor(kind, v));
  if (model === INVALID || effort === INVALID || permissionMode === INVALID || approvalPolicy === INVALID) return null;
  const out: LaunchConfig = {};
  if (model !== undefined) out.model = model;
  if (effort !== undefined) out.effort = effort;
  if (permissionMode !== undefined) out.permissionMode = permissionMode;
  if (approvalPolicy !== undefined) out.approvalPolicy = approvalPolicy;
  return out;
}

function applyField<T extends string>(input: string | null | undefined, base: T | undefined, valid: (v: string) => v is T): T | undefined | typeof INVALID {
  if (input === undefined) return base;
  if (input === null || input === '') return undefined;
  return valid(input) ? input : INVALID;
}

/** Rewrite the record's overrides to exactly `config`; dropped fields return to the
 *  CLI default. */
function applyConfig(rec: AgentRecord, config: LaunchConfig): AgentRecord {
  const { model, effort, permissionMode, approvalPolicy, ...rest } = rec;
  return { ...rest, ...config };
}

function closedResult(): ClosedResult {
  return { ok: false, error: SHUTTING_DOWN, status: 503 };
}

function startingRecord(rec: AgentRecord, sessionId: string | undefined): AgentRecord {
  return sessionId ? { ...rec, status: 'starting', sessionId } : { ...rec, status: 'starting' };
}

const key = (convId: string, instanceId: string) => `${convId}/${instanceId}`;

/** Group live agent session names into instance-id sets keyed by conversation. */
function liveByConversation(sessions: string[]): Map<string, Set<string>> {
  const byConv = new Map<string, Set<string>>();
  for (const name of sessions) {
    const parsed = parseAgentSessionName(name);
    if (!parsed) continue;
    const set = byConv.get(parsed.convId) ?? new Set<string>();
    set.add(parsed.instanceId);
    byConv.set(parsed.convId, set);
  }
  return byConv;
}

function reconcileRecords(records: AgentRecord[], live: ReadonlySet<string>, isInFlight: (instanceId: string) => boolean): { records: AgentRecord[]; changed: boolean; stopIds: AgentRecord[] } {
  let changed = false;
  const stopIds: AgentRecord[] = [];
  const next = records.map((rec): AgentRecord => {
    const alive = live.has(rec.instanceId);
    if ((rec.status === 'starting' || rec.status === 'running') && !alive) {
      if (rec.status === 'starting' && isInFlight(rec.instanceId)) return rec;
      changed = true;
      return { ...rec, status: 'stopped' };
    }
    if (rec.status === 'errored' && alive) {
      changed = true;
      return { ...rec, status: 'running' };
    }
    if (rec.status === 'starting' && alive && !isInFlight(rec.instanceId)) {
      stopIds.push(rec);
      return rec;
    }
    return rec;
  });
  return { records: next, changed, stopIds };
}
