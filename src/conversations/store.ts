import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ConversationMetadata } from '../types.ts';
import { isRecord, readJsonSidecar, writeJsonPrivate } from '../storage/sidecar.ts';
import { conversationFilename, conversationId, isConversationId } from './naming.ts';

const META_SUFFIX = '.meta.json';

/** Only these fields are mutable; the id and filename are fixed at creation. */
export type ConversationUpdate = Partial<
  Pick<ConversationMetadata, 'title' | 'lastActivityAt' | 'readOnly'>
>;

const readMetadata = (path: string) => readJsonSidecar(path, isConversationMetadata);

/**
 * Manages conversation sidecar metadata under `~/.roundtable/conversations/`.
 * The conversationId, title, filename, and timestamps live here; never in the
 * human-readable Markdown event log. The Markdown file itself is owned by
 * ConversationLog.
 */
export class ConversationStore {
  private readonly dir: string;

  constructor(root: string) {
    this.dir = join(root, 'conversations');
  }

  async list(): Promise<ConversationMetadata[]> {
    const names = await this.metaNames();
    const metas = await Promise.all(names.map((name) => readMetadata(join(this.dir, name))));
    return metas
      .filter((meta): meta is ConversationMetadata => meta !== null)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  async create(title: string): Promise<ConversationMetadata> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });

    const now = new Date().toISOString();
    const meta: ConversationMetadata = {
      id: conversationId(),
      title: title.trim() || 'Untitled',
      filename: conversationFilename(title),
      createdAt: now,
      lastActivityAt: now,
    };
    await this.writeMeta(meta);
    return meta;
  }

  async get(id: string): Promise<ConversationMetadata | null> {
    return isConversationId(id) ? readMetadata(this.metaPath(id)) : null;
  }

  /** Apply a whitelisted update. The id, filename, and createdAt are never
   *  touched, so a title rename cannot rebind the conversation. */
  async update(id: string, patch: ConversationUpdate): Promise<ConversationMetadata | null> {
    const meta = await this.get(id);
    if (!meta) return null;
    const next: ConversationMetadata = { ...meta };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.lastActivityAt !== undefined) next.lastActivityAt = patch.lastActivityAt;
    if (patch.readOnly !== undefined) next.readOnly = patch.readOnly;
    await this.writeMeta(next);
    return next;
  }

  /** Remove a conversation's Markdown log and its sidecar. Returns false when no
   *  such conversation exists; missing files are tolerated so a partial earlier
   *  deletion still completes. */
  async delete(id: string): Promise<boolean> {
    const meta = await this.get(id);
    if (!meta) return false;
    await rm(this.conversationFilePath(meta), { force: true });
    await rm(this.metaPath(id), { force: true });
    return true;
  }

  /** Absolute path of the conversation's human-readable Markdown event log. */
  conversationFilePath(meta: ConversationMetadata): string {
    return join(this.dir, meta.filename);
  }

  private metaPath(id: string): string {
    return join(this.dir, `${id}${META_SUFFIX}`);
  }

  private async writeMeta(meta: ConversationMetadata): Promise<void> {
    await writeJsonPrivate(this.metaPath(meta.id), meta);
  }

  private async metaNames(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((name) => name.endsWith(META_SUFFIX));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}

function isConversationMetadata(value: unknown): value is ConversationMetadata {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    isConversationId(value.id) &&
    typeof value.title === 'string' &&
    isSafeMarkdownFilename(value.filename) &&
    typeof value.createdAt === 'string' &&
    typeof value.lastActivityAt === 'string' &&
    (value.readOnly === undefined || typeof value.readOnly === 'boolean')
  );
}

function isSafeMarkdownFilename(value: unknown): value is string {
  return typeof value === 'string' && value.endsWith('.md') && value === basename(value) && !value.includes('\\');
}
