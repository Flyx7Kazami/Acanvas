import * as k from './vendor/anatomy/iso-kit.mjs';

export const DOMINO_DURATION = 8600;
export const DOMINO_VIEWBOX = [760, 540];
export const DOMINO_CAMERA = { origin: [380, 270], scale: 1.18, azimuth: 45, elevation: 65 };
export const DOMINO_CARDS = [
  { name: 'Sage', color: '#8db779', corner: [204, 101], across: [142, -43], down: [17, 242], z: 0, shift: [-27, -9], lean: 0.11 },
  { name: 'Blush', color: '#ff9db6', corner: [268, 156], across: [136, -38], down: [63, 244], z: 24, shift: [0, -5], lean: 0.14 },
  { name: 'Stone', color: '#a5a5a3', corner: [333, 214], across: [132, -36], down: [89, 254], z: 48, shift: [28, 11], lean: 0.17 },
];

const dominoClamp = (v) => Math.max(0, Math.min(1, v));
const dominoEase = (v) => { const t = dominoClamp(v); return t * t * t * (t * (t * 6 - 15) + 10); };

// All geometry lives on parallel planes in Anatomy's camera. The calibrated
// outlines retain the selected image's progressively leaning card silhouettes.
function dominoWorld([sx, sy], z) {
  const { origin } = DOMINO_CAMERA;
  const { sinA, cosA, sinE, cosE, k: scale } = k.cameraOf(DOMINO_CAMERA);
  const a = (sx - origin[0]) / scale;
  const b = ((sy - origin[1]) / scale + z * cosE) / sinE;
  return [sinA * a + cosA * b, -cosA * a + sinA * b];
}

const dominoOutline = k.roundedPlan({ x: 0, y: 0, w: 140, d: 250, r: 21 }, 18);
const dominoRest = DOMINO_CARDS.map((card) => {
  const onFace = ([x, y]) => dominoWorld([
    380 + (card.corner[0] + card.across[0] * x / 140 + card.down[0] * y / 250 - 380) * DOMINO_CAMERA.scale,
    270 + (card.corner[1] + card.across[1] * x / 140 + card.down[1] * y / 250 - 270) * DOMINO_CAMERA.scale,
  ], card.z + 3.2);
  return { ring: dominoOutline.map(onFace), pivot: onFace([70, 250]) };
});

export function dominoAt(milliseconds) {
  const t = Math.max(0, Math.min(DOMINO_DURATION, milliseconds));
  const shares = DOMINO_CARDS.map((_, i) => {
    const opened = dominoEase((t - 1200 - i * 260) / 1700);
    const closed = dominoEase((t - 4400 - i * 220) / 1700);
    return opened * (1 - closed);
  });
  const phase = t < 1200 || t >= 6540 ? 'Together' : t < 3420 ? 'Unfolding' : t < 4400 ? 'A little momentum' : 'Coming together';
  return { time: t, phase, shares };
}

export function dominoGeometry(index, share) {
  const card = DOMINO_CARDS[index];
  const { ring, pivot } = dominoRest[index];
  const angle = card.lean * share;
  const c = Math.cos(angle), s = Math.sin(angle);
  const shiftTo = dominoWorld([380 + card.shift[0] * share, 270 + card.shift[1] * share], 0);
  const shiftFrom = dominoWorld([380, 270], 0);
  const rotated = ring.map(([x, y]) => [
    pivot[0] + (x - pivot[0]) * c - (y - pivot[1]) * s + shiftTo[0] - shiftFrom[0],
    pivot[1] + (x - pivot[0]) * s + (y - pivot[1]) * c + shiftTo[1] - shiftFrom[1],
  ]);
  return k.extrude(rotated, card.z, 3.2, DOMINO_CAMERA);
}

export function dominoCardSvg(index, share = 0) {
  return `<g data-card="${index}" style="--card-color:${DOMINO_CARDS[index].color}">${k.solidSvg(dominoGeometry(index, share), { crease: 'none' })}</g>`;
}
