import { basename, normalize } from 'node:path';
import { hexId, isHexId } from '../ids.ts';

/** A high-entropy, URL-safe project handle. Stored in `project.json` and used as
 *  the `:id` path segment in `/api/projects/:id`, so it must never contain `#` or
 *  `/`. Mirrors `conversationId()`; the encoded directory name (which does contain
 *  `#`) is never used as the public id. */
export function projectId(): string {
  return hexId();
}

export function isProjectId(id: string): boolean {
  return isHexId(id);
}

/** Lexically normalize an absolute path: resolve `.`/`..`, collapse `//`, and
 *  drop a trailing slash (except for the root itself). No disk access; the
 *  canonical path the store records as the project's authority. */
export function normalizeProjectPath(path: string): string {
  const normalized = normalize(path);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/** Percent-escape the two characters that would otherwise make the `#`-joined
 *  single-segment directory name ambiguous: `%` (the escape introducer) first,
 *  then `#` (the segment delimiter). */
function escapeSegment(segment: string): string {
  return segment.replace(/%/g, '%25').replace(/#/g, '%23');
}

/**
 * Encode an absolute path into a single, filesystem-safe directory name:
 * `/Volumes/External/Project` -> `#Volumes#External#Project`. The encoding is
 * injective; distinct paths never collide on the same directory because any
 * literal `#`/`%` inside a path segment is percent-escaped before the `#` join.
 * It is never reversed in code; the canonical path lives in `project.json`.
 */
export function encodeProjectDir(absPath: string): string {
  const segments = normalizeProjectPath(absPath).split('/').filter(Boolean);
  return `#${segments.map(escapeSegment).join('#')}`;
}

/** Human-readable project label: the path's basename, falling back to the
 *  normalized path when the basename is empty (e.g. the filesystem root). */
export function projectTitle(absPath: string): string {
  const normalized = normalizeProjectPath(absPath);
  return basename(normalized) || normalized;
}
