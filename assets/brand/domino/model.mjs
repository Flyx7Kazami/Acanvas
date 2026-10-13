import * as k from './vendor/anatomy/iso-kit.mjs';

export const DOMINO_CADENCE = 375;
export const DOMINO_CARDS = Array.from({ length: 15 }, (_, index) => index);
export const DOMINO_DURATION = DOMINO_CADENCE * DOMINO_CARDS.length;
export const DOMINO_VIEWBOX = [72, 64];
export const DOMINO_WIDTH = 14;
export const DOMINO_HEIGHT = 30;
export const DOMINO_SPACING = 14;
export const DOMINO_SPEED = DOMINO_SPACING / DOMINO_CADENCE;
export const DOMINO_REST_ANGLE = 0;
export const DOMINO_FALL_ANGLE = 86 * Math.PI / 180;
export const DOMINO_TIMING = { fallAt: 6 * DOMINO_CADENCE };
export const DOMINO_CAMERA = { origin: [36, 44], scale: 1.15, azimuth: -35, elevation: 28 };
const startX = DOMINO_CARDS.length * DOMINO_SPACING / 2;
export const DOMINO_PATH = k.pathOf(k.roundedPlan({ x: -DOMINO_WIDTH / 2, y: 0, w: DOMINO_WIDTH, d: DOMINO_HEIGHT, r: 2.3 }, 16), true);

export function dominoAngleAtAge(age) {
  if (age <= 0) return DOMINO_REST_ANGLE;
  const turns = age / DOMINO_CADENCE;
  const complete = Math.floor(turns);
  const ratio = DOMINO_SPACING / DOMINO_HEIGHT;
  let angle = (turns - complete) * Math.asin(ratio);
  for (let step = 0; step < complete; step++) angle += Math.asin(ratio * Math.cos(angle));
  return Math.min(DOMINO_FALL_ANGLE, angle);
}

// A slot owns one stationary world hinge until it is fully behind the camera.
// Its next hinge is one row length ahead, outside the opposite viewport edge.
export function dominoState(index, milliseconds) {
  const phaseTime = milliseconds + index * DOMINO_CADENCE;
  const generation = Math.floor(phaseTime / DOMINO_DURATION);
  const phase = phaseTime - generation * DOMINO_DURATION;
  const worldHingeX = startX - index * DOMINO_SPACING + generation * DOMINO_CARDS.length * DOMINO_SPACING;
  const cameraX = milliseconds * DOMINO_SPEED;
  return { generation, phase, worldHingeX, cameraX, relativeX: worldHingeX - cameraX, angle: dominoAngleAtAge(phase - DOMINO_TIMING.fallAt) };
}

// u runs across the face; v runs from its fixed bottom hinge to the top.
export function dominoPoint(relativeX, u, v, angle) {
  return [relativeX + v * Math.sin(angle), -u, v * Math.cos(angle)];
}
export const dominoProject = point => k.iso(point, DOMINO_CAMERA);
function matrixAt(relativeX, angle) {
  const origin = k.iso(dominoPoint(relativeX, 0, 0, angle), DOMINO_CAMERA);
  const u = k.iso(dominoPoint(relativeX, 1, 0, angle), DOMINO_CAMERA);
  const v = k.iso(dominoPoint(relativeX, 0, 1, angle), DOMINO_CAMERA);
  return [u[0] - origin[0], u[1] - origin[1], v[0] - origin[0], v[1] - origin[1], ...origin];
}
export function dominoMatrix(index, milliseconds) {
  const state = dominoState(index, milliseconds);
  return matrixAt(state.relativeX, state.angle);
}
function cycleMatrix(phase) {
  return matrixAt(startX - phase * DOMINO_SPEED, dominoAngleAtAge(phase - DOMINO_TIMING.fallAt));
}
const number = value => Number(value.toFixed(5));
export const dominoTransform = (index, milliseconds) => `matrix(${dominoMatrix(index, milliseconds).map(number).join(',')})`;

export function dominoCss() {
  const times = Array.from({ length: DOMINO_CARDS.length * 24 + 1 }, (_, step) => step * DOMINO_CADENCE / 24);
  const properties = ['x', 'y', 'tx', 'ty'];
  const registrations = properties.map(name => `@property --acanvas-domino-${name}{syntax:"<number>";inherits:false;initial-value:0}`).join('');
  const coefficients = matrix => `--acanvas-domino-x:${number(matrix[2])};--acanvas-domino-y:${number(matrix[3])};--acanvas-domino-tx:${number(matrix[4])};--acanvas-domino-ty:${number(matrix[5])}`;
  // Face centers set the painter order for the selected camera.
  const depthKey = phase => Math.round(10000 + 100 * k.depthOf(dominoPoint(startX - phase * DOMINO_SPEED, 0, DOMINO_HEIGHT / 2, dominoAngleAtAge(phase - DOMINO_TIMING.fallAt)), DOMINO_CAMERA));
  const [a, b] = cycleMatrix(0).map(number);
  const palette = '.domino-loader{--domino-gray-0:#747474;--domino-gray-1:#a0a0a0;--domino-gray-2:#c5c5c5}@media(prefers-color-scheme:dark){.domino-loader{--domino-gray-0:#777;--domino-gray-1:#a3a3a3;--domino-gray-2:#d2d2d2}}:root[data-theme="light"] .domino-loader{--domino-gray-0:#747474;--domino-gray-1:#a0a0a0;--domino-gray-2:#c5c5c5}:root[data-theme="dark"] .domino-loader{--domino-gray-0:#777;--domino-gray-1:#a3a3a3;--domino-gray-2:#d2d2d2}';
  return registrations + palette + `\n.domino-loader{display:block;flex-shrink:0;overflow:hidden;stroke:none}.domino-stage{position:relative;width:100%;height:100%;overflow:hidden;isolation:isolate}.domino-layer{position:absolute;left:0;top:0;width:1px;height:1px;transform-origin:0 0;transform:matrix(${a},${b},var(--acanvas-domino-x),var(--acanvas-domino-y),var(--acanvas-domino-tx),var(--acanvas-domino-ty));animation:acanvas-domino-travel ${DOMINO_DURATION}ms linear infinite}.domino-layer svg{display:block;overflow:visible}.domino-layer path{stroke:none;fill:var(--domino-tone)}\n` + DOMINO_CARDS.map(index => `.domino-loader .domino-card-${index}{${coefficients(dominoMatrix(index, 0))};--domino-tone:var(--domino-gray-${index % 3});z-index:${depthKey(index * DOMINO_CADENCE)};animation-delay:-${index * DOMINO_CADENCE}ms}`).join('\n') + `\n@keyframes acanvas-domino-travel{${times.map(time => `${number(time / DOMINO_DURATION * 100)}%{${coefficients(cycleMatrix(time))};z-index:${depthKey(time)}}`).join('')}}\n@media(prefers-reduced-motion:reduce){.domino-layer{animation:none}}`;
}
