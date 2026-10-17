import type { SessionView } from '../shared/types.js';

export interface CameraClock {
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
  delay(callback: () => void, milliseconds: number): number;
  cancelDelay(id: number): void;
}
export interface CameraFrame { view: SessionView; moving: boolean }
const browserClock: CameraClock = {
  requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
  delay: (callback, milliseconds) => window.setTimeout(callback, milliseconds), cancelDelay: id => window.clearTimeout(id),
};
export const sameCameraPose = (a: SessionView, b: SessionView) => a.x === b.x && a.y === b.y && a.zoom === b.zoom;
export type ViewContext = Pick<SessionView, 'selectedObjectIds' | 'activeGroupId' | 'parentView'>;
export const viewContext = ({ selectedObjectIds, activeGroupId, parentView }: SessionView): ViewContext => ({ selectedObjectIds, activeGroupId, parentView });
export const sameViewContext = (a: ViewContext, b: ViewContext) => a.activeGroupId === b.activeGroupId
  && a.parentView?.x === b.parentView?.x && a.parentView?.y === b.parentView?.y && a.parentView?.zoom === b.parentView?.zoom
  && a.selectedObjectIds.length === b.selectedObjectIds.length && a.selectedObjectIds.every((id, index) => id === b.selectedObjectIds[index]);

/** Inputs accumulate in one camera; presentation and screen controls advance together once per frame. */
export class CanvasCamera {
  private current: SessionView;
  private presented: CameraFrame;
  private frame = 0;
  private idle = 0;
  private moving = false;
  private pendingContext = false;
  private owner = '';
  private listeners = new Set<() => void>();
  private renderers = new Set<(frame: CameraFrame) => void>();
  constructor(initial: SessionView, private clock: CameraClock = browserClock) {
    this.current = initial; this.presented = { view: initial, moving: false };
  }
  getView = () => this.current;
  getSnapshot = () => this.presented.view;
  getFrame = () => this.presented;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribePresentation = (render: (frame: CameraFrame) => void) => { this.renderers.add(render); return () => { this.renderers.delete(render); }; };

  update(next: SessionView) {
    const moved = !sameCameraPose(this.current, next), contextChanged = !sameViewContext(this.current, next);
    if (!moved && !contextChanged) return;
    this.current = next;
    if (contextChanged) this.pendingContext = true;
    if (moved) {
      if (!this.moving) {
        this.moving = true;
        // Prepare the retained layer at its presented pose before the next camera frame.
        if (!this.pendingContext) for (const render of this.renderers) render({ view: this.presented.view, moving: true });
      }
      this.clock.cancelDelay(this.idle);
      this.idle = this.clock.delay(() => this.settle(), 140);
    }
    if (!this.frame) this.frame = this.clock.requestFrame(() => { this.frame = 0; this.flush(); });
  }

  /** Retire pending input; owned sessions present alongside their committed content. */
  reset(next: SessionView, owner = '') {
    this.stop(); this.current = next; this.moving = false; this.owner = owner; this.pendingContext = !!owner;
    if (!this.pendingContext) this.publish();
  }
  /** Context-owned content and its camera become visible in the same React commit. */
  commitContext(context: ViewContext, owner: string) {
    if (this.pendingContext && this.owner === owner && sameViewContext(context, this.current)) { this.pendingContext = false; this.flush(); }
  }
  /** Finish pose work for the currently committed context before reading its geometry. */
  flush = () => {
    if (this.frame) this.clock.cancelFrame(this.frame);
    this.frame = 0;
    if (!this.pendingContext && (this.presented.view !== this.current || this.presented.moving !== this.moving)) this.publish();
    return this.presented.view;
  };
  settle = () => {
    this.clock.cancelDelay(this.idle); this.idle = 0; this.moving = false;
    return this.flush();
  };
  private publish() {
    const previous = this.presented.view;
    this.presented = { view: this.current, moving: this.moving };
    for (const render of this.renderers) render(this.presented);
    if (previous !== this.current) for (const listener of this.listeners) listener();
  }
  private stop() { this.clock.cancelFrame(this.frame); this.clock.cancelDelay(this.idle); this.frame = 0; this.idle = 0; }
  dispose() { this.stop(); this.moving = false; this.renderers.clear(); this.listeners.clear(); }
}
