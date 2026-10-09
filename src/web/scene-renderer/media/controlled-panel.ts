import type { ContentTextRun } from '../content.js';
import { scenePaintMethods, scenePaintNumbers, scenePaintStrings, type ScenePaintArgument, type ScenePaintCommand, type ScenePaintMethod, type ScenePaintProperty } from '../paint-commands.js';
import type { Bounds } from '../../../shared/types.js';

export interface CompiledPanel { frame: Omit<PaintedPanel, 'pixels'>; commands: () => ScenePaintCommand[] }
export interface PaintedPanel { pixels: HTMLCanvasElement; bitmap: { width: number; height: number }; cssSize: { width: number; height: number }; textRuns: ContentTextRun[] }
const visible = (box: Bounds, clip: Bounds) => box.x < clip.x + clip.width && box.y < clip.y + clip.height && box.x + box.width > clip.x && box.y + box.height > clip.y;
const length = (value: string) => Number.parseFloat(value) || 0;
const transparent = (color: string) => !color || color === 'transparent' || color === 'rgba(0, 0, 0, 0)';
function font(style: CSSStyleDeclaration) { return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`; }

function readControlledPanel(root: HTMLElement, options: { pixelRatio?: number; textRoot?: HTMLElement; gpu?: boolean; dynamicElements?: HTMLElement[] } = {}): { frame: PaintedPanel; commands: () => ScenePaintCommand[] } {
  const width = root.clientWidth, height = root.clientHeight, ratio = Math.min(3, Math.max(1, options.pixelRatio ?? window.devicePixelRatio ?? 1));
  if (width < 1 || height < 1 || width * height * ratio * ratio > 8_000_000) throw new Error('The content panel exceeds the supported bitmap size.');
  const area = root.getBoundingClientRect(), scaleX = area.width / width, scaleY = area.height / height;
  if (!scaleX || !scaleY) throw new Error('The content panel is outside the presented layout.');
  const pixels = root.ownerDocument.createElement('canvas'); pixels.width = Math.round(width * ratio); pixels.height = Math.round(height * ratio);
  const recorded: (ScenePaintCommand | (() => ScenePaintCommand))[] = [];
  const native = pixels.getContext('2d', options.gpu ? undefined : { willReadFrequently: true })!;
  const context = options.dynamicElements ? new Proxy(native, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof property === 'string' && (scenePaintMethods as readonly string[]).includes(property)) return (...args: ScenePaintArgument[]) => {
        recorded.push({ op: 'call', method: property as ScenePaintMethod, args });
        if (['save', 'restore', 'setTransform', 'translate', 'scale', 'transform', 'setLineDash'].includes(property)) Reflect.apply(value, target, args);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (typeof property !== 'string' || ![...scenePaintStrings, ...scenePaintNumbers].includes(property as ScenePaintProperty)) throw new TypeError('Use a supported panel paint property.');
      recorded.push({ op: 'set', property: property as ScenePaintProperty, value }); return Reflect.set(target, property, value, target);
    },
  }) : native;
  context.setTransform(pixels.width / width, 0, 0, pixels.height / height, 0, 0);
  const clip: Bounds = { x: 0, y: 0, width, height }, textRuns: ContentTextRun[] = [];
  const local = (rect: DOMRect): Bounds => ({ x: (rect.x - area.x) / scaleX, y: (rect.y - area.y) / scaleY, width: rect.width / scaleX, height: rect.height / scaleY });
  const round = (bounds: Bounds, radius: number) => { context.beginPath(); context.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, Math.max(0, Math.min(radius, bounds.width / 2, bounds.height / 2))); };
  const range = root.ownerDocument.createRange();
  let characters = 0, offset = 0, nodes = 0;
  const selection = root.ownerDocument.getSelection();
  const selected = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : undefined;

  function svg(element: SVGSVGElement, box: Bounds) {
    const view = element.viewBox.baseVal, viewWidth = view.width || Number(element.getAttribute('width')) || box.width, viewHeight = view.height || Number(element.getAttribute('height')) || box.height;
    context.save(); context.translate(box.x, box.y); context.scale(box.width / viewWidth, box.height / viewHeight); context.translate(-view.x, -view.y);
    const draw = (node: Element) => {
      const style = getComputedStyle(node), transform = node instanceof SVGGraphicsElement ? node.transform.baseVal.consolidate()?.matrix : undefined;
      context.save(); if (transform) context.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
      let path: Path2D | undefined;
      if (node.tagName.toLowerCase() === 'path') { const styled = style.getPropertyValue('d'), data = styled.match(/^path\(["'](.+)["']\)$/)?.[1] ?? node.getAttribute('d'); if (data) { try { path = new Path2D(data); } catch { path = new Path2D(node.getAttribute('d') ?? ''); } } }
      else if (node.tagName.toLowerCase() === 'circle') { path = new Path2D(); path.arc(length(node.getAttribute('cx') ?? ''), length(node.getAttribute('cy') ?? ''), length(node.getAttribute('r') ?? ''), 0, Math.PI * 2); }
      else if (node.tagName.toLowerCase() === 'rect') { path = new Path2D(); path.rect(length(node.getAttribute('x') ?? ''), length(node.getAttribute('y') ?? ''), length(node.getAttribute('width') ?? ''), length(node.getAttribute('height') ?? '')); }
      else if (node.tagName.toLowerCase() === 'line') { path = new Path2D(); path.moveTo(length(node.getAttribute('x1') ?? ''), length(node.getAttribute('y1') ?? '')); path.lineTo(length(node.getAttribute('x2') ?? ''), length(node.getAttribute('y2') ?? '')); }
      else if (['polyline', 'polygon'].includes(node.tagName.toLowerCase())) { const points = (node.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number); path = new Path2D(); for (let i = 0; i + 1 < points.length; i += 2) { if (i === 0) path.moveTo(points[i], points[i + 1]); else path.lineTo(points[i], points[i + 1]); } if (node.tagName.toLowerCase() === 'polygon') path.closePath(); }
      if (path) {
        if (style.fill !== 'none') { context.fillStyle = style.fill === 'currentcolor' ? style.color : style.fill; context.fill(path); }
        if (style.stroke !== 'none' && length(style.strokeWidth) > 0) { context.strokeStyle = style.stroke === 'currentcolor' ? style.color : style.stroke; context.lineWidth = length(style.strokeWidth); context.lineCap = style.strokeLinecap as CanvasLineCap; context.lineJoin = style.strokeLinejoin as CanvasLineJoin; context.stroke(path); }
      }
      for (const child of Array.from(node.children)) draw(child); context.restore();
    };
    for (const child of Array.from(element.children)) draw(child); context.restore();
  }
  function text(node: Text, style: CSSStyleDeclaration, record: boolean) {
    const value = node.data, startOffset = offset; if (record) offset += value.length;
    const parent = node.parentElement; if (!parent || !value) return;
    range.selectNodeContents(node); const nodeBox = local(range.getBoundingClientRect());
    if (!visible(nodeBox, clip)) return;
    context.font = font(style); context.fillStyle = style.color; context.textBaseline = 'alphabetic'; context.textAlign = 'left'; context.direction = style.direction as CanvasDirection; context.fontKerning = style.fontKerning as CanvasFontKerning;
    context.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
    const box = local(parent.getBoundingClientRect());
    const ellipsis = style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap' && parent.scrollWidth > parent.clientWidth;
    const availableRight = ellipsis ? box.x + box.width - context.measureText('…').width : Infinity;
    type Line = { text: string; start: number; end: number; bounds: Bounds };
    const lines: Line[] = []; let line: Line | undefined;
    let first = 0, end = value.length;
    if (value.length > 2048) {
      const bound = (boundary: number, trailing: boolean) => {
        let low = 0, high = value.length;
        while (low < high) { const middle = Math.floor((low + high) / 2); range.setStart(node, middle); range.setEnd(node, middle + 1); const rect = local(range.getBoundingClientRect()); if ((trailing ? rect.y : rect.y + rect.height) < boundary) low = middle + 1; else high = middle; }
        return low;
      };
      first = bound(clip.y, false); end = Math.min(value.length, bound(clip.y + clip.height, true) + 1);
      if (first && /[\uDC00-\uDFFF]/.test(value[first])) first--;
      if (end < value.length && /[\uDC00-\uDFFF]/.test(value[end])) end++;
    }
    if ((characters += end - first) > 50_000) throw new Error('The visible content text exceeds the supported frame size.');
    for (let index = first; index < end;) {
      const size = value.codePointAt(index)! > 0xffff ? 2 : 1;
      range.setStart(node, index); range.setEnd(node, index + size); const rect = local(range.getBoundingClientRect());
      if (rect.width > .0001 && rect.height > .0001 && rect.x + rect.width <= availableRight + .0001) {
        const character = value.slice(index, index + size);
        if (!line || Math.abs(line.bounds.y - rect.y) > .7 || rect.x < line.bounds.x - .1) { line = { text: character, start: index, end: index + size, bounds: rect }; lines.push(line); }
        else { line.text += character; line.end = index + size; line.bounds.width = rect.x + rect.width - line.bounds.x; line.bounds.height = Math.max(line.bounds.height, rect.height); }
      }
      index += size;
    }
    for (const line of lines) {
      const rendered = ['normal', 'nowrap', 'pre-line'].includes(style.whiteSpace) ? line.text.replace(/[\t\n\r ]+/g, ' ') : line.text;
      if (!rendered.trim()) continue;
      const metrics = context.measureText(rendered), ascent = metrics.fontBoundingBoxAscent || length(style.fontSize) * .8;
      if (selected && selected.intersectsNode(node)) {
        const selectedStart = selected.startContainer === node ? selected.startOffset : 0, selectedEnd = selected.endContainer === node ? selected.endOffset : value.length;
        if (selectedStart < line.end && selectedEnd > line.start) {
          range.setStart(node, Math.max(line.start, selectedStart)); range.setEnd(node, Math.min(line.end, selectedEnd));
          context.save(); context.fillStyle = 'rgba(112,161,238,.4)'; for (const rect of Array.from(range.getClientRects())) { const localRect = local(rect); context.fillRect(localRect.x, localRect.y, localRect.width, localRect.height); } context.restore();
        }
      }
      context.fillText(rendered, line.bounds.x, line.bounds.y + ascent);
      if (options.dynamicElements?.includes(parent)) {
        const position = recorded.length - 1, command = recorded[position];
        if (typeof command === 'function' || command.op !== 'call' || command.method !== 'fillText') throw new Error('The panel text command must follow its native paint order.');
        const start = line.start, end = line.end === value.length ? undefined : line.end, whitespace = style.whiteSpace;
        recorded[position] = () => { const value = (parent.textContent ?? '').slice(start, end), text = ['normal', 'nowrap', 'pre-line'].includes(whitespace) ? value.replace(/[\t\n\r ]+/g, ' ') : value; return { ...command, args: [text, ...command.args.slice(1)] }; };
      }
      if (style.textDecorationLine.includes('underline')) { context.save(); context.strokeStyle = style.color; context.lineWidth = 1; context.beginPath(); context.moveTo(line.bounds.x, line.bounds.y + ascent + Math.max(1, length(style.textUnderlineOffset))); context.lineTo(line.bounds.x + line.bounds.width, line.bounds.y + ascent + Math.max(1, length(style.textUnderlineOffset))); context.stroke(); context.restore(); }
      if (record) textRuns.push({ text: value.slice(line.start, line.end), start: startOffset + line.start, end: startOffset + line.end, bounds: { ...line.bounds }, ...(parent.closest('a')?.getAttribute('href') ? { href: parent.closest('a')!.getAttribute('href')! } : {}) });
    }
    if (ellipsis && lines.length) { const last = lines[lines.length - 1], metrics = context.measureText('…'); context.fillText('…', Math.min(availableRight, last.bounds.x + last.bounds.width), last.bounds.y + (metrics.fontBoundingBoxAscent || length(style.fontSize) * .8)); }
  }
  function paint(element: Element, textScope: boolean) {
    if (++nodes > 5000) throw new Error('The content layout exceeds the supported node count.');
    const style = getComputedStyle(element); if (style.display === 'none' || style.visibility === 'hidden') return;
    const box = local(element.getBoundingClientRect());
    const record = textScope || element === options.textRoot;
    context.save(); context.globalAlpha *= element === root ? 1 : Number(style.opacity || 1);
    const radius = length(style.borderTopLeftRadius);
    if (box.width > 0 && box.height > 0 && visible(box, clip)) {
      if (!transparent(style.backgroundColor)) { round(box, radius); context.fillStyle = style.backgroundColor; context.fill(); }
      const widths = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(length), colors = [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];
      if (widths.every(value => value === widths[0]) && widths[0] > 0) { round({ x: box.x + widths[0] / 2, y: box.y + widths[0] / 2, width: box.width - widths[0], height: box.height - widths[0] }, radius); context.lineWidth = widths[0]; context.strokeStyle = colors[0]; if (style.borderTopStyle === 'dashed') context.setLineDash([4, 3]); context.stroke(); context.setLineDash([]); }
      else for (let side = 0; side < 4; side++) if (widths[side] > 0) { context.fillStyle = colors[side]; if (side === 0) context.fillRect(box.x, box.y, box.width, widths[side]); if (side === 1) context.fillRect(box.x + box.width - widths[side], box.y, widths[side], box.height); if (side === 2) context.fillRect(box.x, box.y + box.height - widths[side], box.width, widths[side]); if (side === 3) context.fillRect(box.x, box.y, widths[side], box.height); }
      if (length(style.outlineWidth) > 0 && style.outlineStyle !== 'none') { const gap = length(style.outlineOffset) + length(style.outlineWidth) / 2; round({ x: box.x - gap, y: box.y - gap, width: box.width + gap * 2, height: box.height + gap * 2 }, radius); context.strokeStyle = style.outlineColor; context.lineWidth = length(style.outlineWidth); context.stroke(); }
      if (['hidden', 'auto', 'scroll', 'clip'].includes(style.overflowX) || ['hidden', 'auto', 'scroll', 'clip'].includes(style.overflowY)) { round(box, radius); context.clip(); }
      if (element instanceof HTMLCanvasElement && element.width && element.height) context.drawImage(element, box.x, box.y, box.width, box.height);
      else if (element instanceof HTMLImageElement && element.complete && element.naturalWidth) { round(box, radius); context.clip(); context.drawImage(element, box.x, box.y, box.width, box.height); }
      else if (element instanceof SVGSVGElement) svg(element, box);
      if (element.tagName.toLowerCase() === 'li') { const first = element.firstChild; if (first) { range.selectNodeContents(first); const rect = local(range.getBoundingClientRect()); context.fillStyle = style.color; if (element.parentElement?.tagName === 'OL') { context.font = font(style); context.fillText(`${Array.from(element.parentElement.children).indexOf(element) + 1}.`, box.x - 20, rect.y + length(style.fontSize)); } else { context.beginPath(); context.arc(box.x - 12, rect.y + rect.height / 2, 2, 0, Math.PI * 2); context.fill(); } } }
    }
    if (!(element instanceof SVGSVGElement)) for (const child of Array.from(element.childNodes)) { if (child.nodeType === Node.TEXT_NODE) text(child as Text, style, record); else if (child instanceof Element) paint(child, record); }
    context.restore();
  }
  context.save(); context.beginPath(); context.rect(0, 0, width, height); context.clip(); paint(root, options.textRoot === root); context.restore();
  if (!options.dynamicElements) context.getImageData(0, 0, 1, 1);
  return { frame: { pixels, bitmap: { width: pixels.width, height: pixels.height }, cssSize: { width, height }, textRuns }, commands: () => recorded.map(command => typeof command === 'function' ? command() : command) };
}

/** Full panel and cached commands share one traversal and drawing vocabulary. */
export function paintControlledPanel(root: HTMLElement, options: { pixelRatio?: number; textRoot?: HTMLElement; gpu?: boolean } = {}): PaintedPanel { return readControlledPanel(root, options).frame; }

/** Layout is read once; native image sources and clock text are consumed in paint order. */
export function compileControlledPanel(root: HTMLElement, dynamicElements: HTMLElement[], textRoot?: HTMLElement): CompiledPanel {
  const result = readControlledPanel(root, { dynamicElements, textRoot }); const { pixels, ...frame } = result.frame;
  return { frame, commands: result.commands };
}
