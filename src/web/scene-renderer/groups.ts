import { SceneContentFrame } from './texture.js';
import type { ScenePrimitive } from './types.js';

function offset(element: HTMLElement) {
  let x = 0, y = 0;
  for (let node: HTMLElement | null = element; node; node = node.offsetParent as HTMLElement | null) { x += node.offsetLeft; y += node.offsetTop; }
  return { x, y };
}

/** Local CSS transforms are copied at Done, including an in-progress hover transition. */
function place(context: CanvasRenderingContext2D, node: HTMLElement, parent: HTMLElement, paint: (style: CSSStyleDeclaration) => void) {
  const style = getComputedStyle(node), position = offset(node), base = offset(parent), transform = style.transform === 'none' ? new DOMMatrix() : new DOMMatrix(style.transform), origin = style.transformOrigin.split(' ').map(Number.parseFloat);
  context.save(); context.translate(position.x - base.x, position.y - base.y);
  context.translate(origin[0] || 0, origin[1] || 0); context.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f); context.translate(-(origin[0] || 0), -(origin[1] || 0));
  context.globalAlpha *= Number(style.opacity); paint(style); context.restore();
}

function paintSvg(context: CanvasRenderingContext2D, svg: SVGSVGElement) {
  const style = getComputedStyle(svg), view = svg.viewBox.baseVal, width = Number.parseFloat(style.width), height = Number.parseFloat(style.height), scale = Math.min(width / view.width, height / view.height), root = svg.getCTM();
  context.save(); context.translate((width - view.width * scale) / 2, (height - view.height * scale) / 2); context.scale(scale, scale); context.translate(-view.x, -view.y);
  for (const shape of svg.querySelectorAll<SVGGraphicsElement>('path,rect,circle,ellipse,line,polyline,polygon')) {
    const drawStyle = getComputedStyle(shape), transform = root?.inverse().multiply(shape.getCTM()!); context.save();
    if (transform) context.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
    const number = (key: string) => Number(shape.getAttribute(key) || 0); let path: Path2D;
    if (shape.tagName === 'path') path = new Path2D(shape.getAttribute('d') || '');
    else { path = new Path2D(); if (shape.tagName === 'rect') path.roundRect(number('x'), number('y'), number('width'), number('height'), number('rx'));
      else if (shape.tagName === 'circle') path.arc(number('cx'), number('cy'), number('r'), 0, Math.PI * 2);
      else if (shape.tagName === 'ellipse') path.ellipse(number('cx'), number('cy'), number('rx'), number('ry'), 0, 0, Math.PI * 2);
      else if (shape.tagName === 'line') { path.moveTo(number('x1'), number('y1')); path.lineTo(number('x2'), number('y2')); }
      else { const points = (shape.getAttribute('points') || '').trim().split(/[ ,]+/).map(Number); for (let index = 0; index < points.length; index += 2) index ? path.lineTo(points[index], points[index + 1]) : path.moveTo(points[index], points[index + 1]); if (shape.tagName === 'polygon') path.closePath(); }
    }
    if (drawStyle.fill !== 'none') { context.fillStyle = drawStyle.fill; context.fill(path, drawStyle.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'); }
    if (drawStyle.stroke !== 'none') { context.strokeStyle = drawStyle.stroke; context.lineWidth = Number.parseFloat(drawStyle.strokeWidth); context.lineCap = drawStyle.strokeLinecap as CanvasLineCap; context.lineJoin = drawStyle.strokeLinejoin as CanvasLineJoin; context.stroke(path); }
    context.restore();
  }
  context.restore();
}

/** Text clipping uses fractional CSS dimensions; ellipsis follows live DOM overflow. */
function paintText(context: CanvasRenderingContext2D, element: HTMLElement, parent: HTMLElement) {
  place(context, element, parent, style => {
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`; context.fillStyle = style.color; context.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
    const number = (value: string) => Number.parseFloat(value) || 0;
    const paddingX = number(style.paddingLeft) + number(style.paddingRight), paddingY = number(style.paddingTop) + number(style.paddingBottom);
    const borderX = number(style.borderLeftWidth) + number(style.borderRightWidth), borderY = number(style.borderTopWidth) + number(style.borderBottomWidth);
    const contentWidth = number(style.width) - (style.boxSizing === 'border-box' ? paddingX + borderX : 0);
    const contentHeight = number(style.height) - (style.boxSizing === 'border-box' ? paddingY + borderY : 0);
    context.beginPath(); context.rect(0, 0, contentWidth + paddingX, contentHeight + paddingY); context.clip();
    const rows = Array.from(element.querySelectorAll<HTMLElement>(':scope > .folder-text-line'));
    const range = document.createRange(); range.selectNodeContents(element);
    const visibleWidth = element.getBoundingClientRect().width * contentWidth / (contentWidth + paddingX + borderX);
    const overflow = range.getBoundingClientRect().width > visibleWidth;
    for (const row of rows.length ? rows : [element]) {
      let text = row.querySelector<HTMLInputElement>('input')?.value || row.textContent || ''; text = text.replace(/\u200b/g, '');
      if (!rows.length && style.textOverflow === 'ellipsis' && overflow) { while (text && context.measureText(text + '…').width > contentWidth) text = Array.from(text).slice(0, -1).join(''); text += '…'; }
      const metrics = context.measureText(text), ascent = metrics.fontBoundingBoxAscent, descent = metrics.fontBoundingBoxDescent, lineHeight = Number.parseFloat(style.lineHeight) || element.clientHeight, position = offset(row), base = offset(element);
      context.fillText(text, position.x - base.x, position.y - base.y + Math.floor((lineHeight - ascent - descent) / 2) + ascent);
    }
  });
}

/** Copies folder art and content previews without introducing synthetic object identities. */
export function freezeGroupDecorations(board: HTMLElement): ScenePrimitive[] {
  const primitives: ScenePrimitive[] = [], style = getComputedStyle(document.documentElement), ink = style.getPropertyValue('--ink').trim(), edge = style.getPropertyValue('--edge').trim(), muted = style.getPropertyValue('--muted').trim();
  const family = getComputedStyle(board).fontFamily, boardBox = board.getBoundingClientRect(), matrix = new DOMMatrix(getComputedStyle(board.querySelector('.canvas-world')!).transform);
  for (const element of board.querySelectorAll<HTMLElement>('.board-group')) {
    const bounds = element.getBoundingClientRect(), elementStyle = getComputedStyle(element);
    const x = (bounds.x - boardBox.x - matrix.e) / matrix.a, y = (bounds.y - boardBox.y - matrix.f) / matrix.d, width = bounds.width / matrix.a, height = bounds.height / matrix.d;
    const opacity = Number(elementStyle.opacity), blur = Number(/blur\(([^p]+)px\)/.exec(elementStyle.filter)?.[1] || 0), artScale = width / Number.parseFloat(elementStyle.width);
    const exterior = opacity < 1 || blur > 0;
    if (element.classList.contains('group-frame')) {
      const title = element.dataset.groupName || 'Group', count = element.dataset.groupCount || '0';
      if (exterior) {
        const padding = 18, area = { width: width + padding * 2, height: height + padding * 2 }, scale = Math.min(2, Math.sqrt(8_000_000 / (area.width * area.height)));
        const pixels = document.createElement('canvas'); pixels.width = Math.max(1, Math.ceil(area.width * scale)); pixels.height = Math.max(1, Math.ceil(area.height * scale));
        const context = pixels.getContext('2d')!; context.scale(scale, scale); context.translate(padding, padding); context.globalAlpha = opacity; context.filter = `blur(${blur * scale}px)`;
        context.strokeStyle = edge; context.lineWidth = 1; context.beginPath(); context.roundRect(0, 0, width, height, 8); context.stroke();
        context.fillStyle = ink; context.font = `500 12px ${family}`; context.fillText(title, 15, 24, Math.max(1, width - 50));
        context.fillStyle = muted; context.font = `10px ${family}`; context.fillText(count, 20 + (element.querySelector<HTMLElement>('.group-frame-title>span')?.offsetWidth || 35), 24);
        primitives.push({ kind: 'texture', bounds: { x: x - padding, y: y - padding, ...area }, texture: new SceneContentFrame(document, { pixels, bitmap: { width: pixels.width, height: pixels.height } }) });
      } else primitives.push({ kind: 'rect', bounds: { x, y, width, height }, radius: 8, fill: 'transparent', stroke: edge, lineWidth: 1 }, { kind: 'text', x: x + 15, y: y + 24, text: title, fill: ink, font: `500 12px ${family}`, maxWidth: Math.max(1, width - 50), ellipsis: true }, { kind: 'text', x: x + 20 + (element.querySelector<HTMLElement>('.group-frame-title>span')?.offsetWidth || 35), y: y + 24, text: count, fill: muted, font: `10px ${family}` });
      continue;
    }
    const image = document.createElement('canvas'); image.width = 456; image.height = 546;
    const context = image.getContext('2d')!; context.scale(2, 2); context.translate(6, 6);
    const art = element.querySelector<HTMLElement>('.folder-art');
    if (art) {
      const back = art.querySelector<SVGSVGElement>('.folder-back'); if (back) paintSvg(context, back);
      const previews = art.querySelector<HTMLElement>('.folder-previews');
      if (previews) for (const card of previews.querySelectorAll<HTMLElement>('.folder-preview-card')) place(context, card, art, cardStyle => {
        const cardWidth = card.clientWidth, cardHeight = card.clientHeight, radius = Number.parseFloat(cardStyle.borderRadius) || 0;
        context.beginPath(); context.roundRect(0, 0, cardWidth, cardHeight, radius); context.clip();
        if (cardStyle.backgroundColor !== 'rgba(0, 0, 0, 0)') { context.fillStyle = cardStyle.backgroundColor; context.fillRect(0, 0, cardWidth, cardHeight); }
        const thumb = card.querySelector<HTMLElement>('.asset-thumb');
        if (thumb) place(context, thumb, card, () => {
          const preview = thumb.querySelector<HTMLImageElement>('img');
          if (preview?.complete && preview.naturalWidth) {
            const w = preview.clientWidth, h = preview.clientHeight, scale = getComputedStyle(preview).objectFit === 'contain' ? Math.min(w / preview.naturalWidth, h / preview.naturalHeight) : Math.max(w / preview.naturalWidth, h / preview.naturalHeight), paintWidth = preview.naturalWidth * scale, paintHeight = preview.naturalHeight * scale;
            context.save(); context.beginPath(); context.rect(0, 0, w, h); context.clip(); context.drawImage(preview, (w - paintWidth) / 2, (h - paintHeight) / 2, paintWidth, paintHeight); context.restore();
          } else {
            const icon = thumb.querySelector<SVGSVGElement>('svg');
            if (icon) { const size = getComputedStyle(icon), w = Number.parseFloat(size.width), h = Number.parseFloat(size.height); context.save(); context.translate((thumb.clientWidth - w) / 2, (thumb.clientHeight - h) / 2); paintSvg(context, icon); context.restore(); }
          }
        });
        for (const text of card.querySelectorAll<HTMLElement>('.folder-preview-kind,.folder-preview-copy')) paintText(context, text, card);
      });
      const front = art.querySelector<HTMLElement>('.folder-front');
      if (front) place(context, front, art, () => {
        const cover = front.querySelector<SVGSVGElement>('.folder-cover-svg'); if (cover) paintSvg(context, cover);
        for (const text of front.querySelectorAll<HTMLElement>('.folder-face-name,.folder-face-count')) paintText(context, text, front);
      });
    }
    const caption = element.querySelector<HTMLElement>('.folder-caption');
    if (caption) place(context, caption, element, () => { for (const text of Array.from(caption.children)) if (text instanceof HTMLElement) paintText(context, text, caption); });
    if (exterior) {
      const blurred = document.createElement('canvas'); blurred.width = image.width; blurred.height = image.height;
      const output = blurred.getContext('2d')!; output.filter = `blur(${blur * 2}px)`; output.globalAlpha = opacity; output.drawImage(image, 0, 0);
      primitives.push({ kind: 'texture', bounds: { x: x - 6 * artScale, y: y - 6 * artScale, width: 228 * artScale, height: 273 * artScale }, texture: new SceneContentFrame(document, { pixels: blurred, bitmap: { width: blurred.width, height: blurred.height } }) });
    } else primitives.push({ kind: 'texture', bounds: { x: x - 6 * artScale, y: y - 6 * artScale, width: 228 * artScale, height: 273 * artScale }, texture: new SceneContentFrame(document, { pixels: image, bitmap: { width: image.width, height: image.height } }) });
  }
  return primitives;
}
