import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationFilename, conversationId, shortId, slugify } from '../../src/conversations/naming.ts';

test('slugify collapses non-alphanumerics and trims dashes', () => {
  assert.equal(slugify('My First Chat'), 'my-first-chat');
  assert.equal(slugify('  Hello, World!  '), 'hello-world');
  assert.equal(slugify('!!!'), '');
});

test('shortId and conversationId are hex strings of the expected length', () => {
  assert.match(shortId(), /^[0-9a-f]{8}$/);
  assert.match(conversationId(), /^[0-9a-f]{16}$/);
  assert.notEqual(conversationId(), conversationId());
});

test('conversationFilename uses an English slug and short id', () => {
  assert.equal(conversationFilename('My First Chat', 'abcd1234'), 'my-first-chat-abcd1234.md');
});

test('an empty or unsluggable title falls back to a dated name', () => {
  const date = new Date('2026-06-26T12:00:00Z');
  assert.equal(conversationFilename('', 'abcd1234', date), 'conversation-2026-06-26-abcd1234.md');
  assert.equal(conversationFilename('!!!', 'abcd1234', date), 'conversation-2026-06-26-abcd1234.md');
});
