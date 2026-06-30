import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../src/server/render.ts';

test('allows safe links', () => {
  const link = renderMarkdown('[x](https://example.com)')[0]!.children!.find((n) => n.type === 'link');

  assert.ok(link);
  assert.equal(link!.href, 'https://example.com');
});

test('a javascript: link is never a clickable link', () => {
  const nodes = renderMarkdown('[x](javascript:alert(1))');
  const json = JSON.stringify(nodes);
  // markdown-it keeps it as literal text (safe); no link node, no href ever
  assert.ok(!json.includes('"type":"link"'));
  assert.ok(!json.includes('"href"'));
});

test('a non-allowlisted scheme degrades to a non-link span', () => {
  const inline = renderMarkdown('[x](ftp://host/file)')[0]!.children!;
  assert.ok(!inline.some((n) => n.type === 'link')); // safeHref rejects ftp:
  assert.ok(inline.some((n) => n.type === 'span'));
});

test('images render as alt text with no img element or URL', () => {
  const nodes = renderMarkdown('![alt text](https://example.com/secret.png)');
  assert.ok(nodes[0]!.children!.some((n) => n.type === 'text' && n.value === 'alt text'));
  assert.ok(!JSON.stringify(nodes).includes('secret.png'));
});

test('raw HTML becomes literal text, never structure', () => {
  const nodes = renderMarkdown('<script>alert(1)</script>');
  assert.ok(JSON.stringify(nodes).includes('script')); // present only as text content
  assert.ok(nodes.every((n) => n.type === 'paragraph' || n.type === 'text'));
});
