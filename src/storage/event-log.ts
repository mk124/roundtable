import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { RoundtableEvent, SizeLimitOutcome, SizeLimits } from '../types.ts';
import { DEFAULT_SIZE_LIMITS, utf8Bytes } from '../config/limits.ts';
import { bodyChecksum, headerLine, newFramingNonce } from './markdown-safety.ts';
import { parseConversation } from './event-parser.ts';

/** A fresh event id: 72 random bits, URL-safe and unique within a conversation. */
export function newEventId(): string {
  return randomBytes(9).toString('base64url');
}

function headingFor(event: RoundtableEvent): string {
  return event.type === 'system' ? 'System' : event.author;
}

/**
 * Render one event as a Markdown block: a human-readable heading, the framing
 * markers carrying the conversation nonce, the verbatim body, and an end marker
 * with the body checksum. The leading `\n` guarantees the marker lands at a
 * strict line start even if a crash left the previous write without a trailing
 * newline (R18, R20).
 */
function serializeEvent(event: RoundtableEvent, nonce: string): string {
  const { body, ...meta } = event;
  const endMeta = JSON.stringify({ id: event.id, checksum: bodyChecksum(body) });
  return (
    `\n## ${headingFor(event)}\n\n` +
    `<!-- roundtable:event ${nonce} ${JSON.stringify(meta)} -->\n` +
    `${body}\n` +
    `<!-- roundtable:end ${nonce} ${endMeta} -->\n`
  );
}

export interface AppendResult {
  outcome: SizeLimitOutcome;
}

/**
 * Append-only event log for a single conversation file. One writer at a time;
 * this class owns framing, checksums, size limits (R48), and restart quarantine
 * of an interrupted trailing write.
 */
export class ConversationLog {
  readonly corrupt: boolean;
  private readonly path: string;
  private readonly nonce: string;
  private readonly limits: SizeLimits;
  private readonly events_: RoundtableEvent[];
  private totalBytes_: number;
  private readOnly_: boolean;
  private writeChain: Promise<unknown> = Promise.resolve();

  private constructor(
    path: string,
    nonce: string,
    limits: SizeLimits,
    events: RoundtableEvent[],
    totalBytes: number,
    readOnly: boolean,
    corrupt: boolean,
  ) {
    this.path = path;
    this.nonce = nonce;
    this.limits = limits;
    this.events_ = events;
    this.totalBytes_ = totalBytes;
    this.readOnly_ = readOnly;
    this.corrupt = corrupt;
  }

  static async open(path: string, limits: SizeLimits = DEFAULT_SIZE_LIMITS): Promise<ConversationLog> {
    let content = '';
    try {
      content = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const parsed = parseConversation(content);

    // Non-empty but unparseable (no header / damaged before the tail): stay
    // read-only for manual recovery rather than fencing.
    if (parsed.corrupt) {
      return new ConversationLog(path, '', limits, [], utf8Bytes(content), true, true);
    }

    if (parsed.nonce === null) {
      // Fresh file: write the framing header and start empty.
      const nonce = newFramingNonce();
      const header = `${headerLine(nonce)}\n`;
      await writeFile(path, header, { mode: 0o600 });
      return new ConversationLog(path, nonce, limits, [], utf8Bytes(header), false, false);
    }

    const log = new ConversationLog(path, parsed.nonce, limits, parsed.events.slice(), utf8Bytes(content), false, false);
    if (parsed.trailingFragment) await log.quarantine();
    return log;
  }

  get events(): readonly RoundtableEvent[] {
    return this.events_;
  }
  get readOnly(): boolean {
    return this.readOnly_;
  }

  /** Append an event, enforcing R48 size limits. Appends are serialized so each
   *  event's size check, file write, and in-memory push complete before the next
   *  begins — concurrent posts to one conversation are a core path. An oversized
   *  single event is rejected (the caller surfaces a 400); exhausting the
   *  conversation total turns the conversation read-only. */
  async append(event: RoundtableEvent): Promise<AppendResult> {
    const run = this.writeChain.then(() => this.appendOne(event));
    this.writeChain = run.catch(() => {});
    return run;
  }

  private async appendOne(event: RoundtableEvent): Promise<AppendResult> {
    if (this.readOnly_) return { outcome: 'conversation-readonly' };
    if (event.type === 'message' && utf8Bytes(event.body) > this.limits.messageBytes) {
      return { outcome: 'rejected' };
    }
    const block = serializeEvent(event, this.nonce);
    const blockBytes = utf8Bytes(block);
    if (blockBytes > this.limits.singleEventBytes) return { outcome: 'rejected' };
    if (this.totalBytes_ + blockBytes > this.limits.conversationTotalBytes) {
      this.readOnly_ = true;
      return { outcome: 'conversation-readonly' };
    }
    await appendFile(this.path, block, { mode: 0o600 });
    this.totalBytes_ += blockBytes;
    this.events_.push(event);
    return { outcome: 'ok' };
  }

  /** Fence off an interrupted trailing fragment so the conversation is writable
   *  again, never trimming the original bytes (R20). */
  private async quarantine(): Promise<void> {
    const result = await this.appendOne({
      id: newEventId(),
      type: 'system',
      timestamp: new Date().toISOString(),
      payload: { kind: 'quarantine-fence' },
      body: 'A previous reply was interrupted mid-write and has been fenced off. The conversation continues below.',
    });
    if (result.outcome !== 'ok') this.readOnly_ = true;
  }
}
