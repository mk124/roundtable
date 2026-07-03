/**
 * Regenerate `docs/screenshot.png`, the README hero.
 *
 * Boots an isolated roundtable instance against a throwaway storage home (never the
 * user's real `~/.roundtable`), replays the committed demo from `transcript.ts`,
 * stages the three agents mid-`typing`, then drives the installed Google Chrome in
 * headless mode over the DevTools Protocol to capture the app at the hero's exact
 * size. Everything — server, browser, temp files — is torn down on exit.
 *
 * Run with `npm run screenshot`. Requires Google Chrome installed (override its path
 * with the `CHROME` env var).
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRecord } from '../src/agents/record.ts';
import { ConversationStore } from '../src/conversations/store.ts';
import { encodeProjectDir, normalizeProjectPath } from '../src/projects/naming.ts';
import { startServer } from '../src/server/startup.ts';
import { DISPLAY_AUTHOR_SEPARATOR } from '../src/types.ts';
import { AGENTS, CONVERSATION_TITLE, MESSAGES, PRESENCE, PROJECT_TITLE } from './transcript.ts';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** CSS viewport; the hero is this at 2x device scale (2240x1920). */
const VIEWPORT = { width: 1120, height: 960, scale: 2 };
const OUT = fileURLToPath(new URL('../docs/screenshot.png', import.meta.url));

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An ephemeral loopback port the OS hands us; closed before we return it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function main(): Promise<void> {
  try {
    await access(CHROME, constants.X_OK);
  } catch {
    throw new Error(`Google Chrome not found at ${CHROME}. Install it, or set CHROME to its path.`);
  }

  const scratch = await mkdtemp(join(tmpdir(), 'roundtable-shot-'));
  const home = join(scratch, 'home');
  // The project's on-disk title is its path basename, so register a dir literally
  // named `roundtable` to force the demo project's label.
  const projectPath = join(scratch, PROJECT_TITLE);
  let base = '';
  try {
    await mkdir(projectPath, { recursive: true });

    // Shadow tmux with a stub that reports "not installed" to the version probe but
    // succeeds for everything else. Unavailable tmux means the demo's injected
    // `running` agents render as-is (never reconciled against absent live sessions);
    // succeeding on the rest keeps teardown's stop-all quiet. Chrome launches by
    // absolute path, so the shadowed tmux never reaches it.
    const binDir = join(scratch, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 'tmux'), '#!/bin/sh\n[ "$1" = "-V" ] && exit 127\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`;

    const server = await startServer({ home, port: await freePort() });
    if (!server) throw new Error('could not start an isolated roundtable instance');
    base = server.url;
    try {
      const conv = await seed(projectPath);
      const shot = await capture();
      await writeFile(OUT, shot);
      console.log(`screenshot: wrote ${OUT} (conversation ${conv})`);
    } finally {
      await server.close().catch(() => {});
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  /** POST JSON to the isolated server; throws on a non-2xx so failures are loud. */
  async function post(path: string, body: unknown): Promise<any> {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** Build the demo project, conversation, messages, and staged presence. Returns
   *  the conversation id. Presence is set last and no message follows, so it never
   *  clears — the SSE snapshot replays it to the browser on connect. */
  async function seed(path: string): Promise<string> {
    const { project } = await post('/api/projects', { path });
    const { conversation } = await post(`/api/projects/${project.id}/conversations`, { title: CONVERSATION_TITLE });
    const conv = conversation.id;
    for (const m of MESSAGES) await post(`/api/conversations/${conv}/say`, { model: m.model, name: m.name, text: m.text });
    await registerAgents(path, conv);
    for (const p of PRESENCE) {
      const author = `${p.agent.name}${DISPLAY_AUTHOR_SEPARATOR}${p.agent.model}`;
      await post(`/api/conversations/${conv}/activity`, { author, state: p.state });
    }
    return conv;
  }

  /** Persist the demo's three agents as `running` records in the conversation meta,
   *  so the roster renders them; the server reads agent meta fresh per request, and
   *  tmux is shadowed, so no live session is required to keep them running. */
  async function registerAgents(path: string, conv: string): Promise<void> {
    const store = new ConversationStore(join(home, 'projects', encodeProjectDir(normalizeProjectPath(path))));
    const createdAt = new Date().toISOString();
    const records: AgentRecord[] = AGENTS.map((a) => ({
      kind: a.kind,
      instanceId: a.instanceId,
      name: a.name,
      model: a.model,
      createdAt,
      status: 'running',
    }));
    await store.writeAgents(conv, records);
  }

  async function capture(): Promise<Buffer> {
    const cdpPort = await freePort();
    const chrome = spawn(
      CHROME,
      [
        '--headless=new',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${join(scratch, 'chrome')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    try {
      const ws = await connectCdp(cdpPort);
      try {
        const cdp = cdpClient(ws);
        await cdp('Page.enable');
        await cdp('Runtime.enable');
        await cdp('Emulation.setDeviceMetricsOverride', {
          width: VIEWPORT.width,
          height: VIEWPORT.height,
          deviceScaleFactor: VIEWPORT.scale,
          mobile: false,
        });
        await cdp('Page.navigate', { url: base + '/' });

        // Fully rendered once the last message and all presence labels have painted
        // and the roster shows every agent chip.
        const needles = JSON.stringify([...PRESENCE.map((p) => p.state), 'What do you all think']);
        const probe = `(() => {
          const t = document.body.textContent || '';
          const roster = document.querySelectorAll('.agentbar__roster .agent').length;
          return ${needles}.every((s) => t.includes(s)) && roster >= ${AGENTS.length};
        })()`;
        await until(async () => {
          const { result } = await cdp('Runtime.evaluate', { expression: probe, returnByValue: true });
          return result.value === true;
        }, 15000);
        await delay(400); // let the typing-dot animation and final layout settle

        const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        return Buffer.from(data, 'base64');
      } finally {
        ws.close();
      }
    } finally {
      await endProcess(chrome);
    }
  }
}

/** Poll the CDP HTTP endpoint until the headless page target exposes a WS URL. */
async function connectCdp(port: number): Promise<WebSocket> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      if (res.ok) {
        const targets = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise<void>((resolve, reject) => {
            ws.addEventListener('open', () => resolve(), { once: true });
            ws.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true });
          });
          return ws;
        }
      }
    } catch {
      // Chrome not listening yet.
    }
    await delay(100);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

/** A promise-returning CDP command sender over an open socket. */
function cdpClient(ws: WebSocket): (method: string, params?: unknown) => Promise<any> {
  let nextId = 1;
  const pending = new Map<number, { method: string; resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    const waiter = msg.id != null ? pending.get(msg.id) : undefined;
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(`${msg.error.message} (${waiter.method})`));
    else waiter.resolve(msg.result);
  });
  return (m, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { method: m, resolve, reject });
      ws.send(JSON.stringify({ id, method: m, params }));
    });
  };
}

/** Terminate a child and wait for it to actually exit, escalating to SIGKILL. */
function endProcess(p: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (p.exitCode !== null || p.signalCode !== null) return resolve();
    const kill = setTimeout(() => p.kill('SIGKILL'), 1500);
    p.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    p.kill();
  });
}

async function until(cond: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await delay(150);
  }
  throw new Error('timed out waiting for the demo to render');
}

await main();
