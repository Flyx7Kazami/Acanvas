import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Sixty ordered ribs trace a broken, eccentric annulus.
// Radius and angle vary continuously, so every repeat belongs to one contour.
const out = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sharp = require(process.env.ACANVAS_MEDIA_MODULES ? join(process.env.ACANVAS_MEDIA_MODULES, 'sharp') : 'sharp');
const palette = { paper:'#f3f1e7', ink:'#21211f', pink:'#f12780', yellow:'#f2ec38' };
const rad = d => d * Math.PI / 180;
const f = v => v.toFixed(3);
const p = (r, a) => [624 + r*Math.cos(rad(a)), 461 + r*Math.sin(rad(a))*.98];
const xy = ([x,y]) => `${f(x)} ${f(y)}`;
const ribs = [];
for (let i=0; i<60; i++) {
  const a = -119 + i * 5.24;
  const t = i / 59;
  const outer = 388 + 37*Math.sin(rad(a+18)) + 22*Math.cos(rad(2*a-34));
  const inner = 194 + 46*Math.cos(rad(a+49)) + 15*Math.sin(rad(2*a+20));
  const turn = 17 + 8*Math.sin(rad(a-30));
  const width = 2.55;
  const start = p(inner,a-width/2);
  const edgeA = p(outer,a+turn-width/2);
  const edgeB = p(outer,a+turn+width/2);
  const end = p(inner,a+width/2);
  const c1 = p(inner+(outer-inner)*.38,a+turn*.58-width/2);
  const c2 = p(inner+(outer-inner)*.72,a+turn*.91-width/2);
  const c3 = p(inner+(outer-inner)*.72,a+turn*.91+width/2);
  const c4 = p(inner+(outer-inner)*.38,a+turn*.58+width/2);
  const color = i>=39 && i<=53 ? palette.pink : palette.ink;
  ribs.push(`<path d="M ${xy(start)} C ${xy(c1)} ${xy(c2)} ${xy(edgeA)} L ${xy(edgeB)} C ${xy(c3)} ${xy(c4)} ${xy(end)} Z" fill="${color}"/>`);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">
<title>Eccentric rhythm — Slow Signal</title>
<desc>Sixty curved radial ribs form a broken annular glyph, with a rising magenta register and an eccentric yellow counterform.</desc>
<defs>
  <filter id="paper" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency=".68" numOctaves="3" seed="24" stitchTiles="stitch"/>
    <feColorMatrix type="saturate" values="0"/>
    <feComponentTransfer><feFuncA type="linear" slope=".055"/></feComponentTransfer>
    <feBlend in="SourceGraphic" mode="multiply"/>
  </filter>
</defs>
<g filter="url(#paper)">
  <path fill="${palette.paper}" d="M0 0h1000v1000H0z"/>
  <g fill="${palette.ink}" font-family="Arial, Helvetica, sans-serif">
    <text x="64" y="82" font-size="23" font-weight="700" letter-spacing="-.7">SLOW SIGNAL</text>
    <text x="65" y="111" font-size="11" font-weight="500" letter-spacing="1.9">RHYTHM STUDY / 02</text>
  </g>
  ${ribs.join('\n  ')}
  <circle cx="729" cy="409" r="102" fill="${palette.yellow}"/>
  <g fill="${palette.ink}" font-family="Arial, Helvetica, sans-serif">
    <text x="62" y="907" font-size="168" font-weight="700" letter-spacing="-14">02</text>
    <text x="329" y="890" font-size="12" letter-spacing="1.8">ECCENTRIC</text>
    <text x="329" y="911" font-size="12" letter-spacing="1.8">RHYTHM</text>
  </g>
</g>
</svg>`;
await writeFile(join(out,'Eccentric-rhythm.svg'), svg);
await sharp(Buffer.from(svg)).png().toFile(join(out,'Eccentric-rhythm.png'));
console.log('Eccentric-rhythm.svg and Eccentric-rhythm.png exported at 1000 × 1000.');
