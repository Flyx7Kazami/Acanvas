import * as k from './vendor/anatomy/iso-kit.mjs';

export const DOMINO_DURATION = 2000;
export const DOMINO_VIEWBOX = [72, 64];
export const DOMINO_CARDS = [0, 1, 2];
export const DOMINO_WIDTH = 14;
export const DOMINO_HEIGHT = 30;
export const DOMINO_SPACING = 14.2;
export const DOMINO_REST_ANGLE = -8 * Math.PI / 180;
export const DOMINO_FALL_ANGLE = 86 * Math.PI / 180;
export const DOMINO_TIMING = { fallAt: 140, fallStagger: 135, fallDuration: 370, resetAt: 990, resetStagger: 90, resetDuration: 480 };
const ease = (value) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

export function dominoAngle(index, milliseconds) {
  const t = Math.max(0, Math.min(DOMINO_DURATION, milliseconds));
  const fall = ease((t - DOMINO_TIMING.fallAt - index * DOMINO_TIMING.fallStagger) / DOMINO_TIMING.fallDuration);
  const reset = ease((t - DOMINO_TIMING.resetAt - index * DOMINO_TIMING.resetStagger) / DOMINO_TIMING.resetDuration);
  return DOMINO_REST_ANGLE + (DOMINO_FALL_ANGLE - DOMINO_REST_ANGLE) * fall * (1 - reset);
}

// u runs across the card, v runs from the bottom hinge to its top.
// Rotation is around that bottom edge in world space before projection.
export function dominoPoint(index, u, v, angle) {
  return [index * DOMINO_SPACING + v * Math.sin(angle), -u, v * Math.cos(angle)];
}
const extremes = DOMINO_CARDS.flatMap(index => Array.from({ length: 95 }, (_, step) => {
  const angle = DOMINO_REST_ANGLE + (DOMINO_FALL_ANGLE - DOMINO_REST_ANGLE) * step / 94;
  return [-DOMINO_WIDTH / 2, DOMINO_WIDTH / 2].flatMap(u => [0, DOMINO_HEIGHT].map(v => dominoPoint(index, u, v, angle)));
}).flat());
export const DOMINO_CAMERA = k.fitProjection(extremes, ...DOMINO_VIEWBOX, { pad: 5.5, azimuth: 35, elevation: 28 });
export const DOMINO_PATH = k.pathOf(k.roundedPlan({ x: -DOMINO_WIDTH / 2, y: 0, w: DOMINO_WIDTH, d: DOMINO_HEIGHT, r: 2.3 }, 16), true);

export function dominoMatrix(index, milliseconds) {
  const angle = dominoAngle(index, milliseconds);
  const origin = k.iso(dominoPoint(index, 0, 0, angle), DOMINO_CAMERA);
  const u = k.iso(dominoPoint(index, 1, 0, angle), DOMINO_CAMERA);
  const v = k.iso(dominoPoint(index, 0, 1, angle), DOMINO_CAMERA);
  return [u[0] - origin[0], u[1] - origin[1], v[0] - origin[0], v[1] - origin[1], ...origin];
}
export const dominoTransform = (index, milliseconds) => `matrix(${dominoMatrix(index, milliseconds).map(value => Number(value.toFixed(5))).join(',')})`;

export function dominoCss() {
  const steps = new Set(Array.from({ length: 81 }, (_, step) => step * DOMINO_DURATION / 80));
  DOMINO_CARDS.forEach(index => {
    for (const time of [DOMINO_TIMING.fallAt + index * DOMINO_TIMING.fallStagger, DOMINO_TIMING.fallAt + index * DOMINO_TIMING.fallStagger + DOMINO_TIMING.fallDuration, DOMINO_TIMING.resetAt + index * DOMINO_TIMING.resetStagger, DOMINO_TIMING.resetAt + index * DOMINO_TIMING.resetStagger + DOMINO_TIMING.resetDuration]) steps.add(time);
  });
  const times = [...steps].sort((a, b) => a - b);
  const number = value => Number(value.toFixed(5));
  return '@property --acanvas-domino-x{syntax:"<number>";inherits:false;initial-value:0}@property --acanvas-domino-y{syntax:"<number>";inherits:false;initial-value:0}\n.domino-loader{display:block;flex-shrink:0;overflow:visible;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.domino-loader path{transform-origin:0 0;animation-duration:' + DOMINO_DURATION + 'ms;animation-timing-function:linear;animation-iteration-count:infinite}\n' + DOMINO_CARDS.map(index => {
    const [a, b, c, d, e, f] = dominoMatrix(index, 0).map(number);
    return `.domino-loader .domino-card-${index}{--acanvas-domino-x:${c};--acanvas-domino-y:${d};transform:matrix(${a},${b},var(--acanvas-domino-x),var(--acanvas-domino-y),${e},${f});animation-name:acanvas-domino-${index}}\n@keyframes acanvas-domino-${index}{${times.map(time => {
      const matrix = dominoMatrix(index, time);
      return `${number(time / DOMINO_DURATION * 100)}%{--acanvas-domino-x:${number(matrix[2])};--acanvas-domino-y:${number(matrix[3])}}`;
    }).join('')}}`;
  }).join('\n') + '\n@media(prefers-reduced-motion:reduce){.domino-loader path{animation:none}}';
}
