import type { RenderNode } from '../server/render.ts';
import type { ActivityEntry } from '../server/sse.ts';

export type { ActivityEntry };

export interface EventDTO {
  id: string;
  type: 'message' | 'system';
  timestamp: string;
  author?: string;
  content?: RenderNode[];
}

export interface ViewDTO {
  readOnly: boolean;
  events: EventDTO[];
  cursor: number;
}

export interface ConversationDTO {
  id: string;
  title: string;
  readOnly: boolean;
}

export class ConversationApi {
  listConversations = () => this.get<{ conversations: ConversationDTO[] }>('/api/conversations');
  createConversation = (title: string) => this.post('/api/conversations', { title });
  deleteConversation = (id: string) => this.send('DELETE', `/api/conversations/${id}`);
  view = async (id: string): Promise<ViewDTO | null> => {
    const url = `/api/conversations/${id}`;
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${url} failed`);
    return (await res.json()) as ViewDTO;
  };
  say = (id: string, text: string) => this.post(`/api/conversations/${id}/say`, { author: 'user', text });

  private async get<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} failed`);
    return (await res.json()) as T;
  }

  private post(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
    return this.send('POST', url, body);
  }

  private async send(method: string, url: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return { ok: res.ok && data.ok !== false, error: data.error };
  }
}

export const RECONNECT_DELAY_MS = 2000;

export interface StreamHandlers {
  onOpen?: () => void;
  onMessage: () => void;
  onActivity: (active: ActivityEntry[]) => void;
  onMissing: () => void;
  onDrop: () => void;
}

export async function streamEvents(id: string, lastEventId: number, signal: AbortSignal, handlers: StreamHandlers): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/conversations/${id}/events`, { headers: { 'Last-Event-ID': String(lastEventId) }, signal });
  } catch {
    handlers.onDrop();
    return;
  }
  if (res.status === 404) {
    handlers.onMissing();
    return;
  }
  if (!res.ok || !res.body) {
    handlers.onDrop();
    return;
  }
  handlers.onOpen?.();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      break;
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      dispatchFrame(buf.slice(0, sep), handlers);
      buf = buf.slice(sep + 2);
    }
  }
  handlers.onDrop();
}

function dispatchFrame(frame: string, handlers: StreamHandlers): void {
  let event = 'message';
  let data = '';
  let hasData = false;
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      data += line.slice(5).trim();
      hasData = true;
    }
  }
  if (!hasData) return;
  if (event === 'activity') {
    try {
      handlers.onActivity((JSON.parse(data) as { active: ActivityEntry[] }).active);
    } catch {
      /* ignore a malformed frame */
    }
  } else if (event === 'message') {
    handlers.onMessage();
  }
}
