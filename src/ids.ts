import { randomBytes } from 'node:crypto';

const HEX_ID_RE = /^[0-9a-f]{16}$/;

export function hexId(): string {
  return randomBytes(8).toString('hex');
}

/** A short (8 hex chars), file-safe random id used to disambiguate names. */
export function shortId(): string {
  return randomBytes(4).toString('hex');
}

export function isHexId(id: string): boolean {
  return HEX_ID_RE.test(id);
}
