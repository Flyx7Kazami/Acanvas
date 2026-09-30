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
