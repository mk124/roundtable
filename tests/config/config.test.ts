import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SIZE_LIMITS, utf8Bytes } from '../../src/config/limits.ts';

test('size limits expose the passive chat-room byte budgets', () => {
  assert.equal(DEFAULT_SIZE_LIMITS.messageBytes, 512 * 1024);
  assert.equal(DEFAULT_SIZE_LIMITS.singleEventBytes, 1024 * 1024);
  assert.equal(DEFAULT_SIZE_LIMITS.conversationTotalBytes, 50 * 1024 * 1024);
});

test('utf8Bytes counts UTF-8 bytes, not characters', () => {
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('é'), 2); //   U+00E9 → 2 bytes
  assert.equal(utf8Bytes('€'), 3); //  a euro sign is 3 UTF-8 bytes
  assert.equal(utf8Bytes('😀'), 4); //  astral plane → 4 bytes
  assert.equal(utf8Bytes(''), 0);
});
