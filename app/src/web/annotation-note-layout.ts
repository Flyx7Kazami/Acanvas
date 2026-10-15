import { intersects, type Point, type Rect } from './geometry';

/** Painted bottom-left of the speech bubble inside a square pin. The tail tip is that corner. */
export function annotationBubbleTail(size: number) {
  return { x: 4 * size / 24, y: 21 * size / 24 };
}

/** World anchors of the numbered pins: a point pin's tail sits on its point; rect pins sit above the mark's corner and stack per corner. */
export function annotationPinCenters(marks: { bounds: Rect; geometry?: 'point' | 'rect' }[], zoom: number): Point[] {
  return marks.map((mark, index) => {
    if (mark.geometry === 'point') return { x: mark.bounds.x, y: mark.bounds.y };
    const preceding = marks.slice(0, index).filter(value => value.geometry !== 'point' && value.bounds.x === mark.bounds.x && value.bounds.y === mark.bounds.y).length;
    return { x: mark.bounds.x + 14 / zoom, y: mark.bounds.y - (22 + preceding * 36) / zoom };
  });
}

/** Places a comment beside a point bubble, vertically centered with the icon when the comment is the same height. */
export function placePointAnnotationNote(anchor: Point, size: { width: number; height: number }, viewport: Rect, obstacles: Rect[]): Rect {
  const gap = 8;
  const minX = viewport.x, maxX = Math.max(minX, viewport.x + viewport.width - size.width);
  const minY = viewport.y, maxY = Math.max(minY, viewport.y + viewport.height - size.height);
  const clampX = (x: number) => Math.max(minX, Math.min(maxX, x));
  const clampY = (y: number) => Math.max(minY, Math.min(maxY, y));
  const tail = annotationBubbleTail(28);
  const marker = { x: anchor.x - tail.x, y: anchor.y - tail.y, width: 28, height: 28 };
  const alignedY = size.height <= marker.height ? marker.y + (marker.height - size.height) / 2 : marker.y;
  const beside = marker.x + marker.width + gap;
  const opposite = marker.x - size.width - gap;
  const xs = [beside, opposite, anchor.x - size.width / 2, minX, maxX, ...obstacles.flatMap(rect => [rect.x + rect.width + 8, rect.x - size.width - 8])].map(clampX);
  const ys = [alignedY, marker.y, anchor.y + 22, anchor.y - size.height - 22, minY, maxY, ...obstacles.flatMap(rect => [rect.y + rect.height + 8, rect.y - size.height - 8])].map(clampY);
  const candidates = ys.flatMap(y => xs.map(x => ({ x, y, ...size })));
  const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const clear = candidates.filter(rect => !intersects(rect, marker) && obstacles.every(obstacle => !intersects(rect, obstacle)));
  const available = clear.length ? clear : candidates.filter(rect => !intersects(rect, marker));
  const choices = available.length ? available : candidates;
  const score = (rect: Rect) => obstacles.reduce((sum, obstacle) => sum + overlap(rect, obstacle), 0) * 100 + overlap(rect, marker) * 1000 + Math.abs(rect.x - beside) + Math.abs(rect.y - alignedY) * 8;
  choices.sort((a, b) => score(a) - score(b));
  return choices[0];
}
