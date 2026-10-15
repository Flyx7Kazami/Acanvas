import type { ContentAnchor } from '../../../shared/types.js';
import type { Immutable } from '../types.js';

/** Reading the displayed frame retains its exact scroll/selection and returns an independent intent value. */
export function presentedContentAnchor(source?: { contentAnchor?: ContentAnchor | Immutable<ContentAnchor> }): ContentAnchor | undefined {
  return source?.contentAnchor ? structuredClone(source.contentAnchor) as ContentAnchor : undefined;
}

/** Native Markdown selection is an input state; callers decide which presented frame owns it. */
export function readMarkdownContentAnchor(scroll: HTMLElement): ContentAnchor {
  const body = scroll.querySelector<HTMLElement>('.markdown-body'), anchor: ContentAnchor = { kind: 'visual', scroll: { x: scroll.scrollLeft, y: scroll.scrollTop } };
  const selection = scroll.ownerDocument.getSelection();
  if (!body || !selection?.rangeCount || selection.isCollapsed) return anchor;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return anchor;
  const quote = range.toString(); if (!quote.trim() || quote.length > 10_000) return anchor;
  const before = scroll.ownerDocument.createRange(); before.selectNodeContents(body); before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length, end = start + quote.length, content = body.textContent || '';
  const block = (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement)?.closest('p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td');
  const path: string[] = [];
  for (let element = block; element && element !== body; element = element.parentElement) {
    const siblings = element.parentElement ? Array.from(element.parentElement.children).filter(value => value.tagName === element!.tagName) : [];
    path.unshift(`${element.tagName.toLowerCase()}[${siblings.indexOf(element)}]`);
  }
  return { ...anchor, kind: 'text', quote, context: content.slice(Math.max(0, start - 100), Math.min(content.length, end + 100)), ...(path.length ? { path: `rendered-dom:${path.join('/')}` } : {}), start, end };
}
