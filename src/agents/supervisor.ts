/**
 * tmux-backed process owner. Each agent runs in a detached, uniquely-named tmux
 * session (`roundtable-<namespace>-<convId>-<kind>-<instanceId>`). This class is
 * the only place that touches tmux or the OS; it knows nothing about records or
 * HTTP. AgentCoordinator owns lifecycle state, while startup.ts wires the pair
 * into the service.
 *
 * tmux is reached through the injected `TmuxRunner` so the class is unit-testable
 * without a real tmux.
 */
import { spawn } from 'node:child_process';
import { constants, type Dirent } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildCommand } from './commands.ts';
import { agentSessionInScope, agentSessionName } from './session-name.ts';
import { prepareTrustedWorkspace, type TrustPreparer } from './trust.ts';
import { sessionDir, sessionIdFromFile } from './session-capture.ts';
import type { AgentKind } from './record.ts';

const DEFAULT_CAPTURE_TIMEOUT_MS = 60_000;
const DEFAULT_TMUX_TIMEOUT_MS = 5_000;

/** Run a tmux subcommand; resolves with the exit code and trimmed stdout. */
export type TmuxRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;
export type CommandResolver = (command: string) => Promise<string>;

function realTmux(timeoutMs: number): TmuxRunner {
  return (args) =>
    new Promise((resolve) => {
      const child = spawn('tmux', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      let settled = false;
      const finish = (result: { code: number; stdout: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ code: 124, stdout: stdout.trim() });
      }, timeoutMs);
      timer.unref();
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('error', () => finish({ code: 127, stdout: '' }));
      child.on('close', (code) => finish({ code: code ?? 0, stdout: stdout.trim() }));
    });
}

export interface LaunchSpec {
  convId: string;
  instanceId: string;
  kind: AgentKind;
  name?: string;
  mode: 'new' | 'resume';
  sessionId?: string;
  /** Working directory for the agent; the conversation's project path. */
  cwd: string;
  /** Absolute path of the roundtable repo (for the skill reference in the prompt). */
  roundtablePath: string;
  /** Runtime base URL for the local server. */
  baseUrl: string;
}

export interface LaunchResult {
  /** Whether tmux created a live session for this agent. */
  started: boolean;
  /** The CLI's own session id, when known/captured. */
  sessionId: string | null;
  /** True when a failed/aborted launch may have left a live tmux session behind. */
  stopFailed?: boolean;
}

interface PendingLaunch {
  controller: AbortController;
  done: Promise<LaunchResult>;
}

interface SessionStart {
  started: boolean;
  stopFailed?: boolean;
}

interface AntigravityMatchRow {
  hasConv: number | null;
  hasName: number | null;
}

export interface AgentOwner {
  lockPath: string;
  pid: number;
  token: string;
}

export interface SupervisorOptions {
  tmux?: TmuxRunner;
  resolveCommand?: CommandResolver;
  namespace?: string;
  /** Required: every agent is launched under owner-monitor so it dies with the
   *  server. There is deliberately no unmanaged launch path. */
  owner: AgentOwner;
  trust?: TrustPreparer;
  /** How long to watch for a codex/agy session file before giving up (ms). */
  captureTimeoutMs?: number;
  /** Max time to wait for a tmux subcommand before treating it as failed (ms). */
  tmuxTimeoutMs?: number;
  /** Max concurrent codex/agy captures admitted before new ones are turned away. */
  captureLimit?: number;
}

export class AgentSupervisor {
  private readonly tmux: TmuxRunner;
  private readonly resolveCommand: CommandResolver;
  private readonly namespace: string;
  private readonly owner: AgentOwner;
  private readonly trust: TrustPreparer;
  private readonly captureTimeoutMs: number;
  private readonly captureLimit: number;
  private availability: boolean | null = null;

  /** Reserved capture slots, by tmux session name; admission is checked before the
   *  service persists, and released on every exit path. */
  private readonly reserved = new Set<string>();
  /** Pending launches, by tmux session name, so stop/delete can cancel even before
   *  tmux has created a session. */
  private readonly pending = new Map<string, PendingLaunch>();

