import type { Bounds, ContentAnchor, HtmlSurfaceReference, PresentedMedia, ScenePresentation } from '../../shared/types.js';
export type { PresentedMedia, RenderedLayer, ScenePresentation } from '../../shared/types.js';

export interface SceneSize { width: number; height: number }
export type SceneBounds = Bounds;
export type SceneCamera = ScenePresentation['camera'];
export type SceneSurfaceFrame = HtmlSurfaceReference;
export interface SceneTextureDrawable {
  draw(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, bounds: SceneBounds): void;
}

export type ScenePrimitive =
  | { kind: 'rect'; bounds: SceneBounds; fill: string; radius?: number; stroke?: string; lineWidth?: number; dash?: number[]; shadow?: { color: string; y: number; blur: number } }
  | { kind: 'ellipse'; bounds: SceneBounds; fill: string; stroke?: string; lineWidth?: number; dash?: number[] }
  | { kind: 'line'; points: { x: number; y: number }[]; stroke: string; lineWidth: number }
  | { kind: 'text'; x: number; y: number; text: string; font: string; fill: string; maxWidth?: number; ellipsis?: boolean }
  | { kind: 'texture'; bounds: SceneBounds; texture: SceneTextureDrawable; radius?: number }
  | { kind: 'image'; bounds: SceneBounds; source: CanvasImageSource; sourceBounds?: SceneBounds };

export interface SceneLayer {
  objectId: string;
  assetId?: string;
  objectVersion: number;
  worldBounds: SceneBounds;
  contentWorldBounds?: SceneBounds;
  clip?: SceneBounds;
  layer: number;
  surface?: SceneSurfaceFrame;
  contentAnchor?: ContentAnchor;
  primitives: ScenePrimitive[];
}
export interface SceneMark { x: number; y: number; number: number; fill: string; textFill: string; style?: 'bubble'; size?: number; stroke?: string; focused?: boolean; focusColor?: string }
export interface SceneInput {
  documentId: string;
  viewId: string;
  frameSeq: number;
  baseSceneId: string;
  camera: SceneCamera;
  cssViewport: SceneBounds;
  background: string;
  layers: SceneLayer[];
  media: PresentedMedia[];
  marks: SceneMark[];
  overlays?: ScenePrimitive[];
}

export interface SceneCrop {
  requestedCSS: SceneBounds;
  cropCSS: SceneBounds;
  sourcePixels: SceneBounds;
  bitmap: SceneSize;
  scaleX: number;
  scaleY: number;
}

export type Immutable<T> = T extends (...args: never[]) => unknown ? T
  : T extends Array<infer Item> ? readonly Immutable<Item>[]
  : T extends object ? { readonly [Key in keyof T]: Immutable<T[Key]> }
  : T;
