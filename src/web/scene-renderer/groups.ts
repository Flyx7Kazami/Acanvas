import type { GroupColor } from '../../shared/types.js';
import { folderBack, folderFront, folderPalettes, folderLinePositions } from '../GroupFolder.js';
import { SceneContentFrame } from './texture.js';
import type { ScenePrimitive } from './types.js';

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
    const color = element.dataset.groupColor as GroupColor, colors = folderPalettes[color];
    const fillPath = (path: string, color: string) => { context.fillStyle = color; context.fill(new Path2D(path), 'evenodd'); };
    fillPath(folderBack, colors[1]);
    for (const [index, card] of Array.from(element.querySelectorAll<HTMLElement>('.folder-preview-card')).entries()) {
      const left = [10, 72, 134][index], top = [8, 1, 8][index], angle = [-4, 0, 4][index] * Math.PI / 180;
      context.save(); context.translate(left + 36, top + 53); context.rotate(angle); context.translate(-36, -53);
      context.fillStyle = '#F3EBDD'; context.beginPath(); context.roundRect(0, 0, 72, 106, 6); context.fill();
      const preview = card.querySelector<HTMLImageElement>('img');
      if (preview?.complete && preview.naturalWidth) {
        context.save(); context.beginPath(); context.roundRect(6, 6, 60, 94, 3); context.clip();
        const scale = Math.max(60 / preview.naturalWidth, 94 / preview.naturalHeight), w = preview.naturalWidth * scale, h = preview.naturalHeight * scale;
        context.drawImage(preview, 6 + (60 - w) / 2, 6 + (94 - h) / 2, w, h); context.restore();
      } else {
        context.fillStyle = '#202124'; context.font = `7px ${family}`; context.fillText(card.querySelector('small')?.textContent || 'FILE', 6, 15);
        context.font = `10px ${family}`;
        const lines = (card.dataset.previewText || 'File').split(/\n/).flatMap(line => line.match(/.{1,12}/g) || ['']);
        lines.slice(0, 6).forEach((line, lineIndex) => context.fillText(line, 6, 32 + lineIndex * 13, 64));
      }
      context.restore();
    }
    fillPath(folderFront, colors[0]); context.strokeStyle = colors[2]; context.lineWidth = 1.2;
    for (const y of folderLinePositions) { context.beginPath(); context.moveTo(22, y); context.lineTo(107, y); context.stroke(); }
    for (const y of [109, 169]) { context.beginPath(); context.moveTo(145, y); context.lineTo(194, y); context.stroke(); }
    context.fillStyle = colors[2]; context.font = `500 28px ${family}`; context.fillText(String(element.dataset.groupCount || 0).padStart(2, '0'), 145, 145);
    context.font = `7px ${family}`; context.letterSpacing = '1.3px'; context.fillText('ITEMS', 145, 158); context.letterSpacing = '0px';
    context.fillStyle = ink; context.font = `500 12px ${family}`; context.fillText(element.dataset.groupName || 'Group', 0, 249, 166);
    context.fillStyle = muted; context.font = `10px ${family}`; context.textAlign = 'right'; context.fillText(`${element.dataset.groupCount || 0} items`, 216, 249); context.textAlign = 'left';
    if (exterior) {
      const blurred = document.createElement('canvas'); blurred.width = image.width; blurred.height = image.height;
      const output = blurred.getContext('2d')!; output.filter = `blur(${blur * 2}px)`; output.globalAlpha = opacity; output.drawImage(image, 0, 0);
      primitives.push({ kind: 'texture', bounds: { x: x - 6 * artScale, y: y - 6 * artScale, width: 228 * artScale, height: 273 * artScale }, texture: new SceneContentFrame(document, { pixels: blurred, bitmap: { width: blurred.width, height: blurred.height } }) });
    } else primitives.push({ kind: 'texture', bounds: { x: x - 6 * artScale, y: y - 6 * artScale, width: 228 * artScale, height: 273 * artScale }, texture: new SceneContentFrame(document, { pixels: image, bitmap: { width: image.width, height: image.height } }) });
  }
  return primitives;
}