  constructor(options: SupervisorOptions) {
    const tmuxTimeoutMs = options.tmuxTimeoutMs ?? DEFAULT_TMUX_TIMEOUT_MS;
    this.tmux = options.tmux ? withTimeout(options.tmux, tmuxTimeoutMs) : realTmux(tmuxTimeoutMs);
    this.resolveCommand = options.resolveCommand ?? realCommandResolver;
    this.namespace = options.namespace ?? 'local';
    this.owner = options.owner;
    this.trust = options.trust ?? prepareTrustedWorkspace;
    this.captureTimeoutMs = options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
    this.captureLimit = options.captureLimit ?? 6;
  }

  sessionName(convId: string, instanceId: string, kind: AgentKind): string {
    return agentSessionName(this.namespace, kind, convId, instanceId);
  }

  /** True once tmux is confirmed present; failures are retried so installing tmux
   *  after the server starts does not require a restart. */
  async available(): Promise<boolean> {
    if (this.availability === true) return true;
    const ok = (await this.tmux(['-V'])).code === 0;
    if (ok) this.availability = true;
    return ok;
  }

  /** Live agent session names for this namespace, optionally scoped to one conversation. */
  async liveSessions(convId?: string): Promise<string[] | null> {
    const { code, stdout } = await this.tmux(['list-sessions', '-F', '#{session_name}']);
    if (code === 124 || code === 127) return null;
    if (code !== 0 || !stdout) return [];
    return stdout.split('\n').filter((name) => agentSessionInScope(name, this.namespace, convId));
  }

  /** Stop one agent's session (and abort a pending capture for it). */
  async stop(convId: string, instanceId: string, kind?: AgentKind): Promise<boolean> {
    await this.abortLaunches(convId, instanceId);
    const live = kind ? [this.sessionName(convId, instanceId, kind)] : await this.sessionNames(convId, instanceId);
    if (live === null) return false;
    if (live.length === 0) return true;
    const results = await Promise.all(live.map((name) => this.kill(name)));
    return results.every(Boolean);
  }

  /** Stop every live agent, optionally scoped to one conversation. */
  async stopAll(convId?: string): Promise<{ ok: boolean; sessions: string[] | null }> {
    await this.abortLaunches(convId);
    const live = await this.liveSessions(convId);
    if (live === null) return { ok: false, sessions: null };
    const results = await Promise.all(live.map((name) => this.kill(name)));
    return { ok: results.every(Boolean), sessions: live };
  }

  /** Reserve a codex/agy capture slot before the service persists its record;
   *  returns false when the bounded queue is saturated. No-op for Claude. */
  reserveCapture(convId: string, instanceId: string, kind: AgentKind): boolean {
    if (sessionDir(kind) === null) return true;
    if (this.reserved.size >= this.captureLimit) return false;
    this.reserved.add(this.sessionName(convId, instanceId, kind));
    return true;
  }

  releaseCapture(convId: string, instanceId: string): void {
    for (const name of this.reserved) {
      if (agentSessionInScope(name, this.namespace, convId, instanceId)) this.reserved.delete(name);
    }
  }

  /**
   * Spawn the agent in a detached tmux session and, for codex/agy, capture its
   * session id by watching the shared session directory. Claude needs no capture
   * (its id was pre-generated and passed in). Reports tmux launch failure
   * separately from "started but no resumable CLI id was captured".
   */
  async launch(spec: LaunchSpec): Promise<LaunchResult> {
    const name = this.sessionName(spec.convId, spec.instanceId, spec.kind);
    const controller = new AbortController();
    const pending: PendingLaunch = { controller, done: Promise.resolve({ started: false, sessionId: null }) };
    pending.done = this.runLaunch(spec, controller);
    this.pending.set(name, pending);
    try {
      return await pending.done;
    } finally {
      if (this.pending.get(name) === pending) this.pending.delete(name);
    }
  }

  // Internals

