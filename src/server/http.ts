import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import type { ConversationMetadata, ProjectMetadata, RoundtableEvent } from '../types.ts';
import { type AgentConfigInput, type AgentDto, type AgentKind, isAgentKind } from '../agents/record.ts';
import { renderMarkdown } from './render.ts';
import { cspHeader } from './security.ts';
import type { RedactingLogger } from './logging.ts';
import type { ActivityEntry, SseClient } from './sse.ts';
import { isRecord } from '../storage/sidecar.ts';

export interface ConversationView {
  readOnly: boolean;
  events: readonly RoundtableEvent[];
  /** The conversation's event count: the cursor for incremental reads and SSE. */
  cursor: number;
}

export interface SayIdentity {
  /** Required display model, e.g. `Claude Opus 4.8` or `user`. */
  model: string;
  /** Optional short room name used to distinguish multiple agents on one model. */
  name?: string;
}

/** A conversation row in the sidebar: its metadata plus the agent kinds currently active in it. */
export interface ConversationSidebarSummary extends ConversationMetadata {
  activeAgentKinds?: AgentKind[];
}

/** A project with its conversations embedded; one sidebar group. */
export interface ProjectWithConversations {
  project: ProjectMetadata;
  conversations: ConversationSidebarSummary[];
}

/** Business surface the HTTP layer drives. startup.ts assembles the real
 *  implementation over the stores + SSE; tests inject a fake. Conversations are
 *  addressed by their globally-unique id (the agent contract); projects gate and
 *  group them for the human sidebar. */
export interface RoundtableApp {
  listProjects(): Promise<ProjectWithConversations[]>;
  addProject(path: string): Promise<{ ok: true; project: ProjectMetadata } | { ok: false; error: string }>;
  removeProject(projectId: string): Promise<{ ok: true } | { ok: false; error: string; status?: 404 | 503 }>;
  createConversation(projectId: string, title: string): Promise<{ ok: true; conversation: ConversationMetadata } | { ok: false; error: string }>;
  deleteConversation(conversationId: string): Promise<{ ok: true } | { ok: false; error: string; status?: 404 | 503 }>;
  renameConversation(conversationId: string, title: string): Promise<{ ok: true; conversation: ConversationMetadata } | { ok: false; error: string; status?: 400 | 404 }>;
  view(conversationId: string): Promise<ConversationView | null>;
  say(conversationId: string, identity: SayIdentity, text: string): Promise<{ ok: true; cursor: number } | { ok: false; error: string }>;
  setActivity(conversationId: string, author: string, state: string | null): Promise<{ ok: true } | { ok: false; error: string }>;
  getActivity(conversationId: string): Promise<ActivityEntry[] | null>;
  subscribeProjects(client: SseClient): Promise<() => void>;
  subscribe(conversationId: string, client: SseClient, lastEventId: number): Promise<(() => void) | null>;
  listAgents(conversationId: string): Promise<{ tmuxAvailable: boolean; agents: AgentDto[] } | null>;
  addAgent(conversationId: string, kind: AgentKind, config?: AgentConfigInput): Promise<{ ok: true; agent: AgentDto } | { ok: false; error: string; status: 400 | 404 | 429 | 503 }>;
  configureAgent(conversationId: string, instanceId: string, config: AgentConfigInput): Promise<{ ok: boolean; error?: string; status?: 400 | 404 | 429 | 503 }>;
  resumeAgent(conversationId: string, instanceId: string): Promise<{ ok: boolean; error?: string; status?: 400 | 404 | 429 | 503 }>;
  stopAgent(conversationId: string, instanceId: string): Promise<{ ok: boolean; error?: string; status?: 404 | 503 }>;
  removeAgent(conversationId: string, instanceId: string): Promise<{ ok: boolean; error?: string; status?: 404 | 503 }>;
}

export interface ServerDeps {
  app: RoundtableApp;
  logger: RedactingLogger;
  bindHost: string;
  port: number;
  staticDir?: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost']);
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

type JsonReadResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string };

