/**
 * The demo conversation shown in `docs/screenshot.png`, transcribed from the hero.
 * `capture.ts` replays this verbatim into an isolated roundtable instance, so this
 * file is the single source of truth for the hero's content — edit it here, not a
 * live conversation, then re-run `npm run screenshot`.
 *
 * The three agents appear both as the conversation's roster (registered `running`
 * records) and as the speakers of their answers, so every author renders as
 * `NAME · MODEL`, matching a real launched-agent conversation.
 */

import type { AgentKind } from '../src/agents/record.ts';

export const PROJECT_TITLE = 'roundtable';
export const CONVERSATION_TITLE = 'Intro';

export interface DemoAgent {
  kind: AgentKind;
  /** tmux-safe token ([A-Za-z0-9_-]); the roster chip's label. */
  name: string;
  /** Stable per-agent id; also tmux-safe. */
  instanceId: string;
  model: string;
}

export const AGENTS: DemoAgent[] = [
  { kind: 'claude', name: 'Claude-a0ba', instanceId: 'a0baaf00', model: 'Claude Opus 4.8' },
  { kind: 'codex', name: 'Codex-d96a', instanceId: 'd96a1713', model: 'GPT-5 Codex' },
  { kind: 'antigravity', name: 'Antigravity-0d52', instanceId: '0d527f84', model: 'Gemini 3.1 Pro' },
];

const [claude, codex, gemini] = AGENTS as [DemoAgent, DemoAgent, DemoAgent];

export interface DemoMessage {
  model: string;
  /** Absent for the human; present for an agent, yielding a `NAME · MODEL` author. */
  name?: string;
  text: string;
}

export const MESSAGES: DemoMessage[] = [
  { model: 'user', text: 'What is this project?' },
  {
    model: claude.model,
    name: claude.name,
    text:
      "This is Roundtable — the local chat room hosting this very conversation. It's a single-user app: a small Node/TypeScript HTTP server that binds to loopback (127.0.0.1) and does one job — store messages and serve them back. It deliberately launches and orchestrates nothing; each AI agent here is an independent HTTP client that reads the shared transcript by cursor, posts replies, and shows live presence like \"thinking\". History is append-only Markdown under ~/.roundtable/projects/<project>/conversations, live updates use SSE, and there's no auth — the loopback binding is the entire trust boundary, so it stays on your own machine.",
  },
  {
    model: codex.model,
    name: codex.name,
    text:
      'Roundtable is a local, single-user chat room where a human and multiple AI agents can share one conversation. It runs as a small TypeScript/Node HTTP app with a browser UI, cursor-based message reads for agents, live presence, and append-only Markdown logs. It is intentionally passive: it stores and serves messages, but each agent decides for itself when to speak.',
  },
  {
    model: gemini.model,
    name: gemini.name,
    text:
      'This project is **Roundtable**, a local chat room application designed to let you and your AI agents share a single conversation on your own machine. It runs a lightweight local Node/TypeScript HTTP server, stores messages in Markdown, and allows multiple agents to connect over HTTP, follow along, and participate when needed.',
  },
  { model: 'user', text: 'What do you all think of this project?' },
];

export interface DemoPresence {
  agent: DemoAgent;
  state: string;
}

export const PRESENCE: DemoPresence[] = [
  { agent: codex, state: 'reading the code' },
  { agent: gemini, state: 'investigating code' },
  { agent: claude, state: 'reading the repo' },
];
