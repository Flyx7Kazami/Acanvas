import { boundsToCSS, immutableCopy, requireSize } from './geometry.js';
import type { Immutable, SceneInput, ScenePresentation, ScenePrimitive, SceneSize } from './types.js';

type SceneContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function drawPrimitive(context: SceneContext, primitive: ScenePrimitive): void {
  if (primitive.kind === 'rect') {
    context.save();
    if (primitive.shadow) { const transform = context.getTransform(), scale = Math.max(Math.abs(transform.a), Math.abs(transform.d)); context.shadowColor = primitive.shadow.color; context.shadowBlur = primitive.shadow.blur * scale; context.shadowOffsetY = primitive.shadow.y * scale; }
    const { x, y, width, height } = primitive.bounds;
    context.beginPath(); context.roundRect(x, y, width, height, primitive.radius ?? 0);
    context.fillStyle = primitive.fill; context.fill();
    if (primitive.stroke) { context.strokeStyle = primitive.stroke; context.lineWidth = primitive.lineWidth ?? 1; if (primitive.dash) context.setLineDash(primitive.dash); context.stroke(); }
    context.restore();
  } else if (primitive.kind === 'ellipse') {
    const { x, y, width, height } = primitive.bounds;
    context.save(); context.beginPath(); context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, 2 * Math.PI);
    context.fillStyle = primitive.fill; context.fill();
    if (primitive.stroke) { context.strokeStyle = primitive.stroke; context.lineWidth = primitive.lineWidth ?? 1; if (primitive.dash) context.setLineDash(primitive.dash); context.stroke(); }
    context.restore();
  } else if (primitive.kind === 'line') {
    context.beginPath(); primitive.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
    context.strokeStyle = primitive.stroke; context.lineWidth = primitive.lineWidth; context.stroke();
  } else if (primitive.kind === 'text') {
    context.font = primitive.font; context.fillStyle = primitive.fill; context.textBaseline = 'alphabetic';
    let text = primitive.text;
    if (primitive.ellipsis && primitive.maxWidth !== undefined && context.measureText(text).width > primitive.maxWidth) {
      const characters = Array.from(text); while (characters.length && context.measureText(characters.join('') + '…').width > primitive.maxWidth) characters.pop(); text = characters.join('') + '…';
    }
    if (primitive.maxWidth === undefined || primitive.ellipsis) context.fillText(text, primitive.x, primitive.y);
    else context.fillText(text, primitive.x, primitive.y, primitive.maxWidth);
  } else if (primitive.kind === 'texture') {
    context.save();
    if (primitive.radius) { const { x, y, width, height } = primitive.bounds; context.beginPath(); context.roundRect(x, y, width, height, primitive.radius); context.clip(); }
    primitive.texture.draw(context, primitive.bounds);
    context.restore();
  } else {
    const { x, y, width, height } = primitive.bounds, source = primitive.sourceBounds;
    if (source) context.drawImage(primitive.source, source.x, source.y, source.width, source.height, x, y, width, height);
    else context.drawImage(primitive.source, x, y, width, height);
  }
}

/** Drawing and metadata generation share the same camera, order, clipping, and bitmap dimensions. */
export function drawScene(context: SceneContext, input: SceneInput, bitmap: SceneSize): Immutable<ScenePresentation> {
  requireSize(input.cssViewport); requireSize(bitmap, true);
  if (![input.cssViewport.x, input.cssViewport.y, input.camera.x, input.camera.y, input.camera.zoom].every(Number.isFinite) || input.camera.zoom <= 0 || !Number.isSafeInteger(input.frameSeq) || input.frameSeq < 1) {
    throw new RangeError('Scene camera and frame sequence must be valid.');
  }
  const scaleX = bitmap.width / input.cssViewport.width, scaleY = bitmap.height / input.cssViewport.height;
  context.save(); context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, bitmap.width, bitmap.height); context.fillStyle = input.background; context.fillRect(0, 0, bitmap.width, bitmap.height);
  context.setTransform(scaleX * input.camera.zoom, 0, 0, scaleY * input.camera.zoom, scaleX * input.camera.x, scaleY * input.camera.y);
  const layers = [...input.layers].sort((left, right) => left.layer - right.layer);
  for (const layer of layers) {
    context.save();
    if (layer.clip) { const { x, y, width, height } = layer.clip; context.beginPath(); context.rect(x, y, width, height); context.clip(); }
    for (const primitive of layer.primitives) drawPrimitive(context, primitive);
    context.restore();
  }
  for (const primitive of input.overlays ?? []) drawPrimitive(context, primitive);
  context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  for (const mark of input.marks) {
    const x = mark.x * input.camera.zoom + input.camera.x, y = mark.y * input.camera.zoom + input.camera.y;
    if (mark.style === 'bubble') {
      const size = mark.size ?? 28, originX = mark.anchor === 'tail' ? 4 * size / 24 : size / 2, originY = mark.anchor === 'tail' ? 21 * size / 24 : size / 2; context.save(); context.translate(x - originX, y - originY); context.scale(size / 24, size / 24);
      const shape = new Path2D('M7 3h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4H9l-5 3V7a4 4 0 0 1 3-4Z');
      context.fillStyle = mark.fill; context.strokeStyle = mark.stroke ?? mark.fill; context.lineWidth = 1.5; context.lineJoin = 'round'; context.fill(shape); context.stroke(shape);
      context.fillStyle = mark.textFill; context.font = '500 10px "Google Sans",sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(String(mark.number), 12.5, 11); context.restore();
      if (mark.focused) { const scale = size / 28, gap = 5 * scale; context.strokeStyle = mark.focusColor ?? '#202020'; context.lineWidth = 2 * scale; context.strokeRect(x - originX - gap, y - originY - gap, size + gap * 2, size + gap * 2); }
      continue;
    }
    context.beginPath(); context.arc(x, y, 11, 0, 2 * Math.PI); context.fillStyle = mark.fill; context.fill();
    context.fillStyle = mark.textFill; context.font = 'bold 12px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(String(mark.number), x, y);
  }
  context.restore();
  return immutableCopy({
    documentId: input.documentId, viewId: input.viewId, frameSeq: input.frameSeq, baseSceneId: input.baseSceneId,
    camera: input.camera, cssViewport: input.cssViewport, bitmap,
    layers: layers.map(layer => ({ objectId: layer.objectId, assetId: layer.assetId, objectVersion: layer.objectVersion, worldBounds: layer.worldBounds,
      contentWorldBounds: layer.contentWorldBounds, renderedBounds: boundsToCSS(layer.worldBounds, input.camera, input.cssViewport), clipCSS: layer.clip ? boundsToCSS(layer.clip, input.camera, input.cssViewport) : undefined, layer: layer.layer, surface: layer.surface, contentAnchor: layer.contentAnchor })),
    media: input.media,
  });
}
