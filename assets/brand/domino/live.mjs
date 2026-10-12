const dominoFigure = document.querySelector('.motion');
const dominoStage = document.querySelector('.stage');
const dominoSlider = document.querySelector('#timeline');
const dominoPlay = document.querySelector('#play');
const dominoReplay = document.querySelector('#replay');
const dominoReadout = document.querySelector('[data-readout]');
const dominoElapsed = document.querySelector('#elapsed');
const dominoAnnouncement = document.querySelector('#announcement');
const dominoReduced = matchMedia('(prefers-reduced-motion: reduce)');
const dominoSystemTheme = matchMedia('(prefers-color-scheme: dark)');
const dominoTheme = document.querySelector('#theme');
const dominoNodes = [...document.querySelectorAll('[data-card]')].map((node) => {
  const top = node.querySelector('.iso-top');
  const shades = Array.from({ length: 4 }, (_, shade) => {
    let path = node.querySelector(`.iso-shade[data-shade="${shade}"]`);
    if (!path) {
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'iso-shade');
      path.dataset.shade = String(shade);
      top.before(path);
    }
    return path;
  });
  return { fill: node.querySelector('.iso-fill'), top, edge: node.querySelector('.iso-edge'), shades };
});

let dominoTime = 0, dominoFrame = 0, dominoLast = 0;
let dominoPlaying = !dominoReduced.matches, dominoVisible = false, dominoManualTheme = false;

function dominoDescribe() {
  dominoSlider.setAttribute('aria-valuetext', `${(dominoTime / 1000).toFixed(1)} seconds of 8.6 seconds. ${dominoAt(dominoTime).phase}.`);
}

function dominoDraw() {
  const state = dominoAt(dominoTime);
  dominoNodes.forEach((nodes, index) => {
    const shape = dominoGeometry(index, state.shares[index]);
    nodes.fill.setAttribute('d', shape.fill);
    nodes.top.setAttribute('d', shape.top);
    nodes.edge.setAttribute('d', shape.outline);
    nodes.shades.forEach((node) => node.setAttribute('d', shape.shades[Number(node.dataset.shade)]));
  });
  dominoSlider.value = String(Math.round(dominoTime));
  dominoSlider.style.setProperty('--progress', `${dominoTime / DOMINO_DURATION * 100}%`);
  dominoElapsed.textContent = `${(dominoTime / 1000).toFixed(1)} / 8.6s`;
  dominoReadout.textContent = state.phase;
  dominoFigure.dataset.time = dominoTime.toFixed(1);
  dominoDescribe();
}

function dominoSync() {
  const running = dominoPlaying && dominoVisible && !document.hidden && !dominoReduced.matches;
  dominoFigure.dataset.playing = String(dominoPlaying);
  dominoFigure.dataset.running = String(running);
  dominoPlay.disabled = dominoReduced.matches;
  dominoPlay.setAttribute('aria-label', dominoPlaying ? 'Pause animation' : 'Play animation');
  dominoPlay.querySelector('span').textContent = dominoPlaying ? 'Pause' : 'Play';
  dominoPlay.dataset.playing = String(dominoPlaying);
  document.querySelector('#hint').textContent = dominoReduced.matches
    ? 'Reduced motion · Drag the timeline or use ← → to inspect'
    : 'Space to play / pause · ← → to step · R to replay';
  if (!running && dominoFrame) {
    cancelAnimationFrame(dominoFrame);
    dominoFrame = 0;
  }
  if (running && !dominoFrame) {
    dominoLast = 0;
    dominoFrame = requestAnimationFrame(dominoTick);
  }
}

function dominoTick(now) {
  const dt = dominoLast ? Math.min(now - dominoLast, 1000 / 30) : 0;
  dominoLast = now;
  dominoTime = (dominoTime + dt) % DOMINO_DURATION;
  dominoDraw();
  dominoFrame = requestAnimationFrame(dominoTick);
}

function dominoSetTime(value) {
  dominoPlaying = false;
  dominoTime = Math.max(0, Math.min(DOMINO_DURATION, value));
  dominoDraw();
  dominoDescribe();
  dominoSync();
}

function dominoToggle() {
  if (dominoReduced.matches) return;
  dominoPlaying = !dominoPlaying;
  dominoAnnouncement.textContent = dominoPlaying ? 'Playing.' : 'Paused.';
  dominoDescribe();
  dominoSync();
}

function dominoRestart() {
  dominoTime = 0;
  dominoPlaying = !dominoReduced.matches;
  dominoLast = 0;
  dominoDraw();
  dominoDescribe();
  dominoAnnouncement.textContent = dominoReduced.matches ? 'Together. Timeline at the start.' : 'Replaying.';
  dominoSync();
}

dominoPlay.addEventListener('click', dominoToggle);
dominoReplay.addEventListener('click', dominoRestart);
dominoSlider.addEventListener('input', () => dominoSetTime(Number(dominoSlider.value)));
dominoSlider.addEventListener('focus', () => { dominoPlaying = false; dominoDescribe(); dominoSync(); });
dominoSlider.addEventListener('pointerdown', () => { dominoPlaying = false; dominoSync(); dominoDescribe(); });
dominoFigure.addEventListener('keydown', (event) => {
  const button = event.target.closest('button');
  if (event.key === ' ' || event.key === 'Enter') {
    if (button) return;
    event.preventDefault();
    dominoToggle();
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    dominoSetTime(dominoTime + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 500 : 100));
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    dominoSetTime(event.key === 'Home' ? 0 : DOMINO_DURATION);
  } else if (event.key.toLowerCase() === 'r' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    dominoRestart();
  } else if (event.key === 'Escape') {
    dominoPlaying = false;
    dominoDescribe();
    dominoSync();
  }
});

new IntersectionObserver((entries) => {
  const entry = entries[entries.length - 1];
  dominoVisible = entry.isIntersecting && entry.intersectionRatio > 0;
  dominoSync();
}).observe(dominoStage);
document.addEventListener('visibilitychange', dominoSync);
dominoReduced.addEventListener('change', () => {
  if (dominoReduced.matches) dominoPlaying = false;
  dominoDescribe();
  dominoSync();
});

function dominoSetTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  dominoTheme.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  dominoTheme.querySelector('span').textContent = dark ? 'Light' : 'Dark';
}
dominoTheme.addEventListener('click', () => {
  dominoManualTheme = true;
  dominoSetTheme(document.documentElement.dataset.theme !== 'dark');
});
dominoSystemTheme.addEventListener('change', () => { if (!dominoManualTheme) dominoSetTheme(dominoSystemTheme.matches); });
dominoSetTheme(dominoSystemTheme.matches);
dominoDraw();
dominoDescribe();
dominoSync();
