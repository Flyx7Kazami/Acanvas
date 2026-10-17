export interface GroupPose { x: number; y: number; width: number; height: number; dx: number; dy: number; scale: number; opacity: number; blur: number }
type Motion = { node: HTMLElement; target: GroupPose; arriving: boolean; animation?: Animation };
const fields = ['x', 'y', 'width', 'height', 'dx', 'dy', 'scale', 'opacity', 'blur'] as const;
const equal = (a: GroupPose, b: GroupPose) => fields.every(key => a[key] === b[key]);
const transform = (pose: GroupPose) => `translate(${pose.x + pose.dx}px,${pose.y + pose.dy}px) scale(${pose.scale})`;
const filter = (pose: GroupPose) => pose.blur ? `blur(${pose.blur}px)` : 'none';
export const presentedItemElement = (element: HTMLElement) => element.closest<HTMLElement>('[data-group-presentation]') || element;

/** Motion belongs to a placement layer; the item keeps its content styles and native controls. */
export class GroupPresentation {
  private items = new Map<HTMLElement, Motion>();
  private reduced = false;
  readonly exterior = { blur: 12, opacity: .22 };
  connect() {
    const style = getComputedStyle(document.documentElement);
    this.exterior.blur = Number.parseFloat(style.getPropertyValue('--group-exterior-blur'));
    this.exterior.opacity = Number(style.getPropertyValue('--group-exterior-opacity'));
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => { this.reduced = query.matches; if (this.reduced) this.interrupt(new Set()); };
    change(); query.addEventListener('change', change);
    return () => { query.removeEventListener('change', change); this.dispose(); };
  }
  private read(motion: Motion): GroupPose {
    if (!motion.animation) return motion.target;
    const style = getComputedStyle(motion.node), matrix = new DOMMatrix(style.transform);
    return { ...motion.target, x: matrix.e, y: matrix.f, dx: 0, dy: 0, scale: matrix.a, opacity: Number(style.opacity), blur: Number(/blur\(([^p]+)px\)/.exec(style.filter)?.[1] || 0) };
  }
  private settle(node: HTMLElement, pose: GroupPose) {
    Object.assign(node.style, { left: `${pose.x + pose.dx}px`, top: `${pose.y + pose.dy}px`, width: `${pose.width}px`, height: `${pose.height}px`, transform: pose.scale === 1 ? '' : `scale(${pose.scale})`, transformOrigin: '0 0', opacity: String(pose.opacity), filter: filter(pose) });
  }
  update(node: HTMLElement, target: GroupPose, layout: boolean, arriving = false, moving = false) {
    const animate = !this.reduced && !moving;
    layout = layout && animate;
    const previous = this.items.get(node);
    const arrival = arriving && !previous?.arriving;
    if (previous && equal(previous.target, target) && !arrival) {
      previous.arriving = arriving;
      if (!animate && previous.animation) { previous.animation.cancel(); previous.animation = undefined; this.settle(node, target); }
      return;
    }
    let from = previous ? this.read(previous) : target;
    if (!layout) from = { ...target, opacity: from.opacity, blur: from.blur };
    if (arrival && layout) from = { ...target, dx: target.dx + target.width * .02, dy: target.dy + 12 + target.height * .02, scale: target.scale * .96, opacity: 0 };
    previous?.animation?.cancel();
    const motion: Motion = { node, target, arriving }; this.items.set(node, motion);
    if (!animate || equal(from, target)) { this.settle(node, target); return; }
    const start: Keyframe = {}, end: Keyframe = {};
    if (transform(from) !== transform(target)) { start.transform = transform(from); end.transform = transform(target); }
    if (from.opacity !== target.opacity) { start.opacity = from.opacity; end.opacity = target.opacity; }
    if (from.blur !== target.blur) { start.filter = filter(from); end.filter = filter(target); }
    if (!Object.keys(start).length) { this.settle(node, target); return; }
    Object.assign(node.style, { left: '0px', top: '0px', width: `${target.width}px`, height: `${target.height}px`, transform: transform(target), transformOrigin: '0 0', opacity: String(target.opacity), filter: filter(target) });
    const animation = node.animate([start, end], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
    motion.animation = animation;
    animation.onfinish = () => { if (this.items.get(node) === motion && motion.animation === animation) { motion.animation = undefined; this.settle(node, target); } };
  }
  interrupt(owned: Set<HTMLElement>) {
    for (const motion of this.items.values()) {
      if (!motion.animation) continue;
      const pose = owned.has(motion.node) ? this.read(motion) : motion.target;
      motion.animation.cancel(); motion.animation = undefined;
      this.settle(motion.node, pose);
      motion.target = pose;
    }
  }
  forget(node: HTMLElement) { this.items.get(node)?.animation?.cancel(); this.items.delete(node); }
  dispose() { for (const motion of this.items.values()) motion.animation?.cancel(); this.items.clear(); }
}
