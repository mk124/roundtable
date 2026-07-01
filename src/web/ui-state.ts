export function composerState(opts: { hasConversation: boolean; readOnly: boolean }): { disabled: boolean; reason: string | null } {
  if (!opts.hasConversation) return { disabled: true, reason: 'Create a conversation to begin.' };
  if (opts.readOnly) return { disabled: true, reason: 'This conversation is read-only.' };
  return { disabled: false, reason: null };
}

export function el(doc: Document, tag: string, className?: string, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export type AgentAccent = 'claude' | 'gpt' | 'gemini';

export function agentAccent(author: string | undefined): AgentAccent | null {
  const name = author?.toLowerCase() ?? '';
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(name)) return 'claude';
  if (/gpt|codex/.test(name)) return 'gpt';
  if (/gemini|antigravity|\bagy\b/.test(name)) return 'gemini';
  return null;
}
