export type Point = { x: number; y: number };
export type View = Point & { zoom: number };
export type Rect = Point & { width: number; height: number };

export function screenToWorld(point: Point, view: View): Point {
  return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom };
}

export function worldToScreen(point: Point, view: View): Point {
  return { x: point.x * view.zoom + view.x, y: point.y * view.zoom + view.y };
}

export function rectangle(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

export function unionBounds(rects: Rect[]): Rect {
  const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x, height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
}

export function screenBounds(rect: Rect, view: View): Rect {
  return { ...worldToScreen(rect, view), width: rect.width * view.zoom, height: rect.height * view.zoom };
}

export type IdentifiedRect = Rect & { id: string };
export type SnapGuide = { axis: 'x' | 'y'; position: number; start: number; end: number };
export type Alignment = 'left' | 'horizontal-center' | 'right' | 'top' | 'vertical-center' | 'bottom';

export function snapTranslation(moving: IdentifiedRect[], objects: IdentifiedRect[], delta: Point, view: View, viewport: { width: number; height: number }, thresholdPixels = 6): { delta: Point; guides: SnapGuide[] } {
  if (!moving.length) return { delta, guides: [] };
  const ids = new Set(moving.map(object => object.id));
  const targets = objects.filter(object => {
    if (ids.has(object.id)) return false;
    const screen = screenBounds(object, view);
    return screen.x < viewport.width && screen.x + screen.width > 0 && screen.y < viewport.height && screen.y + screen.height > 0;
  });
  const original = unionBounds(moving), bounds = { ...original, x: original.x + delta.x, y: original.y + delta.y };
  const result = { ...delta }, matches: { axis: 'x' | 'y'; position: number; target: Rect }[] = [];
  for (const axis of ['x', 'y'] as const) {
    const size = axis === 'x' ? 'width' : 'height';
    const anchors = [bounds[axis], bounds[axis] + bounds[size] / 2, bounds[axis] + bounds[size]];
    let nearest: { adjustment: number; position: number; target: Rect } | undefined;
    for (const target of targets) for (const position of [target[axis], target[axis] + target[size] / 2, target[axis] + target[size]]) for (const anchor of anchors) {
      const adjustment = position - anchor;
      if (Math.abs(adjustment) * view.zoom <= thresholdPixels && (!nearest || Math.abs(adjustment) < Math.abs(nearest.adjustment))) nearest = { adjustment, position, target };
    }
    if (nearest) { result[axis] += nearest.adjustment; matches.push({ axis, position: nearest.position, target: nearest.target }); }
  }
  const final = { ...original, x: original.x + result.x, y: original.y + result.y };
  const guides = matches.map(({ axis, position, target }) => {
    const across = axis === 'x' ? 'y' : 'x', size = axis === 'x' ? 'height' : 'width';
    return { axis, position, start: Math.min(final[across], target[across]), end: Math.max(final[across] + final[size], target[across] + target[size]) };
  });
  return { delta: result, guides };
}

export function alignedPositions(objects: IdentifiedRect[], alignment: Alignment): { id: string; x: number; y: number }[] {
  if (objects.length < 2) return [];
  const bounds = unionBounds(objects);
  const precision = Number.EPSILON * Math.max(1, Math.abs(bounds.x), Math.abs(bounds.y), bounds.width, bounds.height) * 8;
  return objects.map(object => {
    let { x, y } = object;
    if (alignment === 'left') x = bounds.x;
    if (alignment === 'horizontal-center') x = bounds.x + (bounds.width - object.width) / 2;
    if (alignment === 'right') x = bounds.x + bounds.width - object.width;
    if (alignment === 'top') y = bounds.y;
    if (alignment === 'vertical-center') y = bounds.y + (bounds.height - object.height) / 2;
    if (alignment === 'bottom') y = bounds.y + bounds.height - object.height;
    return { id: object.id, x, y };
  }).filter((position, index) => Math.abs(position.x - objects[index].x) > precision || Math.abs(position.y - objects[index].y) > precision);
}

export function placeFloatingControl(anchor: Rect, size: { width: number; height: number }, viewport: Rect, side: 'above' | 'below', obstacles: Rect[], gap = 8): Rect | null {
  const margin = 12;
  const minX = viewport.x + margin, maxX = viewport.x + viewport.width - size.width - margin;
  const minY = viewport.y + margin, maxY = viewport.y + viewport.height - size.height - margin;
  const centeredX = Math.max(minX, Math.min(maxX, anchor.x + (anchor.width - size.width) / 2));
  const above = anchor.y - size.height - gap, below = anchor.y + anchor.height + gap;
  const preferredY = side === 'above' ? above : below, alternateY = side === 'above' ? below : above;
  // Nearby horizontal and vertical clearances keep controls close to their item at window edges.
  const xs = [centeredX, ...obstacles.flatMap(rect => [rect.x + rect.width + gap, rect.x - size.width - gap])];
  const ys = [preferredY, alternateY, anchor.y + gap, anchor.y + anchor.height - size.height - gap, minY, maxY, ...obstacles.flatMap(rect => [rect.y - size.height - gap, rect.y + rect.height + gap])];
  const clear = (rect: Rect) => rect.x >= minX && rect.x <= maxX && rect.y >= minY && rect.y <= maxY && obstacles.every(obstacle => !intersects(rect, { x: obstacle.x - gap + 1, y: obstacle.y - gap + 1, width: obstacle.width + (gap - 1) * 2, height: obstacle.height + (gap - 1) * 2 }));
  const nearby = ys.flatMap(y => xs.map(x => ({ x, y, ...size }))).filter(clear);
  const outside = nearby.filter(rect => !intersects(rect, anchor));
  const candidates = outside.length ? outside : nearby;
  candidates.sort((a, b) => Math.abs(a.y - preferredY) + Math.abs(a.x - centeredX) * .5 - Math.abs(b.y - preferredY) - Math.abs(b.x - centeredX) * .5);
  return candidates[0] || null;
}

export function normalizedRegion(region: Rect, object: Rect): Rect {
  const x = Math.max(0, Math.min(1, (region.x - object.x) / object.width));
  const y = Math.max(0, Math.min(1, (region.y - object.y) / object.height));
  const right = Math.max(x, Math.min(1, (region.x + region.width - object.x) / object.width));
  const bottom = Math.max(y, Math.min(1, (region.y + region.height - object.y) / object.height));
  return { x, y, width: right - x, height: bottom - y };
}

export function objectRegion(region: Rect, object: Rect): Rect {
  return { x: object.x + region.x * object.width, y: object.y + region.y * object.height, width: region.width * object.width, height: region.height * object.height };
}

export function mediaContentRect(object: Rect, natural?: { width: number; height: number }): Rect {
  if (!natural?.width || !natural.height) return object;
  const scale = Math.min(object.width / natural.width, object.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return { x: object.x + (object.width - width) / 2, y: object.y + (object.height - height) / 2, width, height };
}

export function zoomAt(view: View, factor: number, anchor: Point): View {
  const world = screenToWorld(anchor, view);
  const zoom = Math.min(4, Math.max(0.15, view.zoom * factor));
  return { x: anchor.x - world.x * zoom, y: anchor.y - world.y * zoom, zoom };
}

export function fitView(objects: Rect[], size: { width: number; height: number }): View {
  if (!objects.length) return { x: 0, y: 0, zoom: 1 };
  const left = Math.min(...objects.map(object => object.x));
  const top = Math.min(...objects.map(object => object.y));
  const right = Math.max(...objects.map(object => object.x + object.width));
  const bottom = Math.max(...objects.map(object => object.y + object.height));
  const zoom = Math.min(1.5, Math.max(0.15, Math.min((size.width - 100) / (right - left), (size.height - 130) / (bottom - top))));
  return { x: (size.width - (right - left) * zoom) / 2 - left * zoom, y: (size.height - (bottom - top) * zoom) / 2 - top * zoom, zoom };
}