/** Build the loopback HTTP server. Refuses any non-loopback bind host. */
export function createServer(deps: ServerDeps): http.Server {
  if (!LOOPBACK.has(deps.bindHost)) throw new Error('roundtable only binds to a loopback address');
  const expectedOrigin = `http://${deps.bindHost}:${deps.port}`;

  const header = (req: http.IncomingMessage, name: string): string | null => {
    const value = req.headers[name];
    return typeof value === 'string' ? value : null;
  };
  // CSRF guard for state changes: a browser always sends Origin on cross-site
  // fetch, so a present-but-foreign Origin is refused; a non-browser client
  // (the agents) sends none and is allowed. Loopback bind is the outer boundary.
  const crossSite = (req: http.IncomingMessage): boolean => {
    const origin = header(req, 'origin');
    if (origin === null) return false; // non-browser client (the agents) sends none
    try {
      const url = new URL(origin);
      // Accept either loopback alias (127.0.0.1, localhost) on our port, since the
      // user may open the UI under either; refuse everything else.
      return !(
        url.protocol === 'http:' &&
        LOOPBACK.has(url.hostname) &&
        url.port === String(deps.port)
      );
    } catch {
      return true; // unparseable Origin; refuse
    }
  };

  return http.createServer((req, res) => {
    res.setHeader('Content-Security-Policy', cspHeader());
    void handle(req, res).catch((err) => {
      deps.logger.log(`request error: ${String(err)}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', expectedOrigin);
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

    const seg = url.pathname.slice('/api/'.length).split('/').filter(Boolean);
    const [resource, id, action] = seg;

    // CSRF guard: state changes (POST/DELETE) from a foreign Origin are refused;
    // GET reads and the agents' no-Origin requests pass.
    if ((resource === 'projects' || resource === 'conversations') && req.method !== 'GET' && crossSite(req)) {
      return forbidden(res);
    }

    if (resource === 'projects') {
      if (id === 'events' && !action && req.method === 'GET') {
        return openSubscribedSse(req, res, (client) => deps.app.subscribeProjects(client));
      }
      if (!id) {
        if (req.method === 'GET') {
          const projects = await deps.app.listProjects();
          return json(res, 200, { projects: projects.map(projectDTO) });
        }
        if (req.method === 'POST') {
          const body = await readJson(req);
          if (!body.ok) return json(res, body.status, { error: body.error });
          const result = await deps.app.addProject(String(body.value.path ?? ''));
          return result.ok ? json(res, 200, { project: projectSummary(result.project) }) : json(res, 400, { error: result.error });
        }
      } else if (action === 'conversations' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body.ok) return json(res, body.status, { error: body.error });
        const result = await deps.app.createConversation(id, String(body.value.title ?? ''));
        return result.ok ? json(res, 200, { conversation: conversationSummary(result.conversation) }) : json(res, 400, { error: result.error });
      } else if (!action && req.method === 'DELETE') {
        const result = await deps.app.removeProject(id);
        return result.ok ? json(res, 200, result) : result.status === 503 ? json(res, 503, { error: result.error }) : notFound(res);
      }
    }

    if (resource === 'conversations') {
      if (!id) {
        return notFound(res); // the flat list and create moved under /api/projects
      } else if (!action && req.method === 'GET') {
        const view = await deps.app.view(id);
        return view ? json(res, 200, viewDTO(view)) : notFound(res);
      } else if (!action && req.method === 'DELETE') {
        const result = await deps.app.deleteConversation(id);
        return result.ok ? json(res, 200, result) : result.status === 503 ? json(res, 503, { error: result.error }) : notFound(res);
      } else if (!action && req.method === 'PATCH') {
        const body = await readJson(req);
        if (!body.ok) return json(res, body.status, { error: body.error });
        const result = await deps.app.renameConversation(id, String(body.value.title ?? ''));
        return result.ok ? json(res, 200, { conversation: conversationSummary(result.conversation) }) : json(res, result.status ?? 404, { error: result.error });
      } else if (action === 'messages' && req.method === 'GET') {
        const view = await deps.app.view(id);
        if (!view) return notFound(res);
        const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
        return json(res, 200, { messages: view.events.slice(since).map(messageDTO), cursor: view.cursor });
      } else if (action === 'events' && req.method === 'GET') {
        return openSse(req, res, id);
      } else if (action === 'say' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body.ok) return json(res, body.status, { error: body.error });
        const result = await deps.app.say(id, sayIdentity(body.value), String(body.value.text ?? ''));
        return json(res, result.ok ? 200 : 400, result);
      } else if (action === 'activity' && req.method === 'GET') {
        const active = await deps.app.getActivity(id);
        return active ? json(res, 200, { active }) : notFound(res);
      } else if (action === 'activity' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body.ok) return json(res, body.status, { error: body.error });
        const state = body.value.state == null ? null : String(body.value.state);
        const result = await deps.app.setActivity(id, String(body.value.author ?? ''), state);
        return json(res, result.ok ? 200 : 400, result);
      } else if (action === 'agents') {
        const instanceId = seg[3];
        const sub = seg[4];
        if (!instanceId && req.method === 'GET') {
          const result = await deps.app.listAgents(id);
          return result ? json(res, 200, result) : notFound(res);
        } else if (!instanceId && req.method === 'POST') {
          const body = await readJson(req);
          if (!body.ok) return json(res, body.status, { error: body.error });
          if (!isAgentKind(body.value.kind)) return json(res, 400, { error: 'unknown agent kind' });
          const result = await deps.app.addAgent(id, body.value.kind, agentConfig(body.value));
          return result.ok ? json(res, 200, { agent: result.agent }) : json(res, result.status, { error: result.error });
        } else if (instanceId && req.method === 'PATCH' && !sub) {
          const body = await readJson(req);
          if (!body.ok) return json(res, body.status, { error: body.error });
          const result = await deps.app.configureAgent(id, instanceId, agentConfig(body.value));
          return agentMutationResult(res, result);
        } else if (instanceId && req.method === 'DELETE' && !sub) {
          const result = await deps.app.removeAgent(id, instanceId);
          return agentMutationResult(res, result);
        } else if (instanceId && req.method === 'POST' && sub === 'resume') {
          const result = await deps.app.resumeAgent(id, instanceId);
          return agentMutationResult(res, result);
        } else if (instanceId && req.method === 'POST' && sub === 'stop') {
          const result = await deps.app.stopAgent(id, instanceId);
          return agentMutationResult(res, result);
        }
      }
    }

    return notFound(res);
  }

  async function openSse(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const lastEventId = Number(header(req, 'last-event-id')) || 0;
    return openSubscribedSse(req, res, (client) => deps.app.subscribe(id, client, lastEventId));
  }

  async function openSubscribedSse(req: http.IncomingMessage, res: http.ServerResponse, subscribe: (client: SseClient) => Promise<(() => void) | null>): Promise<void> {
    const queued: string[] = [];
    let open = false;
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    const onClose = () => {
      closed = true;
      const fn = unsubscribe;
      unsubscribe = null;
      fn?.();
    };
    req.on('close', onClose);
    const client: SseClient = {
      write: (chunk) => {
        if (!open) queued.push(chunk);
        else {
          try { res.write(chunk); } catch { /* client gone */ }
        }
      },
      close: () => {
        if (!open) closed = true;
        else {
          try { res.end(); } catch { /* already ended */ }
        }
      },
    };
    const subscribed = await subscribe(client);
    if (!subscribed) {
      req.off('close', onClose);
      if (closed) return;
      return notFound(res);
    }
    if (closed) {
      req.off('close', onClose);
      subscribed();
      try { res.end(); } catch { /* already ended */ }
      return;
    }
    unsubscribe = () => {
      req.off('close', onClose);
      subscribed();
    };
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.statusCode = 200;
    open = true;
    for (const chunk of queued) res.write(chunk);
    if (closed) return void res.end();
    res.write(': connected\n\n');
  }

  function agentMutationResult(res: http.ServerResponse, result: { ok: boolean; error?: string; status?: 400 | 404 | 429 | 503 }): void {
    return result.ok ? json(res, 200, { ok: true }) : json(res, result.status ?? 404, { error: result.error ?? 'not found' });
  }

  async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
    const staticDir = deps.staticDir;
    if (!staticDir) return notFound(res);
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (rel.includes('..')) return notFound(res);
    try {
      if (rel === 'app.js' || rel.endsWith('.ts')) {
        const source = await readFile(join(staticDir, rel === 'app.js' ? 'app.ts' : rel), 'utf8');
        return sendText(res, 200, stripTypeScriptTypes(source), 'application/javascript');
      }
      const body = await readFile(join(staticDir, rel), 'utf8');
      const type = rel.endsWith('.css') ? 'text/css' : rel.endsWith('.js') ? 'application/javascript' : 'text/html';
      return sendText(res, 200, body, type);
    } catch {
      return notFound(res);
    }
  }
}

// DTO serialization (display-safe)

function conversationSummary(meta: ConversationSidebarSummary) {
  return {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    lastActivityAt: meta.lastActivityAt,
    readOnly: meta.readOnly ?? false,
    activeAgentKinds: meta.activeAgentKinds ?? [],
  };
}

/** The project's own fields. `path` carries the full absolute path so the sidebar
 *  can disambiguate projects that share a basename. */
function projectSummary(project: ProjectMetadata) {
  return { id: project.id, path: project.path, title: project.title };
}

/** A sidebar group: the project plus its conversations, already activity-ordered
 *  by the service. */
function projectDTO(group: ProjectWithConversations) {
  return { ...projectSummary(group.project), conversations: group.conversations.map(conversationSummary) };
}

/** The raw event as agents polling /messages consume it; no render tree. */
function messageDTO(event: RoundtableEvent) {
  const base = { id: event.id, type: event.type, timestamp: event.timestamp };
  return event.type === 'message' ? { ...base, author: event.author, text: event.body } : base;
}

/** The browser view event: messageDTO plus the display-safe render tree. */
function eventDTO(event: RoundtableEvent) {
  return { ...messageDTO(event), content: renderMarkdown(event.body) };
}

function viewDTO(view: ConversationView) {
  return { readOnly: view.readOnly, events: view.events.map(eventDTO), cursor: view.cursor };
}

function sayIdentity(body: Record<string, unknown>): SayIdentity {
  const model = String(body.model ?? '');
  const name = body.name == null ? '' : String(body.name);
  return name.trim() ? { model, name } : { model };
}

/** Extract the launch overrides from a create/edit body; the coordinator is the
 *  single validator. Present keys map to a string or `null` (clear); absent = unchanged. */
function agentConfig(body: Record<string, unknown>): AgentConfigInput {
  const config: AgentConfigInput = {};
  for (const field of ['model', 'effort', 'permissionMode', 'approvalPolicy'] as const) {
    if (field in body) config[field] = body[field] == null ? null : String(body[field]);
  }
  return config;
}

// HTTP helpers

async function readJson(req: http.IncomingMessage): Promise<JsonReadResult> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_JSON_BODY_BYTES) return { ok: false, status: 413, error: 'request body too large' };
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks, bytes).toString('utf8');
  if (!text) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed) && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
  } catch {
    // fall through to the uniform 400 below
  }
  return { ok: false, status: 400, error: 'invalid JSON body' };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function sendText(res: http.ServerResponse, status: number, body: string, contentType: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function notFound(res: http.ServerResponse): void {
  json(res, 404, { error: 'not found' });
}

function forbidden(res: http.ServerResponse): void {
  json(res, 403, { error: 'cross-origin request refused' });
}
