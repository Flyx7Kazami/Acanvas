import { drawScene, type SceneInput, type SceneSize } from '../../../src/web/scene-renderer/index.js';

onmessage = (event: MessageEvent<{ scene: SceneInput; bitmap: SceneSize }>) => {
  const { scene, bitmap } = event.data;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
  if (!context) throw new Error('Worker Canvas 2D is unavailable.');
  const presentation = drawScene(context, scene, bitmap), pixels = canvas.transferToImageBitmap();
  postMessage({ pixels, presentation }, { transfer: [pixels] });
};
