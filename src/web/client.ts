import type { RenderNode } from '../server/render.ts';
import type { ActivityEntry } from '../server/sse.ts';
import type { AgentDto, AgentKind } from '../agents/record.ts';

export type { ActivityEntry, AgentDto, AgentKind };

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
  activeAgentKinds?: AgentKind[];
}

/** A sidebar group: a registered project with its conversations embedded, already
 *  activity-ordered by the server. `path` is the full absolute path (for hover). */
export interface ProjectDTO {
  id: string;
  path: string;
  title: string;
  conversations: ConversationDTO[];
}

export class ConversationApi {
  listProjects = () => this.get<{ projects: ProjectDTO[] }>('/api/projects');
  addProject = (path: string) => this.post('/api/projects', { path });
  removeProject = (id: string) => this.send('DELETE', `/api/projects/${id}`);
  createConversation = (projectId: string, title: string) => this.post<{ conversation: ConversationDTO }>(`/api/projects/${projectId}/conversations`, { title });
  deleteConversation = (id: string) => this.send('DELETE', `/api/conversations/${id}`);
  renameConversation = (id: string, title: string) => this.send<{ conversation: ConversationDTO }>('PATCH', `/api/conversations/${id}`, { title });
  view = async (id: string): Promise<ViewDTO | null> => {
    const url = `/api/conversations/${id}`;
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${url} failed`);
    return (await res.json()) as ViewDTO;
  };
  say = (id: string, text: string) => this.post(`/api/conversations/${id}/say`, { model: 'user', text });
  listAgents = (id: string) => this.get<{ tmuxAvailable: boolean; agents: AgentDto[] }>(`/api/conversations/${id}/agents`);
  addAgent = (id: string, kind: AgentKind) => this.post<{ agent: AgentDto }>(`/api/conversations/${id}/agents`, { kind });
  resumeAgent = (id: string, instanceId: string) => this.post(`/api/conversations/${id}/agents/${instanceId}/resume`, {});
  stopAgent = (id: string, instanceId: string) => this.post(`/api/conversations/${id}/agents/${instanceId}/stop`, {});
  removeAgent = (id: string, instanceId: string) => this.send('DELETE', `/api/conversations/${id}/agents/${instanceId}`);

  private async get<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} failed`);
    return (await res.json()) as T;
  }

  private post<T extends object = Record<string, never>>(url: string, body: unknown): Promise<{ ok: boolean; error?: string } & Partial<T>> {
    return this.send('POST', url, body);
  }

  private async send<T extends object = Record<string, never>>(method: string, url: string, body?: unknown): Promise<{ ok: boolean; error?: string } & Partial<T>> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & Partial<T>;
    return { ...data, ok: res.ok && data.ok !== false, error: data.error };
  }
}

export const RECONNECT_DELAY_MS = 2000;

export interface StreamHandlers {
  onOpen?: () => void;
  onMessage: () => void;
  onActivity: (active: ActivityEntry[]) => void;
  onAgents: () => void;
  onMissing: () => void;
  onDrop: () => void;
}

export interface ProjectStreamHandlers {
  onProjects: () => void;
  onDrop: () => void;
}

/** The per-frame callbacks the SSE reader dispatches to; each stream supplies only
 *  the events it cares about, so every field is optional. */
interface FrameHandlers {
  onMessage?: () => void;
  onActivity?: (active: ActivityEntry[]) => void;
  onAgents?: () => void;
  onProjects?: () => void;
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
  await readFrames(res.body, handlers);
  handlers.onDrop();
}

export async function streamProjectEvents(signal: AbortSignal, handlers: ProjectStreamHandlers): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/projects/events', { signal });
  } catch {
    handlers.onDrop();
    return;
  }
  if (!res.ok || !res.body) {
    handlers.onDrop();
    return;
  }
  await readFrames(res.body, handlers);
  handlers.onDrop();
}

async function readFrames(body: ReadableStream<Uint8Array>, handlers: FrameHandlers): Promise<void> {
  const reader = body.getReader();
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
}

function dispatchFrame(frame: string, handlers: FrameHandlers): void {
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
      handlers.onActivity?.((JSON.parse(data) as { active: ActivityEntry[] }).active);
    } catch {
      /* ignore a malformed frame */
    }
  } else if (event === 'message') {
    handlers.onMessage?.();
  } else if (event === 'agents') {
    handlers.onAgents?.();
  } else if (event === 'projects') {
    handlers.onProjects?.();
  }
}