  private async runLaunch(spec: LaunchSpec, controller: AbortController): Promise<LaunchResult> {
    await this.trust(spec.kind, spec.cwd);
    if (controller.signal.aborted) return { started: false, sessionId: null };
    const command = buildCommand({
      kind: spec.kind,
      mode: spec.mode,
      convId: spec.convId,
      cwd: spec.cwd,
      roundtablePath: spec.roundtablePath,
      baseUrl: spec.baseUrl,
      name: spec.name,
      sessionId: spec.sessionId,
    });
    command[0] = await this.resolveCommand(command[0]!);
    if (controller.signal.aborted) return { started: false, sessionId: null };
    const argv = this.wrapOwnerMonitor(spec, command);
    const dir = spec.sessionId ? null : sessionDir(spec.kind);
    const before = dir === null ? [] : await listSessionFiles(dir);
    return await this.launchSession(spec, argv, dir, before, controller.signal);
  }

  private async kill(name: string): Promise<boolean> {
    const killed = await this.tmux(['kill-session', '-t', name]);
    if (killed.code === 124 || killed.code === 127) return false;
    const probe = await this.tmux(['has-session', '-t', name]);
    if (probe.code === 124 || probe.code === 127) return false;
    return probe.code !== 0;
  }

  private wrapOwnerMonitor(spec: LaunchSpec, argv: string[]): string[] {
    return [
      process.execPath,
      join(spec.roundtablePath, 'src', 'agents', 'owner-monitor.ts'),
      '--lock',
      this.owner.lockPath,
      '--pid',
      String(this.owner.pid),
      '--token',
      this.owner.token,
      '--',
      ...argv,
    ];
  }

  private async newSession(spec: LaunchSpec, argv: string[]): Promise<SessionStart> {
    const name = this.sessionName(spec.convId, spec.instanceId, spec.kind);
    const created = await this.tmux(['new-session', '-d', '-s', name, '-c', spec.cwd, '--', shellCommand(argv)]);
    const probe = await this.tmux(['has-session', '-t', name]);
    if (created.code === 0 && probe.code === 0) return { started: true };
    const mayHaveStarted = created.code === 0 || probe.code === 0 || probe.code === 124 || probe.code === 127;
    if (!mayHaveStarted) return { started: false };
    return (await this.kill(name)) ? { started: false } : { started: true, stopFailed: true };
  }

  private async launchSession(spec: LaunchSpec, argv: string[], captureDir: string | null, before: string[], signal: AbortSignal): Promise<LaunchResult> {
    const name = this.sessionName(spec.convId, spec.instanceId, spec.kind);
    if (signal.aborted) return { started: false, sessionId: null };
    const start = await this.newSession(spec, argv);
    if (!start.started) return { started: false, sessionId: null };
    if (signal.aborted) {
      return (await this.kill(name)) ? { started: false, sessionId: null } : { started: true, sessionId: spec.sessionId ?? null, stopFailed: true };
    }
    if (captureDir === null) return { started: true, sessionId: spec.sessionId ?? null, ...(start.stopFailed ? { stopFailed: true } : {}) };

    const sessionId = await this.watch(spec, captureDir, before, signal);
    if (signal.aborted) {
      return (await this.kill(name)) ? { started: false, sessionId: null } : { started: true, sessionId, stopFailed: true };
    }
    if (!sessionId) {
      return (await this.kill(name)) ? { started: false, sessionId: null } : { started: false, sessionId: null, stopFailed: true };
    }
    return { started: true, sessionId, ...(start.stopFailed ? { stopFailed: true } : {}) };
  }

