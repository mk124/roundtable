import { hexId, isHexId, shortId } from '../ids.ts';

/** Lowercase the text and collapse anything outside Unicode letters/digits into
 *  single dashes, trimming leading/trailing dashes and capping length. NFC is
 *  applied first so decomposed accents compose into letters (rather than being
 *  stripped as marks) and so equivalent inputs yield the same name; the cap
 *  counts code points so an astral character is never split into a lone
 *  surrogate. */
export function slugify(text: string, maxLength = 40): string {
  const collapsed = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return [...collapsed].slice(0, maxLength).join('').replace(/-+$/g, '');
}

/** The 8-hex disambiguating suffix of a conversation filename, or null when it
 *  has none. A rename reuses this so the renamed file keeps its unique suffix
 *  and never collides with another conversation's. */
export function filenameSuffix(filename: string): string | null {
  return /-([0-9a-f]{8})\.md$/.exec(filename)?.[1] ?? null;
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
