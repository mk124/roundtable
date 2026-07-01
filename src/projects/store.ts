import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ProjectMetadata } from '../types.ts';
import { isRecord, readJsonSidecar, writeJsonPrivate } from '../storage/sidecar.ts';
import { encodeProjectDir, isProjectId, normalizeProjectPath, projectId, projectTitle } from './naming.ts';

const PROJECT_JSON = 'project.json';

const readMetadata = (path: string) => readJsonSidecar(path, isProjectMetadata);

/**
 * Manages project registrations under `~/.roundtable/projects/`. Each project is
 * a `<encoded-path>/` directory holding a `project.json` sidecar; the authority
 * for its id, canonical absolute path, and title. Conversations live in the
 * project's own `conversations/` subtree, owned by a ConversationStore the service
 * builds from `projectDir(meta)`.
 */
export class ProjectStore {
  private readonly dir: string;

  constructor(home: string) {
    this.dir = join(home, 'projects');
  }

  /**
   * Register a project by absolute path. Idempotent: re-adding a path returns the
   * existing registration without overwriting it. Re-adding a path that was
   * deregistered re-creates `project.json` with a fresh id, making its retained
   * conversations visible again.
   */
  async add(rawPath: string): Promise<ProjectMetadata> {
    if (!isAbsolute(rawPath)) throw new Error('project path must be absolute');
    const path = normalizeProjectPath(rawPath);
    const info = await stat(path); // ENOENT for a missing path surfaces as-is
    if (!info.isDirectory()) throw new Error('project path must be a directory');

    const projectDir = join(this.dir, encodeProjectDir(path));
    await mkdir(projectDir, { recursive: true, mode: 0o700 });
    const existing = await readMetadata(join(projectDir, PROJECT_JSON));
    if (existing) return existing;

    const meta: ProjectMetadata = { id: projectId(), path, title: projectTitle(path), addedAt: new Date().toISOString() };
    await writeJsonPrivate(join(projectDir, PROJECT_JSON), meta);
    return meta;
  }

  /** Registered projects (those with a valid `project.json`), oldest first.
   *  Malformed sidecars and stray entries are skipped, mirroring readMetadata. */
  async list(): Promise<ProjectMetadata[]> {
    const names = await this.subdirNames();
    const metas = await Promise.all(names.map((name) => readMetadata(join(this.dir, name, PROJECT_JSON))));
    return metas
      .filter((meta): meta is ProjectMetadata => meta !== null)
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }

  async get(id: string): Promise<ProjectMetadata | null> {
    if (!isProjectId(id)) return null;
    return (await this.list()).find((meta) => meta.id === id) ?? null;
  }

  /** Deregister a project: delete only its `project.json`. The
   *  `conversations/` subtree is left intact, so re-adding the same path restores
   *  it. Unknown id is a no-op returning false; a missing sidecar is tolerated. */
  async remove(id: string): Promise<boolean> {
    const meta = await this.get(id);
    if (!meta) return false;
    await rm(join(this.projectDir(meta), PROJECT_JSON), { force: true });
    return true;
  }

  /** A project's storage root `~/.roundtable/projects/<encoded>`; the directory a
   *  ConversationStore is built over (it owns the `conversations/` subdirectory). */
  projectDir(meta: ProjectMetadata): string {
    return join(this.dir, encodeProjectDir(meta.path));
  }

  private async subdirNames(): Promise<string[]> {
    try {
      return await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}

function isProjectMetadata(value: unknown): value is ProjectMetadata {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isProjectId(value.id) &&
    typeof value.path === 'string' &&
    typeof value.title === 'string' &&
    typeof value.addedAt === 'string'
  );
}
