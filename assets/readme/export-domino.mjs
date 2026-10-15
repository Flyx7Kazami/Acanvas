// Export the product's current loading geometry for Markdown image support.
// Requires Node 24, ffmpeg and sharp. If sharp is provided by another runtime:
// ACANVAS_MEDIA_MODULES=/path/to/node_modules .runtime/node_modules/node/bin/node assets/readme/export-domino.mjs
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  DOMINO_CADENCE, DOMINO_CARDS, DOMINO_DURATION, DOMINO_PATH,
  DOMINO_VIEWBOX, DOMINO_HEIGHT, DOMINO_CAMERA,
  dominoState, dominoPoint, dominoTransform,
} from '../brand/domino/model.mjs';
import { depthOf } from '../brand/domino/vendor/anatomy/iso-kit.mjs';

const require = createRequire(import.meta.url);
const sharp = require(process.env.ACANVAS_MEDIA_MODULES
  ? join(resolve(process.env.ACANVAS_MEDIA_MODULES), 'sharp')
  : 'sharp');
const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, 'domino-loading.gif');
const temporary = await mkdtemp(join(tmpdir(), 'acanvas-readme-domino-'));
const size = 96;
// Preserve the card scale while centering its visible bounds beside H2 text.
// The model leaves at least 18 transparent pixels above the cards.
const headingOffsetY = 16;
const fps = 40;
const frames = Math.round(DOMINO_DURATION * fps / 1000);
// The light palette is opaque gray throughout, so it also reads on dark pages.
const palette = ['#747474', '#a0a0a0', '#c5c5c5'];

function frameSvg(milliseconds) {
  // Match the product's card-center painter order in dominoCss().
  const layers = DOMINO_CARDS.map(index => {
    const state = dominoState(index, milliseconds);
    const depth = Math.round(10000 + 100 * depthOf(
      dominoPoint(state.relativeX, 0, DOMINO_HEIGHT / 2, state.angle), DOMINO_CAMERA,
    ));
    return { index, depth };
  }).sort((a, b) => a.depth - b.depth || a.index - b.index);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" stroke="none"><svg y="${-headingOffsetY}" width="${size}" height="${size}" viewBox="0 0 ${DOMINO_VIEWBOX.join(' ')}" overflow="hidden">${layers.map(({ index }) => `<path d="${DOMINO_PATH}" transform="${dominoTransform(index, milliseconds)}" fill="${palette[index % palette.length]}"/>`).join('')}</svg></svg>`;
}

try {
  for (let frame = 0; frame < frames; frame++) {
    const milliseconds = frame * 1000 / fps;
    await sharp(Buffer.from(frameSvg(milliseconds))).png().toFile(join(temporary, `${String(frame).padStart(4, '0')}.png`));
  }
  // Full frames plus transparent disposal prevent a previous pose from showing
  // through transparent pixels. A reserved transparent color gives clean edges
  // on both light and dark backgrounds; no page-colored matte is baked in.
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps),
    '-i', join(temporary, '%04d.png'),
    '-filter_complex', '[0:v]split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=full[p];[b][p]paletteuse=dither=none:alpha_threshold=128',
    '-loop', '0', '-gifflags', '-offsetting-transdiff', output,
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `ffmpeg exited ${result.status}`);
  console.log(JSON.stringify({
    output, size, frames, fps, cadenceMs: DOMINO_CADENCE,
    modelDurationMs: DOMINO_DURATION, gifDurationMs: Math.round(DOMINO_DURATION / 10) * 10,
    bytes: (await stat(output)).size,
  }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
