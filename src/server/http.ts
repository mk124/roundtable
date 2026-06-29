import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import type { ConversationMetadata, RoundtableEvent } from '../types.ts';
import { renderMarkdown } from './render.ts';
import { cspHeader } from './security.ts';
import type { RedactingLogger } from './logging.ts';
import type { ActivityEntry, SseClient } from './sse.ts';

export interface ConversationView {
  readOnly: boolean;
  events: readonly RoundtableEvent[];
  /** The conversation's event count: the cursor for incremental reads and SSE. */
  cursor: number;
}

/** Business surface the HTTP layer drives. startup.ts assembles the real
 *  implementation over the store + SSE; tests inject a fake. */
export interface RoundtableApp {
  listConversations(): Promise<ConversationMetadata[]>;
  createConversation(title: string): Promise<{ ok: true; conversation: ConversationMetadata } | { ok: false; error: string }>;
  deleteConversation(conversationId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  view(conversationId: string): Promise<ConversationView | null>;
  say(conversationId: string, author: string, text: string): Promise<{ ok: true; cursor: number } | { ok: false; error: string }>;
  setActivity(conversationId: string, author: string, state: string | null): Promise<{ ok: true } | { ok: false; error: string }>;
  getActivity(conversationId: string): Promise<ActivityEntry[] | null>;
  subscribe(conversationId: string, client: SseClient, lastEventId: number): Promise<(() => void) | null>;
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

/** Build the loopback HTTP server. Refuses any non-loopback bind host (R31). */
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
      return true; // unparseable Origin → refuse
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

    if (resource === 'conversations') {
      // CSRF guard: refuse any state change (POST/DELETE) from a foreign Origin;
      // GET reads and the agents' no-Origin requests pass (see crossSite above).
      if (req.method !== 'GET' && crossSite(req)) return forbidden(res);
      if (!id) {
        if (req.method === 'GET') {
          const list = await deps.app.listConversations();
          return json(res, 200, { conversations: list.map(conversationSummary) });
        }
        if (req.method === 'POST') {
          const body = await readJson(req);
          if (!body.ok) return json(res, body.status, { error: body.error });
          const result = await deps.app.createConversation(String(body.value.title ?? ''));
          return result.ok ? json(res, 200, { conversation: conversationSummary(result.conversation) }) : json(res, 400, { error: result.error });
        }
      } else if (!action && req.method === 'GET') {
        const view = await deps.app.view(id);
        return view ? json(res, 200, viewDTO(view)) : notFound(res);
      } else if (!action && req.method === 'DELETE') {
        const result = await deps.app.deleteConversation(id);
        return result.ok ? json(res, 200, result) : notFound(res);
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
        const result = await deps.app.say(id, String(body.value.author ?? ''), String(body.value.text ?? ''));
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
      }
    }

    return notFound(res);
  }

  async function openSse(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.statusCode = 200;
    const lastEventId = Number(header(req, 'last-event-id')) || 0;
    const client: SseClient = {
      write: (chunk) => { try { res.write(chunk); } catch { /* client gone */ } },
      close: () => { try { res.end(); } catch { /* already ended */ } },
    };
    const unsubscribe = await deps.app.subscribe(id, client, lastEventId);
    if (!unsubscribe) return notFound(res);
    res.write(': connected\n\n');
    req.on('close', unsubscribe);
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

// ── DTO serialization (display-safe; R28, R33) ────────────────────────────

function conversationSummary(meta: ConversationMetadata) {
  return { id: meta.id, title: meta.title, createdAt: meta.createdAt, lastActivityAt: meta.lastActivityAt, readOnly: meta.readOnly ?? false };
}

/** The raw event as agents polling /messages consume it — no render tree. */
function messageDTO(event: RoundtableEvent) {
  const base = { id: event.id, type: event.type, timestamp: event.timestamp };
  return event.type === 'message' ? { ...base, author: event.author, text: event.body } : base;
}

/** The browser view event: messageDTO plus the display-safe render tree (R28). */
function eventDTO(event: RoundtableEvent) {
  return { ...messageDTO(event), content: renderMarkdown(event.body) };
}

function viewDTO(view: ConversationView) {
  return { readOnly: view.readOnly, events: view.events.map(eventDTO), cursor: view.cursor };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

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
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
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
  res.end(body);
}

function notFound(res: http.ServerResponse): void {
  json(res, 404, { error: 'not found' });
}

function forbidden(res: http.ServerResponse): void {
  json(res, 403, { error: 'cross-origin request refused' });
}
