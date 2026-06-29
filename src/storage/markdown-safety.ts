import { createHash, randomBytes } from 'node:crypto';

/**
 * Service event boundaries are made unforgeable by a per-conversation framing
 * nonce rather than by rewriting body text. The nonce is high-entropy and
 * never leaves the host: it appears only in the on-disk markers and the file
 * header, never in any prompt or transcript sent to an agent. So an agent's
 * reply body -- copied verbatim into the log -- cannot produce a line the parser
 * accepts as a boundary, and the body stays byte-for-byte readable.
 *
 * The nonce is declared on the file's first line, so a restart scan recovers it
 * from the file alone, without trusting any sidecar.
 */

/** A fresh 128-bit framing nonce, rendered as 32 lowercase hex characters. */
export function newFramingNonce(): string {
  return randomBytes(16).toString('hex');
}

/** The first line of every conversation file, declaring its framing nonce. */
export function headerLine(nonce: string): string {
  return `<!-- roundtable v1 ${nonce} -->`;
}

const HEADER_RE = /^<!-- roundtable v1 ([0-9a-f]{32}) -->/;

/** Read the framing nonce from a conversation file's first line, or null if the
 *  header is missing or malformed (which the caller treats as unparseable). */
export function readNonce(content: string): string | null {
  const m = HEADER_RE.exec(content);
  return m ? m[1]! : null;
}

/**
 * SHA-256 of the body, recorded in the end marker so a restart scan can reject
 * truncated or corrupted events without trusting any byte-offset index.
 */
export function bodyChecksum(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
