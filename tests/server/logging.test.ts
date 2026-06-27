import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedactingLogger } from '../../src/server/logging.ts';

function capture() {
  const lines: string[] = [];
  return { sink: { write: (l: string) => lines.push(l) }, lines };
}

test('registered secrets are redacted from log output', () => {
  const { sink, lines } = capture();
  const logger = new RedactingLogger(sink);
  logger.registerSecret('super-secret-token-value');
  logger.log('failure for super-secret-token-value during call');
  assert.equal(lines[0], 'failure for [redacted] during call');
});

test('redacts multiple distinct secrets', () => {
  const { sink, lines } = capture();
  const logger = new RedactingLogger(sink);
  logger.registerSecret('/Users/me/project/path', 'provider-auth-key-xyz');
  logger.log('cwd=/Users/me/project/path key=provider-auth-key-xyz');
  assert.equal(lines[0], 'cwd=[redacted] key=[redacted]');
});

test('unregistered text passes through unchanged', () => {
  const { sink, lines } = capture();
  const logger = new RedactingLogger(sink);
  logger.log('a normal status line');
  assert.equal(lines[0], 'a normal status line');
});

test('short or empty values are not registered', () => {
  const { sink, lines } = capture();
  const logger = new RedactingLogger(sink);
  logger.registerSecret('abc', '', null, undefined);
  logger.log('abc stays because it is too short to scrub');
  assert.match(lines[0]!, /^abc stays/);
});