  private async watch(spec: LaunchSpec, dir: string, before: string[], signal: AbortSignal): Promise<string | null> {
    const deadline = this.captureTimeoutMs;
    const step = 150;
    const beforeSet = new Set(before);
    const checked = new Map<string, string>();
    for (let waited = 0; waited < deadline && !signal.aborted; waited += step) {
      await delay(step);
      const matchedIds: string[] = [];
      for (const file of await listSessionFiles(dir)) {
        if (beforeSet.has(file)) continue;
        const id = sessionIdFromFile(spec.kind, file);
        if (!id) continue;
        const signature = await sessionFileSignature(file, spec.kind);
        if (!signature || checked.get(file) === signature) continue;
        const matches = await sessionFileMatchesLaunch(file, spec);
        if (matches !== null) checked.set(file, signature);
        if (matches) matchedIds.push(id);
      }
      if (matchedIds.length === 1) return matchedIds[0]!;
    }
    return null;
  }

  private async sessionNames(convId: string, instanceId: string): Promise<string[] | null> {
    const live = await this.liveSessions(convId);
    return live === null ? null : live.filter((name) => agentSessionInScope(name, this.namespace, convId, instanceId));
  }

  private async abortLaunches(convId?: string, instanceId?: string): Promise<void> {
    const pending = [...this.pending].filter(([name]) => agentSessionInScope(name, this.namespace, convId, instanceId)).map(([, launch]) => launch);
    for (const launch of pending) launch.controller.abort();
    await Promise.all(pending.map((launch) => launch.done.catch(() => undefined)));
  }
}

function withTimeout(run: TmuxRunner, timeoutMs: number): TmuxRunner {
  return (args) =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (result: { code: number; stdout: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ code: 124, stdout: '' }), timeoutMs);
      timer.unref();
      run(args).then(finish, () => finish({ code: 127, stdout: '' }));
    });
}

const realCommandResolver: CommandResolver = async (command) => {
  if (command.includes('/')) {
    const path = resolve(command);
    await access(path, constants.X_OK);
    return path;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const path = resolve(dir, command);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`executable not found on PATH: ${command}`);
};

/** Recursively collect session-file paths under `dir` (codex nests by date,
 *  Antigravity is flat). Missing dirs read as empty. */
async function listSessionFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) names.push(...(await listSessionFiles(join(dir, entry.name))));
    else names.push(join(dir, entry.name));
  }
  return names;
}

async function fileSignature(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
}

async function sessionFileSignature(file: string, kind: AgentKind): Promise<string | null> {
  const main = await fileSignature(file);
  if (!main || kind !== 'antigravity') return main;
  return `${main}|wal:${(await fileSignature(`${file}-wal`)) ?? ''}`;
}

async function sessionFileMatchesLaunch(file: string, spec: LaunchSpec): Promise<boolean | null> {
  if (spec.kind === 'antigravity') return antigravitySessionMatchesLaunch(file, spec);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  return text.includes(spec.convId) && (!spec.name || text.includes(spec.name));
}

function antigravitySessionMatchesLaunch(file: string, spec: LaunchSpec): boolean | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
  try {
    return antigravityDbMatchesLaunch(db, spec);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function antigravityDbMatchesLaunch(db: DatabaseSync, spec: LaunchSpec): boolean {
  const name = spec.name ?? '';
  const row = db
    .prepare(
      `SELECT
         MAX(CASE
           WHEN instr(CAST(metadata AS TEXT), ?) > 0
             OR instr(CAST(task_details AS TEXT), ?) > 0
             OR instr(CAST(step_payload AS TEXT), ?) > 0
           THEN 1 ELSE 0
         END) AS hasConv,
         MAX(CASE
           WHEN ? = ''
             OR instr(CAST(metadata AS TEXT), ?) > 0
             OR instr(CAST(task_details AS TEXT), ?) > 0
             OR instr(CAST(step_payload AS TEXT), ?) > 0
           THEN 1 ELSE 0
         END) AS hasName
       FROM steps`,
    )
    .get(spec.convId, spec.convId, spec.convId, name, name, name, name) as AntigravityMatchRow | undefined;
  return row?.hasConv === 1 && row.hasName === 1;
}

const shellCommand = (argv: string[]): string =>
  ['env', '-u', 'NODE_OPTIONS', '-u', 'VSCODE_INSPECTOR_OPTIONS', ...argv].map(shellQuote).join(' ');

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
