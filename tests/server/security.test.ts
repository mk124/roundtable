import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cspHeader } from '../../src/server/security.ts';

test('CSP locks down sources', () => {
  const csp = cspHeader();
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
});
