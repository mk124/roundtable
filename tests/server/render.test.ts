import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../src/server/render.ts';

test('renders a paragraph of text', () => {
  const nodes = renderMarkdown('hello world');
  assert.equal(nodes[0]!.type, 'paragraph');
  assert.equal(nodes[0]!.children![0]!.value, 'hello world');
});

test('renders headings with their level', () => {
  const nodes = renderMarkdown('## Title');
  assert.equal(nodes[0]!.type, 'heading');
  assert.equal(nodes[0]!.level, 2);
});

test('renders strong and emphasis', () => {
  const inline = renderMarkdown('**bold** and *em*')[0]!.children!;
  assert.ok(inline.some((n) => n.type === 'strong'));
  assert.ok(inline.some((n) => n.type === 'emphasis'));
});

test('renders inline and block code', () => {
  const inline = renderMarkdown('use `x`')[0]!.children!;
  assert.ok(inline.some((n) => n.type === 'code' && n.value === 'x'));

  const block = renderMarkdown('```js\ncode\n```');
  assert.equal(block[0]!.type, 'codeblock');
  assert.equal(block[0]!.lang, 'js');
  assert.equal(block[0]!.value, 'code\n');
});

test('renders lists', () => {
  const list = renderMarkdown('- a\n- b')[0]!;
  assert.equal(list.type, 'list');
  assert.equal(list.ordered, false);
  assert.equal(list.children!.length, 2);
  assert.equal(list.children![0]!.type, 'listitem');
});

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

test('renders tables', () => {
  const table = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |').find((n) => n.type === 'table');
  assert.ok(table);
  assert.ok(table!.children!.filter((n) => n.type === 'tablerow').length >= 2);
});
