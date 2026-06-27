import type { EventMetadata, RoundtableEvent } from '../types.ts';
import { bodyChecksum, readNonce } from './markdown-safety.ts';

export interface ParseResult {
  /** Framing nonce read from the header; null for an empty (new) file. */
  nonce: string | null;
  /** Complete events in append order; the original file is never trimmed. */
  events: RoundtableEvent[];
  /** A trailing incomplete fragment to be quarantined, when present. */
  trailingFragment?: { startLine: number; raw: string };
  /** True when content before any trailing fragment is also unparseable, so the
   *  whole conversation needs manual / read-only recovery rather than a fence. */
  corrupt: boolean;
}

/**
 * Rebuild a conversation purely by scanning its Markdown (R20). Correctness rests
 * only on the framing nonce, strict line-start markers, and the body checksum —
 * never on Markdown fence state — so unclosed fences, tilde/indented fences, and
 * malformed bodies cannot move an event boundary (R19).
 */
export function parseConversation(content: string): ParseResult {
  if (content.length === 0) return { nonce: null, events: [], corrupt: false };

  const nonce = readNonce(content);
  if (nonce === null) return { nonce: null, events: [], corrupt: true };

  const eventRe = new RegExp(`^<!-- roundtable:event ${nonce} (.+) -->$`);
  const endRe = new RegExp(`^<!-- roundtable:end ${nonce} (.+) -->$`);
  const lines = content.split('\n');

  const events: RoundtableEvent[] = [];
  let pendingIncomplete: number | null = null;
  let corrupt = false;
  let i = 0;

  while (i < lines.length) {
    if (!eventRe.test(lines[i] ?? '')) {
      i++;
      continue;
    }
    const res = parseEventAt(lines, i, eventRe, endRe);
    if (res.ok) {
      if (pendingIncomplete !== null) {
        // A complete event after an incomplete one: only a quarantine-fence
        // legitimately follows a fenced-off fragment; anything else means the
        // earlier content is itself unparseable.
        const fenced =
          res.event.type === 'system' && res.event.payload.kind === 'quarantine-fence';
        if (!fenced) corrupt = true;
        pendingIncomplete = null;
      }
      events.push(res.event);
      i = res.endIdx + 1;
    } else {
      if (pendingIncomplete === null) pendingIncomplete = i;
      i = res.nextScanIdx > i ? res.nextScanIdx : i + 1;
    }
  }

  const trailingFragment =
    pendingIncomplete !== null
      ? { startLine: pendingIncomplete, raw: lines.slice(pendingIncomplete).join('\n') }
      : undefined;

  return { nonce, events, trailingFragment: corrupt ? undefined : trailingFragment, corrupt };
}

type EventAt =
  | { ok: true; event: RoundtableEvent; endIdx: number }
  | { ok: false; nextScanIdx: number };

function parseEventAt(lines: string[], start: number, eventRe: RegExp, endRe: RegExp): EventAt {
  const header = eventRe.exec(lines[start] ?? '');
  if (!header) return { ok: false, nextScanIdx: start + 1 };

  let meta: unknown;
  try {
    meta = JSON.parse(header[1]!);
  } catch {
    return { ok: false, nextScanIdx: start + 1 };
  }
  const id = isRecord(meta) ? meta.id : undefined;

  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j] ?? '';
    if (eventRe.test(line)) return { ok: false, nextScanIdx: j }; // next event before our end
    const end = endRe.exec(line);
    if (!end) continue;

    let endMeta: unknown;
    try {
      endMeta = JSON.parse(end[1]!);
    } catch {
      continue;
    }
    if (!isRecord(endMeta) || endMeta.id !== id) continue;

    const body = lines.slice(start + 1, j).join('\n');
    if (endMeta.checksum !== bodyChecksum(body)) return { ok: false, nextScanIdx: j + 1 };

    const event = buildEvent(meta, body);
    if (!event) return { ok: false, nextScanIdx: j + 1 };
    return { ok: true, event, endIdx: j };
  }
  return { ok: false, nextScanIdx: lines.length };
}

function buildEvent(meta: unknown, body: string): RoundtableEvent | null {
  if (!isRecord(meta)) return null;
  const { id, type, timestamp } = meta;
  if (typeof id !== 'string' || typeof timestamp !== 'string') return null;
  if (type !== 'message' && type !== 'system') return null;

  const base: EventMetadata = { id, type, timestamp };

  if (type === 'message') {
    if (typeof meta.author !== 'string') return null;
    return { ...base, type: 'message', author: meta.author, body };
  }
  const { payload } = meta;
  if (!isRecord(payload) || payload.kind !== 'quarantine-fence') return null;
  return { ...base, type: 'system', payload: { kind: 'quarantine-fence' }, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
