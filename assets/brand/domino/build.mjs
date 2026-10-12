import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as k from './vendor/anatomy/iso-kit.mjs';
import { DOMINO_CARDS, DOMINO_VIEWBOX, dominoCardSvg } from './model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = (path) => readFileSync(join(here, path), 'utf8');
const inlineModule = (text) => text.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const license = source('vendor/anatomy/LICENSE');
const script = `/* Anatomy — MIT License\n${license}*/\n${inlineModule(source('vendor/anatomy/iso-kit.mjs'))}\nconst k = { cameraOf, roundedPlan, extrude, solidSvg };\n${inlineModule(source('model.mjs'))}\n${source('live.mjs')}`;
const play = '<svg viewBox="0 0 20 20" aria-hidden="true"><path class="play-shape" d="M6 3.5 16 10 6 16.5Z" fill="currentColor"/><path class="pause-shape" d="M5 4h3v12H5zM12 4h3v12h-3z" fill="currentColor"/></svg>';
const replay = '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 7a6.4 6.4 0 1 1-.4 5M4 2.8V7h4.2"/></svg>';
const theme = '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="10" cy="10" r="6.2"/><path d="M10 3.8v12.4a6.2 6.2 0 0 1 0-12.4Z" fill="currentColor"/></svg>';
const body = `<defs>
  <linearGradient id="surface-light" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".065"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <filter id="card-shadow" x="-30%" y="-20%" width="170%" height="160%" color-interpolation-filters="sRGB"><feDropShadow dx="1" dy="4" stdDeviation="3" flood-color="#263322" flood-opacity=".07"/></filter>
</defs>${DOMINO_CARDS.map((_, index) => dominoCardSvg(index)).join('')}`;
const figure = k.figureSvg({ width: DOMINO_VIEWBOX[0], height: DOMINO_VIEWBOX[1], label: 'Three overlapping rounded cards: sage behind blush behind stone. Their staggered motion returns to the acanvas icon.', body });
const favicon = `data:image/png;base64,${readFileSync(join(here, '../../../src/web/public/brand/acanvas-favicon.png')).toString('base64')}`;
const html = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>acanvas · Domino</title>
<link rel="icon" type="image/png" sizes="64x64" href="${favicon}">
<style>${source('style.css')}</style>
</head><body><main>
<header class="page-head"><div class="wordmark" aria-label="acanvas">acanvas</div><button id="theme" class="theme-button" type="button" aria-label="Switch to dark theme">${theme}<span>Dark</span></button></header>
<section class="motion iso-plate" tabindex="0" role="group" aria-label="Domino animation" aria-describedby="hint">
<header class="figure-head"><h1 class="figure-number">01<span>Domino</span></h1><output data-readout aria-hidden="true">Together</output></header>
<div class="stage">${figure}</div>
<div class="transport"><button id="play" class="play" type="button" aria-label="Pause animation" data-playing="true">${play}<span>Pause</span></button><button id="replay" class="replay" type="button" aria-label="Replay animation" title="Replay (R)">${replay}</button><div class="timeline-wrap"><label class="sr-only" for="timeline">Animation timeline</label><input id="timeline" type="range" min="0" max="8600" step="10" value="0" aria-valuetext="0 seconds of 8.6 seconds. Together."></div><output id="elapsed" aria-hidden="true">0.0 / 8.6s</output></div>
<span id="announcement" class="sr-only" role="status" aria-live="polite"></span></section>
<footer class="page-foot"><p id="hint">Space to play / pause · ← → to step · R to replay</p><p class="signature">Ideas in motion.</p></footer>
</main><script type="module">${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
writeFileSync(join(here, 'index.html'), html);
console.log(`Built ${join(here, 'index.html')} (${Buffer.byteLength(html)} bytes)`);
