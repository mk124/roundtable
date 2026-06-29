import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConversation } from '../../src/storage/event-parser.ts';
import { bodyChecksum, headerLine } from '../../src/storage/markdown-safety.ts';

const NONCE = 'a'.repeat(32);

/** A complete on-disk event block (heading + nonce'd markers + checksum). */
function diskEvent(meta: Record<string, unknown>, body: string): string {
  const end = JSON.stringify({ id: meta.id, checksum: bodyChecksum(body) });
  return `\n## H\n\n<!-- roundtable:event ${NONCE} ${JSON.stringify(meta)} -->\n${body}\n<!-- roundtable:end ${NONCE} ${end} -->\n`;
}

/** An event marker with a body but no end marker (interrupted write). */
function danglingEvent(meta: Record<string, unknown>, body: string): string {
  return `\n## H\n\n<!-- roundtable:event ${NONCE} ${JSON.stringify(meta)} -->\n${body}`;
}

function file(...blocks: string[]): string {
  return `${headerLine(NONCE)}\n${blocks.join('')}`;
}

test('parses message and system events in order', () => {
  const content = file(
    diskEvent({ id: 'e1', type: 'message', timestamp: 't1', author: 'user' }, 'hi'),
    diskEvent({ id: 'e2', type: 'system', timestamp: 't2', payload: { kind: 'quarantine-fence' } }, 'fenced'),
  );

  const { events, corrupt, nonce } = parseConversation(content);
  assert.equal(corrupt, false);
  assert.equal(nonce, NONCE);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => [e.id, e.type]), [['e1', 'message'], ['e2', 'system']]);
  assert.equal(events[0]!.timestamp, 't1');

  const msg = events[0]!;
  assert.ok(msg.type === 'message' && msg.author === 'user');
  const sys = events[1]!;
  assert.ok(sys.type === 'system' && sys.payload.kind === 'quarantine-fence');
});

test('a `##` heading inside a body stays body, not a boundary', () => {
  const body = 'Here is a plan:\n\n## Step one\n\nDo the thing.';
  const content = file(diskEvent({ id: 'm', type: 'message', timestamp: 't', author: 'Claude Opus 4.8' }, body));
  const { events } = parseConversation(content);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.body, body);
});

test('a service-shaped line in a body without the nonce is plain text', () => {
  const body = 'see this line:\n<!-- roundtable:event {"id":"fake"} -->\nnot an event';
  const content = file(diskEvent({ id: 'm', type: 'message', timestamp: 't', author: 'user' }, body));
  const { events } = parseConversation(content);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.body, body);
});

test('service-shaped markers in a code fence are ignored without the nonce', () => {
  const wrongNonce = 'b'.repeat(32);
  const body = `\`\`\`\n<!-- roundtable:end ${wrongNonce} {"id":"x"} -->\n\`\`\`\n~~~\nunclosed`;
  const content = file(diskEvent({ id: 'm', type: 'message', timestamp: 't', author: 'GPT-5.5' }, body));
  const { events, corrupt } = parseConversation(content);
  assert.equal(corrupt, false);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.body, body);
});

test('rebuilds order on restart without any offset index', () => {
  const content = file(
    diskEvent({ id: 'e1', type: 'message', timestamp: 't', author: 'user' }, 'a'),
    diskEvent({ id: 'e2', type: 'message', timestamp: 't', author: 'Claude Opus 4.8' }, 'b'),
    diskEvent({ id: 'e3', type: 'message', timestamp: 't', author: 'GPT-5.5' }, 'c'),
  );
  const { events } = parseConversation(content);
  assert.deepEqual(events.map((e) => e.id), ['e1', 'e2', 'e3']);
});

test('an incomplete final event is excluded and reported as a trailing fragment', () => {
  const content =
    file(diskEvent({ id: 'e1', type: 'message', timestamp: 't', author: 'user' }, 'done')) +
    danglingEvent({ id: 'e2', type: 'message', timestamp: 't', author: 'Claude Opus 4.8' }, 'half written');
  const { events, trailingFragment, corrupt } = parseConversation(content);
  assert.equal(corrupt, false);
  assert.deepEqual(events.map((e) => e.id), ['e1']);
  assert.ok(trailingFragment);
  assert.match(trailingFragment!.raw, /half written/);
});

test('a checksum mismatch excludes the event', () => {
  const good = diskEvent({ id: 'e1', type: 'message', timestamp: 't', author: 'user' }, 'real body');
  const tampered = good.replace('real body', 'tampered body'); // body changed, stored checksum stale
  const { events } = parseConversation(file(tampered));
  assert.equal(events.length, 0);
});

test('malformed event metadata is skipped', () => {
  const content = `${headerLine(NONCE)}\n\n## H\n\n<!-- roundtable:event ${NONCE} {not json} -->\nbody\n`;
  const { events } = parseConversation(content);
  assert.equal(events.length, 0);
});

test('a quarantine-fence after a fragment recovers without marking corrupt', () => {
  const fragment = danglingEvent({ id: 'bad', type: 'message', timestamp: 't', author: 'Claude Opus 4.8' }, 'half');
  const fence = diskEvent({ id: 'q1', type: 'system', timestamp: 't', payload: { kind: 'quarantine-fence' } }, 'fenced off');
  const content = `${headerLine(NONCE)}\n${fragment}${fence}`;
  const { events, corrupt, trailingFragment } = parseConversation(content);
  assert.equal(corrupt, false);
  assert.equal(trailingFragment, undefined);
  assert.deepEqual(events.map((e) => e.id), ['q1']);
});

test('a mid-file incomplete event with later complete content is corrupt', () => {
  const fragment = danglingEvent({ id: 'bad', type: 'message', timestamp: 't', author: 'Claude Opus 4.8' }, 'half');
  const later = diskEvent({ id: 'e2', type: 'message', timestamp: 't', author: 'user' }, 'normal');
  const content = `${headerLine(NONCE)}\n${fragment}${later}`;
  const { corrupt } = parseConversation(content);
  assert.equal(corrupt, true);
});

test('empty content yields no nonce, no events, not corrupt', () => {
  const { nonce, events, corrupt } = parseConversation('');
  assert.equal(nonce, null);
  assert.equal(events.length, 0);
  assert.equal(corrupt, false);
});

test('non-empty content without a header is corrupt', () => {
  const { corrupt, events } = parseConversation('just some text\nno header here');
  assert.equal(corrupt, true);
  assert.equal(events.length, 0);
});

test('a message with no author is rejected', () => {
  const { events } = parseConversation(file(diskEvent({ id: 'e1', type: 'message', timestamp: 't' }, 'body')));
  assert.equal(events.length, 0);
});
