import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationLog } from '../../src/storage/event-log.ts';
import type { SizeLimits } from '../../src/types.ts';

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rt-log-'));
  return join(dir, 'conversation.md');
}

const ROOMY: SizeLimits = {
  messageBytes: 1_000_000,
  singleEventBytes: 1_000_000,
  conversationTotalBytes: 1_000_000,
};

test('open creates a new file with a framing header', async () => {
  const path = await tempFile();
  const log = await ConversationLog.open(path);
  assert.equal(log.events.length, 0);
  assert.equal(log.readOnly, false);
  assert.match(await readFile(path, 'utf8'), /^<!-- roundtable v1 [0-9a-f]{32} -->/);
});

test('appends and reloads events across a restart, keeping the author', async () => {
  const path = await tempFile();
  const log = await ConversationLog.open(path);
  await log.append({ id: 'e1', type: 'message', timestamp: 't', author: 'user', body: 'question' });
  await log.append({ id: 'e2', type: 'message', timestamp: 't', author: 'Claude Opus 4.8', body: 'answer' });

  const reopened = await ConversationLog.open(path);
  assert.deepEqual(reopened.events.map((e) => e.id), ['e1', 'e2']);
  const second = reopened.events[1]!;
  assert.ok(second.type === 'message' && second.author === 'Claude Opus 4.8' && second.body === 'answer');
});

test('rejects an oversized message without writing it (AE17)', async () => {
  const path = await tempFile();
  const log = await ConversationLog.open(path, { ...ROOMY, messageBytes: 8 });
  const res = await log.append({ id: 'e1', type: 'message', timestamp: 't', author: 'user', body: 'way too long' });
  assert.equal(res.outcome, 'rejected');
  assert.equal(log.events.length, 0);
});

test('marks the conversation read-only when the total limit is exceeded', async () => {
  const path = await tempFile();
  const log = await ConversationLog.open(path, { ...ROOMY, conversationTotalBytes: 200 });
  const res = await log.append({ id: 'e1', type: 'message', timestamp: 't', author: 'user', body: 'x'.repeat(300) });
  assert.equal(res.outcome, 'conversation-readonly');
  assert.equal(log.readOnly, true);

  const again = await log.append({ id: 'e2', type: 'message', timestamp: 't', author: 'user', body: 'hi' });
  assert.equal(again.outcome, 'conversation-readonly');
});

test('rejects a single event larger than singleEventBytes without bricking the conversation', async () => {
  const path = await tempFile();
  // The body is under messageBytes, but its framed block exceeds singleEventBytes.
  const log = await ConversationLog.open(path, { ...ROOMY, singleEventBytes: 600 });
  const big = await log.append({ id: 'e1', type: 'message', timestamp: 't', author: 'user', body: 'x'.repeat(1000) });
  assert.equal(big.outcome, 'rejected');
  assert.equal(log.readOnly, false); // one oversized event must not flip the whole conversation

  const ok = await log.append({ id: 'e2', type: 'message', timestamp: 't', author: 'user', body: 'hi' });
  assert.equal(ok.outcome, 'ok'); // the conversation is still writable
});

test('quarantines a trailing fragment on open and stays writable', async () => {
  const path = await tempFile();
  const log = await ConversationLog.open(path);
  await log.append({ id: 'e1', type: 'message', timestamp: 't', author: 'user', body: 'done' });

  const content = await readFile(path, 'utf8');
  const nonce = content.match(/^<!-- roundtable v1 ([0-9a-f]{32}) -->/)![1];
  const dangling = `\n## Claude\n\n<!-- roundtable:event ${nonce} {"id":"bad","type":"message","timestamp":"t","author":"Claude"} -->\nhalf written`;
  await writeFile(path, content + dangling);

  const reopened = await ConversationLog.open(path);
  assert.equal(reopened.readOnly, false);
  const kinds = reopened.events.flatMap((e) => (e.type === 'system' ? [e.payload.kind] : []));
  assert.ok(kinds.includes('quarantine-fence'));
  assert.match(await readFile(path, 'utf8'), /half written/); // never trimmed

  const res = await reopened.append({ id: 'e3', type: 'message', timestamp: 't', author: 'user', body: 'next' });
  assert.equal(res.outcome, 'ok');
});

test('opens read-only when a trailing fragment cannot be quarantined', async () => {
  const path = await tempFile();
  const log = await ConversationLog.open(path);
  await log.append({ id: 'e1', type: 'message', timestamp: 't', author: 'user', body: 'done' });

  const content = await readFile(path, 'utf8');
  const nonce = content.match(/^<!-- roundtable v1 ([0-9a-f]{32}) -->/)![1];
  const dangling = `\n## Claude\n\n<!-- roundtable:event ${nonce} {"id":"bad","type":"message","timestamp":"t","author":"Claude"} -->\nhalf written`;
  await writeFile(path, content + dangling);

  const reopened = await ConversationLog.open(path, { ...ROOMY, singleEventBytes: 16 });
  assert.equal(reopened.readOnly, true);

  const res = await reopened.append({ id: 'e2', type: 'message', timestamp: 't', author: 'user', body: 'next' });
  assert.equal(res.outcome, 'conversation-readonly');
});

test('a headerless non-empty file opens read-only for manual recovery', async () => {
  const path = await tempFile();
  await writeFile(path, 'hand-written notes without a header\n');
  const log = await ConversationLog.open(path);
  assert.equal(log.readOnly, true);
  assert.equal(log.corrupt, true);
});

test('serializes concurrent appends, keeping memory and disk in call order', async () => {
  const path = await tempFile();
  const log = await ConversationLog.open(path);
  const ids = ['a', 'b', 'c', 'd', 'e'];
  await Promise.all(ids.map((id) => log.append({ id, type: 'message', timestamp: 't', author: 'u', body: id })));
  assert.deepEqual(log.events.map((e) => e.id), ids); // in-memory order matches call order

  const reopened = await ConversationLog.open(path);
  assert.deepEqual(reopened.events.map((e) => e.id), ids); // and disk agrees after a restart
});
