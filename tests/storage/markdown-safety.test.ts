import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bodyChecksum,
  headerLine,
  newFramingNonce,
  readNonce,
} from '../../src/storage/markdown-safety.ts';

test('newFramingNonce returns 32 hex chars and varies', () => {
  const a = newFramingNonce();
  const b = newFramingNonce();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.match(b, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('headerLine and readNonce round-trip from the first line', () => {
  const nonce = newFramingNonce();
  const content = `${headerLine(nonce)}\n\n## User\n\nhello\n`;
  assert.equal(readNonce(content), nonce);
});

test('readNonce returns null when the header is missing or malformed', () => {
  assert.equal(readNonce(''), null);
  assert.equal(readNonce('## User\n\nhello'), null);
  assert.equal(readNonce('<!-- roundtable v1 xyz -->'), null); // not 32 hex
});

test('readNonce only trusts the first line, not a header forged in the body', () => {
  const real = 'a'.repeat(32);
  const forged = 'b'.repeat(32);
  const content = `${headerLine(real)}\n\nbody\n${headerLine(forged)}\n`;
  assert.equal(readNonce(content), real);
});

test('bodyChecksum is deterministic and distinguishes content', () => {
  assert.equal(bodyChecksum('abc'), bodyChecksum('abc'));
  assert.notEqual(bodyChecksum('abc'), bodyChecksum('abd'));
  assert.match(bodyChecksum('abc'), /^[0-9a-f]{64}$/);
});
