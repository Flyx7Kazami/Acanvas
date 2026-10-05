/** True for text glyphs, controls and scrollbars; surrounding layout space is draggable. */
export function isContentInteraction(root: HTMLElement, x: number, y: number, target?: Element | null): boolean {
  const doc = root.ownerDocument;
  if (root === doc.documentElement) {
    const view = doc.defaultView!;
    if (root.scrollHeight > root.clientHeight + 1 && x >= Math.min(root.clientWidth, view.innerWidth - 10)) return true;
    if (root.scrollWidth > root.clientWidth + 1 && y >= Math.min(root.clientHeight, view.innerHeight - 10)) return true;
  }
  let element = target || doc.elementFromPoint(x, y);
  const controls = 'button,a,input,textarea,select,option,label,summary,[contenteditable=""],[contenteditable="true"],[role="button"],[role="link"],[role="slider"],[role="checkbox"],[role="switch"],[role="tab"],[role="menuitem"],[role="radio"],[role="combobox"],[role="textbox"],audio[controls],video[controls],canvas';
  for (let current = element; current && root.contains(current); current = current.parentElement) {
    if (current.matches(controls) || (current as HTMLElement).isContentEditable || typeof (current as HTMLElement).onclick === 'function' || getComputedStyle(current).cursor === 'pointer') return true;
    const node = current as HTMLElement, rect = node.getBoundingClientRect();
    if (node.scrollHeight > node.clientHeight + 1 && x >= rect.right - Math.max(10, node.offsetWidth - node.clientWidth) * rect.width / (node.offsetWidth || 1)) return true;
    if (node.scrollWidth > node.clientWidth + 1 && y >= rect.bottom - Math.max(10, node.offsetHeight - node.clientHeight) * rect.height / (node.offsetHeight || 1)) return true;
    if (current === root) break;
  }
  const browserDoc = doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  const caret = browserDoc.caretRangeFromPoint?.(x, y);
  const position = caret ? { offsetNode: caret.startContainer, offset: caret.startOffset } : browserDoc.caretPositionFromPoint?.(x, y);
  if (!position || position.offsetNode.nodeType !== 3 || !root.contains(position.offsetNode)) return false;
  const text = position.offsetNode as Text, parent = text.parentElement;
  if (!parent || getComputedStyle(parent).userSelect === 'none') return false;
  for (const offset of [position.offset - 1, position.offset]) {
    if (offset < 0 || offset >= text.length) continue;
    const range = doc.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1);
    for (const rect of Array.from(range.getClientRects())) if (x >= rect.left - .5 && x <= rect.right + .5 && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}
