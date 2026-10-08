import { intersects, type Point, type Rect } from './geometry';

/** Places a comment beside a screen point while keeping its marker independent. */
export function placePointAnnotationNote(anchor: Point, size: { width: number; height: number }, viewport: Rect, obstacles: Rect[]): Rect {
  const gap = 22;
  const minX = viewport.x, maxX = Math.max(minX, viewport.x + viewport.width - size.width);
  const minY = viewport.y, maxY = Math.max(minY, viewport.y + viewport.height - size.height);
  const clampX = (x: number) => Math.max(minX, Math.min(maxX, x));
  const clampY = (y: number) => Math.max(minY, Math.min(maxY, y));
  const xs = [anchor.x + gap, anchor.x - size.width - gap, anchor.x - size.width / 2, minX, maxX, ...obstacles.flatMap(rect => [rect.x + rect.width + 8, rect.x - size.width - 8])].map(clampX);
  const ys = [anchor.y - 14, anchor.y + gap, anchor.y - size.height - gap, minY, maxY, ...obstacles.flatMap(rect => [rect.y + rect.height + 8, rect.y - size.height - 8])].map(clampY);
  const marker = { x: anchor.x - 14, y: anchor.y - 14, width: 28, height: 28 };
  const candidates = ys.flatMap(y => xs.map(x => ({ x, y, ...size })));
  const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const clear = candidates.filter(rect => !intersects(rect, marker) && obstacles.every(obstacle => !intersects(rect, obstacle)));
  const available = clear.length ? clear : candidates.filter(rect => !intersects(rect, marker));
  const choices = available.length ? available : candidates;
  const score = (rect: Rect) => obstacles.reduce((sum, obstacle) => sum + overlap(rect, obstacle), 0) * 100 + overlap(rect, marker) * 1000 + Math.abs(rect.x - (anchor.x + gap)) + Math.abs(rect.y - (anchor.y - 14));
  choices.sort((a, b) => score(a) - score(b));
  return choices[0];
}
