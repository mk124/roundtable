import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentKind } from './record.ts';
import { isRecord, writeJsonPrivate } from '../storage/sidecar.ts';

type JsonObject = Record<string, unknown>;

export type TrustPreparer = (kind: AgentKind, cwd: string) => Promise<void>;

const CLAUDE_STATE = join(homedir(), '.claude.json');
const ANTIGRAVITY_SETTINGS = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');

export const prepareTrustedWorkspace: TrustPreparer = async (kind, cwd) => {
  if (kind === 'claude') await trustClaudeWorkspace(CLAUDE_STATE, cwd);
  else if (kind === 'antigravity') await trustAntigravityWorkspace(ANTIGRAVITY_SETTINGS, cwd);
};

const writes = new Map<string, Promise<void>>();

async function trustClaudeWorkspace(path: string, cwd: string): Promise<void> {
  const keys = await workspaceKeys(cwd);
  await updateJson(path, (state) => {
    const projects = objectValue(state.projects);
    state.projects = projects;

    for (const key of keys) {
      const project = objectValue(projects[key]);
      if (!Array.isArray(project.allowedTools)) project.allowedTools = [];
      project.hasTrustDialogAccepted = true;
      projects[key] = project;
    }
  });
}

async function trustAntigravityWorkspace(path: string, cwd: string): Promise<void> {
  const keys = await workspaceKeys(cwd);
  await updateJson(path, (settings) => {
    const trusted = Array.isArray(settings.trustedWorkspaces) ? settings.trustedWorkspaces.filter((value): value is string => typeof value === 'string') : [];
    settings.trustedWorkspaces = [...new Set([...trusted, ...keys])];
  });
}

async function workspaceKeys(cwd: string): Promise<string[]> {
  try {
    const resolved = await realpath(cwd);
    return [...new Set([cwd, resolved])];
  } catch {
    // A later spawn will fail if cwd is invalid; keep the requested key for diagnostics.
    return [cwd];
  }
}

async function readJsonObject(path: string): Promise<JsonObject> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (isMissing(err)) return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  return objectValue(parsed);
}

async function updateJson(path: string, mutate: (value: JsonObject) => void): Promise<void> {
  const run = (writes.get(path) ?? Promise.resolve()).then(async () => {
    const value = await readJsonObject(path);
    const before = JSON.stringify(value);
    mutate(value);
    if (JSON.stringify(value) === before) return; // already in the desired state; skip the rewrite
    await writeJsonPrivate(path, value);
  });
  const tail = run.catch(() => undefined);
  writes.set(path, tail);
  try {
    await run;
  } finally {
    if (writes.get(path) === tail) writes.delete(path);
  }
}

function objectValue(value: unknown): JsonObject {
  return isRecord(value) && !Array.isArray(value) ? value : {};
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}
