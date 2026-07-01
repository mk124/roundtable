import { hexId, isHexId, shortId } from '../ids.ts';

/** Lowercase the text and collapse anything outside `[a-z0-9]` into single
 *  dashes, trimming leading/trailing dashes and capping length. */
export function slugify(text: string, maxLength = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/** A high-entropy conversation id. Stored only in sidecar metadata, never in
 *  the human-readable Markdown. */
export function conversationId(): string {
  return hexId();
}

export function isConversationId(id: string): boolean {
  return isHexId(id);
}

/**
 * Build a readable conversation filename: English slug + short id. Falls back to
 * `conversation-<date>-<short-id>` when the title yields no slug. The
 * sidecar metadata, not this name, is the authority for identifying a
 * conversation, so a later title rename never breaks lookup.
 */
export function conversationFilename(
  title: string,
  id: string = shortId(),
  date: Date = new Date(),
): string {
  const slug = slugify(title, 60);
  if (slug) return `${slug}-${id}.md`;
  return `conversation-${date.toISOString().slice(0, 10)}-${id}.md`;
}
