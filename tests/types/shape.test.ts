import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ConversationMetadata,
  MessageEvent,
  RoundtableEvent,
  SystemEvent,
} from '../../src/types.ts';

// These fixtures prove the shared types are importable and usable from the
// shapes every layer constructs (storage, server, web), and that the event
// union discriminates on `type`.

test('the event union discriminates on `type`', () => {
  const message: MessageEvent = {
    id: 'e1',
    type: 'message',
    timestamp: '2026-06-26T00:00:00Z',
    author: 'Claude Opus 4.8',
    body: 'hello',
  };
  const system: SystemEvent = {
    id: 'e2',
    type: 'system',
    timestamp: '2026-06-26T00:00:01Z',
    payload: { kind: 'quarantine-fence' },
    body: 'A previous reply was interrupted mid-write and has been fenced off.',
  };

  const events: RoundtableEvent[] = [message, system];
  assert.deepEqual(events.map((e) => e.type), ['message', 'system']);
});

test('storage records are constructible', () => {
  const conversation: ConversationMetadata = {
    id: 'c1',
    title: 'First round',
    filename: 'first-round-a1b2c3.md',
    createdAt: '2026-06-26T00:00:00Z',
    lastActivityAt: '2026-06-26T00:00:00Z',
  };

  assert.equal(conversation.filename, 'first-round-a1b2c3.md');
});
