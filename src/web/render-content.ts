import type { RenderNode } from '../server/render.ts';

/**
 * Build DOM from the server's allowlisted render tree using only
 * createElement/createTextNode, so untrusted conversation content can never
 * become markup.
 */
export function renderContent(nodes: RenderNode[], doc: Document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  for (const node of nodes) fragment.appendChild(renderNode(node, doc));
  return fragment;
}

function renderNode(node: RenderNode, doc: Document): Node {
  switch (node.type) {
    case 'text':
      return doc.createTextNode(node.value ?? '');
    case 'break':
      return doc.createElement('br');
    case 'code': {
      const el = doc.createElement('code');
      el.textContent = node.value ?? '';
      return el;
    }
    case 'codeblock': {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = node.value ?? '';
      pre.appendChild(code);
      return pre;
    }
    case 'link': {
      const el = doc.createElement('a');
      el.setAttribute('href', node.href ?? '#');
      el.setAttribute('rel', 'noopener noreferrer nofollow');
      appendChildren(el, node, doc);
      return el;
    }
    case 'list':
      return wrap(node.ordered ? 'ol' : 'ul', node, doc);
    case 'heading':
      return wrap(`h${Math.min(6, Math.max(1, node.level ?? 1))}`, node, doc);
    case 'tablecell':
      return wrap(node.header ? 'th' : 'td', node, doc);
    default:
      return wrap(TAG[node.type] ?? 'span', node, doc);
  }
}

const TAG: Partial<Record<RenderNode['type'], string>> = {
  paragraph: 'p',
  blockquote: 'blockquote',
  strong: 'strong',
  emphasis: 'em',
  span: 'span',
  listitem: 'li',
  table: 'table',
  tablerow: 'tr',
};

function wrap(tag: string, node: RenderNode, doc: Document): HTMLElement {
  const el = doc.createElement(tag);
  appendChildren(el, node, doc);
  return el;
}

function appendChildren(el: HTMLElement, node: RenderNode, doc: Document): void {
  for (const child of node.children ?? []) el.appendChild(renderNode(child, doc));
}
