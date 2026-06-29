import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeProjectDir, isProjectId, projectId, projectTitle } from '../../src/projects/naming.ts';

test('projectId is a 16-hex-char URL-safe handle, distinct each call', () => {
  assert.match(projectId(), /^[0-9a-f]{16}$/);
  assert.notEqual(projectId(), projectId());
  assert.equal(isProjectId(projectId()), true);
  assert.equal(isProjectId('#Volumes#External'), false); // an encoded dir is not a valid id
  assert.equal(isProjectId('XYZ'), false);
});

test('encodeProjectDir maps an absolute path to a single #-joined segment', () => {
  assert.equal(encodeProjectDir('/Volumes/External/Project'), '#Volumes#External#Project');
});

test('encodeProjectDir result is a single path segment (no slash)', () => {
  assert.equal(encodeProjectDir('/Volumes/External/Project').includes('/'), false);
});

test('encodeProjectDir is injective: a literal # in a segment cannot collide', () => {
  // Without escaping, '/a#b/c' and '/a/b/c' would both encode to '#a#b#c'.
  assert.notEqual(encodeProjectDir('/a#b/c'), encodeProjectDir('/a/b/c'));
  assert.equal(encodeProjectDir('/a#b/c'), '#a%23b#c');
  // '%' is escaped before '#' so '%23' typed by a user stays distinct from an escaped '#'.
  assert.notEqual(encodeProjectDir('/a%23b'), encodeProjectDir('/a#b'));
});

test('encodeProjectDir normalizes equivalent paths to one directory', () => {
  const canonical = encodeProjectDir('/a/b');
  assert.equal(encodeProjectDir('/a/b/'), canonical);
  assert.equal(encodeProjectDir('/a//b'), canonical);
  assert.equal(encodeProjectDir('/a/./b'), canonical);
  assert.equal(encodeProjectDir('/a/x/../b'), canonical);
});

test('encodeProjectDir cannot escape its parent: an upward-climbing path stays one segment', () => {
  // `..` past the root is resolved lexically, so join(projects, encoded) can never
  // climb out of projects/ — the result has no slash and no standalone `..`.
  const encoded = encodeProjectDir('/a/b/../../../../etc/passwd');
  assert.equal(encoded.includes('/'), false);
  assert.equal(encoded.split('#').includes('..'), false);
  assert.equal(encoded, encodeProjectDir('/etc/passwd'));
});

test('encodeProjectDir keeps the root and odd segments filesystem-safe and non-empty', () => {
  assert.equal(encodeProjectDir('/'), '#');
  const spaced = encodeProjectDir('/My Projects/café');
  assert.equal(spaced, '#My Projects#café');
  assert.equal(spaced.includes('/'), false);
  assert.ok(spaced.length > 0);
});

test('projectTitle is the basename, falling back for the root', () => {
  assert.equal(projectTitle('/Volumes/External/Project'), 'Project');
  assert.equal(projectTitle('/Volumes/External/Project/'), 'Project');
  assert.equal(projectTitle('/'), '/');
});
