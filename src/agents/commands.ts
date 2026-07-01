/** Per-kind launch commands as argv arrays. */
import type { AgentKind } from './record.ts';
import { DISPLAY_AUTHOR_SEPARATOR } from '../types.ts';

export type CommandMode = 'new' | 'resume';

export interface CommandSpec {
  kind: AgentKind;
  mode: CommandMode;
  convId: string;
  /** Working directory for the agent; also passed to CLIs that need an explicit project root. */
  cwd: string;
  /** Absolute path of the roundtable repo, used to locate the skill file. */
  roundtablePath: string;
  /** Runtime base URL, passed through ROUNDTABLE_BASE for non-default ports. */
  baseUrl: string;
  /** Optional `/say` name parameter, used to distinguish multiple agents. */
  name?: string;
  /** Required for every resume, and for a Claude `new` (its id is pre-generated). */
  sessionId?: string;
}

export function buildCommand(spec: CommandSpec): string[] {
  const identity = spec.name
    ? `Call /say with name ${JSON.stringify(spec.name)} and with model set to your current full model display name.`
    : 'Call /say with model set to your current full model display name.';
  const author = spec.name
    ? `For activity and self-filtering, compute your display author as ${JSON.stringify(spec.name)} + ${JSON.stringify(DISPLAY_AUTHOR_SEPARATOR)} + the same value you send as /say.model.`
    : 'For activity and self-filtering, use the same value you send as /say.model as your display author.';
  const prompt =
    `Keep watching ${spec.roundtablePath}/skills/roundtable/SKILL.md ${spec.convId}.` +
    ` Use ROUNDTABLE_BASE=${JSON.stringify(spec.baseUrl)} when contacting the server.` +
    ` ${identity} Do not use only a provider or family label when a more specific model label is available.` +
    ` ${author}`;
  switch (spec.kind) {
    case 'claude':
      return ['claude', '--permission-mode', 'bypassPermissions', spec.mode === 'resume' ? '--resume' : '--session-id', sessionId(spec), prompt];
    case 'codex': {
      const codex = ['--cd', spec.cwd, '-c', codexTrustOverride(spec.cwd), '--dangerously-bypass-approvals-and-sandbox'];
      return spec.mode === 'resume'
        ? ['codex', 'resume', ...codex, sessionId(spec), `/goal ${prompt}`]
        : ['codex', ...codex, `/goal ${prompt}`];
    }
    case 'antigravity':
      return spec.mode === 'resume'
        ? ['agy', '--dangerously-skip-permissions', `--conversation=${sessionId(spec)}`, '--prompt-interactive', `/goal ${prompt}`]
        : ['agy', '--dangerously-skip-permissions', '--prompt-interactive', `/goal ${prompt}`];
  }
}

function sessionId(spec: CommandSpec): string {
  if (!spec.sessionId) throw new Error(`${spec.kind} ${spec.mode} requires a sessionId`);
  return spec.sessionId;
}

function codexTrustOverride(cwd: string): string {
  return `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`;
}
