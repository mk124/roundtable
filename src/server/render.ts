import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

type Token = ReturnType<typeof md.parse>[number];

/**
 * A safe render node. The server is the only Markdown-safety boundary: it
 * parses with raw HTML disabled and emits an allowlisted node tree. The frontend
 * builds DOM/text nodes from this and never calls innerHTML, so untrusted
 * conversation content can never become markup.
 */
export interface RenderNode {
  type:
    | 'text'
    | 'break'
    | 'paragraph'
    | 'heading'
    | 'blockquote'
    | 'list'
    | 'listitem'
    | 'table'
    | 'tablerow'
    | 'tablecell'
    | 'codeblock'
    | 'code'
    | 'strong'
    | 'emphasis'
    | 'link'
    | 'span';
  value?: string;
  children?: RenderNode[];
  level?: number;
  ordered?: boolean;
  href?: string;
  lang?: string | null;
  header?: boolean;
}

/** Parse Markdown into an allowlisted, DOM-safe render tree. */
export function renderMarkdown(markdown: string): RenderNode[] {
  return convertBlocks(md.parse(markdown, {}));
}

/** Allow only http/https/mailto and relative URLs; reject any other scheme
 *  (javascript:, data:, file:, etc.) so dangerous links are never clickable. */
function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const value = href.trim();
  if (/^(?:https?:|mailto:)/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null; // some other scheme
  return value; // relative URL (no scheme)
}

/** A cursor over a render tree under construction: append a node to the current
 *  parent, or open/close a nesting level. Both converters drive one of these. */
function treeCursor(root: RenderNode) {
  const stack: RenderNode[] = [root];
  const top = () => stack[stack.length - 1]!;
  const add = (node: RenderNode) => top().children!.push(node);
  const open = (node: RenderNode) => {
    add(node);
    stack.push(node);
  };
  const close = () => void stack.pop();
  return { top, add, open, close };
}

function convertBlocks(tokens: Token[]): RenderNode[] {
  const root: RenderNode = { type: 'span', children: [] };
  const { top, add, open, close } = treeCursor(root);

  for (const token of tokens) {
    switch (token.type) {
      case 'paragraph_open': open({ type: 'paragraph', children: [] }); break;
      case 'heading_open': open({ type: 'heading', level: Number(token.tag.slice(1)) || 1, children: [] }); break;
      case 'blockquote_open': open({ type: 'blockquote', children: [] }); break;
      case 'bullet_list_open': open({ type: 'list', ordered: false, children: [] }); break;
      case 'ordered_list_open': open({ type: 'list', ordered: true, children: [] }); break;
      case 'list_item_open': open({ type: 'listitem', children: [] }); break;
      case 'table_open': open({ type: 'table', children: [] }); break;
      case 'tr_open': open({ type: 'tablerow', children: [] }); break;
      case 'th_open': open({ type: 'tablecell', header: true, children: [] }); break;
      case 'td_open': open({ type: 'tablecell', header: false, children: [] }); break;

      case 'paragraph_close':
      case 'heading_close':
      case 'blockquote_close':
      case 'bullet_list_close':
      case 'ordered_list_close':
      case 'list_item_close':
      case 'table_close':
      case 'tr_close':
      case 'th_close':
      case 'td_close':
        close();
        break;

      case 'fence':
      case 'code_block':
        add({ type: 'codeblock', value: token.content, lang: token.info.trim() || null });
        break;
      case 'inline':
        convertInline(token.children ?? [], top());
        break;
      case 'html_block':
        add({ type: 'text', value: token.content }); // raw HTML -> literal text
        break;
      default:
        break; // thead/tbody wrappers, hr, etc. are flattened or dropped
    }
  }
  return root.children!;
}

function convertInline(tokens: Token[], parent: RenderNode): void {
  const { add, open, close } = treeCursor(parent);

  for (const token of tokens) {
    switch (token.type) {
      case 'text': add({ type: 'text', value: token.content }); break;
      case 'code_inline': add({ type: 'code', value: token.content }); break;
      case 'softbreak':
      case 'hardbreak':
        add({ type: 'break' });
        break;
      case 'strong_open': open({ type: 'strong', children: [] }); break;
      case 'em_open': open({ type: 'emphasis', children: [] }); break;
      case 'strong_close':
      case 'em_close':
        close();
        break;
      case 'link_open': {
        const href = safeHref(token.attrGet('href'));
        // An unsafe href degrades to a plain span so the text stays but is not a link.
        open(href ? { type: 'link', href, children: [] } : { type: 'span', children: [] });
        break;
      }
      case 'link_close': close(); break;
      case 'image': add({ type: 'text', value: token.content }); break; // image -> alt text only
      case 'html_inline': add({ type: 'text', value: token.content }); break; // raw HTML -> text
      default:
        if (token.content) add({ type: 'text', value: token.content });
        break;
    }
  }
}
