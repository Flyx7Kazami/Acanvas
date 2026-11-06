import { intersects, type Point, type Rect } from './geometry.js';

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
  // Each axis keeps its first occurrence so ties retain the document's placement order.
  const axis = (values: number[], origin: number, weight: number) => [...new Set(values)].map((value, order) => ({ value, order, distance: Math.abs(value - origin) * weight })).sort((a, b) => a.distance - b.distance || a.order - b.order);
  const columns = axis(xs, beside, 1), rows = axis(ys, alignedY, 8);
  const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  type Choice = { rect: Rect; score: number; order: number };
  let clear: Choice | undefined, available: Choice | undefined, fallback: Choice | undefined;
  const better = (candidate: Choice, best: Choice | undefined) => !best || candidate.score < best.score || candidate.score === best.score && candidate.order < best.order;
  for (const row of rows) {
    if (clear && row.distance > clear.score) break;
    for (const column of columns) {
      const distance = column.distance + row.distance;
      // Overlap penalties are positive, so farther coordinates cannot improve a clear placement.
      if (clear && distance > clear.score) break;
      const rect = { x: column.value, y: row.value, ...size }, order = row.order * xs.length + column.order;
      const touchesMarker = intersects(rect, marker);
      let touchesObstacle = false, covered = 0;
      for (const obstacle of obstacles) {
        if (intersects(rect, obstacle)) touchesObstacle = true;
        if (!clear) covered += overlap(rect, obstacle);
        else if (touchesObstacle) break;
      }
      if (!touchesMarker && !touchesObstacle) {
        const candidate = { rect, score: distance, order };
        if (better(candidate, clear)) clear = candidate;
      } else if (!clear) {
        const candidate = { rect, score: covered * 100 + overlap(rect, marker) * 1000 + column.distance + row.distance, order };
        if (better(candidate, fallback)) fallback = candidate;
        if (!touchesMarker && better(candidate, available)) available = candidate;
      }
    }
  }
  return (clear || available || fallback)!.rect;
}
