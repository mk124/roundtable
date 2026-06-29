import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseHub } from '../../src/server/sse.ts';

function client() {
  const chunks: string[] = [];
  return { write: (c: string) => chunks.push(c), chunks };
}

test('publishes events to subscribed clients tagged with the caller cursor', () => {
  const hub = new SseHub();
  const a = client();
  hub.subscribe(a);
  hub.publish(1, { value: 1 });
  assert.match(a.chunks[0]!, /event: message/);
  assert.match(a.chunks[0]!, /data: {"value":1}/);
  assert.match(a.chunks[0]!, /^id: 1/);
});

test('reconnect replays only events after the last cursor', () => {
  const hub = new SseHub();
  hub.publish(1, { n: 1 });
  hub.publish(2, { n: 2 });
  hub.publish(3, { n: 3 });
  const late = client();
  hub.subscribe(late, 1); // reconnect after id 1
  assert.equal(late.chunks.length, 2); // events 2 and 3 replayed
  assert.match(late.chunks[0]!, /"n":2/);
});

test('unsubscribe stops further delivery', () => {
  const hub = new SseHub();
  const a = client();
  const off = hub.subscribe(a);
  hub.publish(1, { n: 1 });
  off();
  hub.publish(2, { n: 2 });
  assert.equal(a.chunks.length, 1);
  assert.equal(hub.clientCount, 0);
});

test('close ends every stream and drops all clients', () => {
  const hub = new SseHub();
  let closed = 0;
  hub.subscribe({ write() {}, close() { closed++; } });
  hub.subscribe({ write() {}, close() { closed++; } });
  hub.close();
  assert.equal(closed, 2);
  assert.equal(hub.clientCount, 0);
});

test('subscribing after close immediately closes the late client and registers nothing', () => {
  const hub = new SseHub();
  hub.close();
  let closed = 0;
  const off = hub.subscribe({ write() {}, close() { closed++; } }); // a subscribe that lost the teardown race
  assert.equal(closed, 1); // closed at once, not parked on a dead hub
  assert.equal(hub.clientCount, 0);
  off(); // unsubscribe is a safe no-op
});

test('setActivity broadcasts an unbuffered snapshot frame with no id', () => {
  const hub = new SseHub();
  const a = client();
  hub.subscribe(a);
  hub.setActivity('Claude Opus 4.8', 'thinking');
  const frame = a.chunks.at(-1)!;
  assert.match(frame, /event: activity/);
  assert.doesNotMatch(frame, /^id:/m); // ephemeral: never part of cursor replay
  assert.match(frame, /"author":"Claude Opus 4.8"/);
  assert.match(frame, /"state":"thinking"/);
});

test('a blank state clears the author; re-setting the same state emits nothing', () => {
  const hub = new SseHub();
  const a = client();
  hub.subscribe(a);
  hub.setActivity('GPT-5.5', 'typing');
  hub.setActivity('GPT-5.5', 'typing'); // idempotent heartbeat: no new frame
  hub.setActivity('GPT-5.5', null); //     clear
  const frames = a.chunks.filter((c) => c.includes('event: activity'));
  assert.equal(frames.length, 2);
  assert.match(frames[1]!, /"active":\[\]/);
});

test('a new subscriber receives the current activity snapshot once', () => {
  const hub = new SseHub();
  hub.setActivity('Claude Opus 4.8', 'investigating code');
  const late = client();
  hub.subscribe(late);
  assert.equal(late.chunks.length, 1);
  assert.match(late.chunks[0]!, /event: activity/);
  assert.match(late.chunks[0]!, /"state":"investigating code"/);
});
