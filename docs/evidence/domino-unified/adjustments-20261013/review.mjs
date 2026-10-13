import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { chromium } from '/Users/yingbowu/Documents/Projects/acanvas/node_modules/playwright-core/index.mjs';
import { expect } from '/Users/yingbowu/Documents/Projects/acanvas/node_modules/@playwright/test/index.mjs';

const repo = '/Users/yingbowu/Documents/Projects/acanvas';
const candidate = '/private/tmp/acanvas-domino-unified-run';
const out = repo + '/docs/evidence/domino-unified/adjustments-20261013';
await mkdir(out, { recursive: true });
const project = await mkdtemp('/private/tmp/acanvas-domino-adjustments-');
const runtime = repo + '/.runtime/node_modules/node/bin/node';
const child = spawn(runtime, [candidate + '/src/server/main.js', '--project', project, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stderr.on('data', b => stderr += b);
const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Service timeout: ' + stderr)), 15000);
  child.stdout.on('data', b => { stdout += b; const m = stdout.match(/acanvas: (http:\/\/127\.0\.0\.1:\d+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
  child.on('exit', code => reject(new Error('Service exit: ' + code + ' ' + stderr)));
});
const report = { candidate, project, base, checks: [], errors: [], measurements: {}, boundaries: ['Only audio loading, annotation Done, static icon transparency and the refreshed screenshot overview are in scope.', 'The original live service and user board are untouched.'] };
const check = name => { report.checks.push(name); console.log('PASS ' + name); };
const { token } = await (await fetch(base + '/api/bootstrap')).json();
const call = async (path, method = 'GET', body) => {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert(r.ok, `${method} ${path}: ${r.status} ${await r.clone().text()}`); return r.json();
};
const session = await call('/api/sessions', 'POST', { name: 'Domino adjustment independent review' });
const content = await readFile(repo + '/tests/fixtures/amplitude-cover.m4a');
const response = await fetch(base + '/api/assets?' + new URLSearchParams({ name: 'Signal study.m4a', mime: 'audio/mp4' }), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: content });
assert(response.ok); const asset = await response.json();
await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, x: 50, y: 100, width: 280, height: 90 } }] });
const browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 15000 });
report.browser = await browser.version();
const gate = async (page, pattern, predicate = () => true) => {
  let release, hits = 0; const pending = new Promise(r => release = r);
  const handler = async route => { if (!predicate(route.request())) return route.continue(); hits++; await pending; await route.continue().catch(e => { if (!/handled|closed|canceled/i.test(e.message)) throw e; }); };
  await page.route(pattern, handler);
  return { seen: () => expect.poll(() => hits).toBeGreaterThan(0), release: async () => { release(); await page.unroute(pattern, handler); } };
};
try {
  const p = await browser.newPage({ viewport: { width: 390, height: 760 }, colorScheme: 'light' });
  p.on('pageerror', e => report.errors.push(e.message));
  const audioHold = await gate(p, `**/api/assets/${asset.id}/content*`, r => r.resourceType() === 'fetch');
  await p.goto(base + '/?session=' + session.id, { waitUntil: 'domcontentloaded' });
  await expect(p.locator('#whiteboard')).toBeVisible(); await audioHold.seen();
  const canvas = p.locator('.audio-player-waveform canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'false');
  await expect(p.getByRole('button', { name: 'Play audio', exact: true })).toBeEnabled();
  const lineMeasurement = () => canvas.evaluate(c => {
    const context = c.getContext('2d'), x = Math.floor(c.width * .75), data = context.getImageData(x, 0, 1, c.height).data;
    const rows = [];
    for (let y = 0; y < c.height; y++) if (data[y * 4 + 3]) rows.push({ y, rgba: Array.from(data.slice(y * 4, y * 4 + 4)) });
    const style = getComputedStyle(c), parentStyle = getComputedStyle(c.parentElement), b = c.getBoundingClientRect();
    return { width: c.width, height: c.height, cssWidth: b.width, cssHeight: b.height, rows, display: style.display, visibility: style.visibility, opacity: style.opacity, parentOpacity: parentStyle.opacity, topElement: document.elementFromPoint(b.left + b.width * .75, b.top + b.height / 2)?.tagName, color: style.getPropertyValue('--audio-wave').trim(), statusClass: c.nextElementSibling?.className, statusRole: c.nextElementSibling?.getAttribute('role'), statusText: c.nextElementSibling?.textContent, dominoCount: c.parentElement.querySelectorAll('.domino-loader').length };
  });
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') { await p.getByRole('button', { name: 'Theme', exact: true }).click(); await p.getByRole('menuitemradio', { name: 'Dark', exact: true }).click(); }
    const m = await lineMeasurement(); report.measurements['audio-' + theme] = m;
    assert.equal(m.rows.length, 2); assert.equal(m.rows[0].y, Math.floor((m.height - 2) / 2));
    assert.equal(m.rows[1].y, m.rows[0].y + 1); assert(m.rows.every(r => r.rgba[3] === 255));
    assert.equal(m.display, 'block'); assert.equal(m.visibility, 'visible'); assert.equal(m.opacity, '1'); assert.equal(m.parentOpacity, '1'); assert.equal(m.topElement, 'CANVAS');
    assert.equal(m.dominoCount, 0); assert.equal(m.statusClass, 'sr-only'); assert.equal(m.statusRole, 'status'); assert.equal(m.statusText, 'Loading waveform…');
    await p.screenshot({ path: out + '/audio-line-' + theme + '-390.png' });
  }
  check('Held real waveform fetch paints an unobstructed two-pixel horizontal line in light and dark');
  await p.getByRole('button', { name: 'Play audio', exact: true }).click();
  await expect.poll(() => p.locator('audio').evaluate(a => a.currentTime)).toBeGreaterThan(.05);
  await p.getByRole('button', { name: 'Pause audio', exact: true }).click();
  await expect.poll(() => p.locator('audio').evaluate(a => a.paused)).toBe(true);
  await audioHold.release(); await expect(canvas).toHaveAttribute('data-ready', 'true');
  await p.getByRole('slider', { name: 'Audio timeline', exact: true }).press('Home');
  await expect(p.getByRole('slider', { name: 'Audio timeline', exact: true })).toHaveAttribute('aria-valuenow', '0');
  check('Native playback works while waveform is pending; decoded waveform and keyboard seeking recover');

  await p.getByRole('button', { name: 'Mark canvas', exact: true }).click(); await p.locator('#whiteboard').press('Enter');
  const comment = p.getByRole('textbox', { name: 'Add a comment', exact: true }); await expect(comment).toBeVisible(); await comment.fill('Keep this arrangement.');
  const capture = await gate(p, '**/captures/*/content', r => r.method() === 'PUT');
  await p.getByRole('button', { name: 'Done', exact: true }).click(); await capture.seen(); await expect(comment).toHaveCount(0);
  await capture.release(); await expect(p.locator('.draft-annotation[data-capture-state=complete]')).toHaveCount(1);
  await p.locator('.annotation-content').click();
  const done = p.getByRole('button', { name: 'Done', exact: true }); await expect(done).toBeVisible();
  const resultHold = await gate(p, '**/captures/*', r => r.method() === 'GET'); await done.click(); await resultHold.seen();
  await expect(done).toHaveAttribute('aria-busy', 'true'); await expect(done).toBeDisabled(); await expect(done).toHaveText('Done'); await expect(done.locator('svg,.domino-loader')).toHaveCount(0);
  report.measurements.done = await done.evaluate(b => ({ text: b.textContent, busy: b.getAttribute('aria-busy'), disabled: b.disabled, svgCount: b.querySelectorAll('svg').length }));
  await p.screenshot({ path: out + '/annotation-done-text-dark-390.png' });
  await resultHold.release(); await expect(done).toHaveCount(0);
  const state = await call('/api/state?sessionId=' + session.id); assert.equal(state.draft.annotations[0].text, 'Keep this arrangement.'); assert.equal(state.draft.annotations[0].captureState.status, 'complete');
  check('Actual retained Done stays text, disabled and aria-busy; release closes the annotation and preserves capture');

  const svgPaths = ['assets/brand/domino/icon.svg', 'src/web/public/brand/acanvas-icon.svg', 'src/web/public/favicon.svg'];
  const svgs = await Promise.all(svgPaths.map(path => readFile(repo + '/' + path, 'utf8')));
  const selected = execFileSync('git', ['show', ':assets/brand/domino/icon.svg'], { cwd: repo, encoding: 'utf8' });
  const paths = svg => svg.match(/<path\b[^>]+>/g);
  for (const svg of svgs) { assert.deepEqual(paths(svg), paths(selected)); assert.equal(paths(svg).length, 3); assert(!/<(?:rect|image|foreignObject|filter|mask)\b/.test(svg)); }
  assert(svgs.every(s => s === svgs[0]));
  for (const path of ['/brand/acanvas-icon.svg', '/favicon.svg']) assert.equal(await (await fetch(base + path)).text(), svgs[0]);
  const sourcePng = await readFile(repo + '/assets/brand/domino/source-icon.png');
  assert(sourcePng.equals(execFileSync('git', ['show', 'HEAD:assets/brand/domino/source-icon.png'], { cwd: repo, maxBuffer: 8 * 1024 * 1024 })));
  report.measurements.iconSource = { pathCount: 3, fills: paths(svgs[0]).map(s => s.match(/fill="([^"]+)"/)[1]), unchangedPathsFromSelected: true, threeFilesIdentical: true, sourcePngUnchangedFromHead: true };
  const alpha = await p.evaluate(async () => {
    const img = new Image(); img.src = '/brand/acanvas-icon.svg'; await img.decode(); const c = document.createElement('canvas'); c.width = c.height = 512; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 512, 512); const data = x.getImageData(0, 0, 512, 512).data;
    let transparent = 0, opaque = 0; const fills = new Set();
    for (let i = 0; i < data.length; i += 4) { if (data[i + 3] === 0) transparent++; else if (data[i + 3] === 255) { opaque++; fills.add(Array.from(data.slice(i, i + 3)).join(',')); } }
    return { cornerRGBA: Array.from(data.slice(0, 4)), transparent, opaque, opaqueFills: Array.from(fills), png: c.toDataURL('image/png') };
  });
  assert.deepEqual(alpha.cornerRGBA, [0, 0, 0, 0]); assert(alpha.transparent > 190000); assert(alpha.opaque > 67000);
  assert(alpha.opaqueFills.includes('137,178,122')); assert(alpha.opaqueFills.includes('250,158,179')); assert(alpha.opaqueFills.includes('159,158,158')); assert(!alpha.opaqueFills.includes('253,253,253'));
  await writeFile(out + '/icon-transparent-independent-512.png', Buffer.from(alpha.png.split(',')[1], 'base64')); delete alpha.png; report.measurements.iconAlpha = alpha;
  await p.locator('.project-identity').screenshot({ path: out + '/brand-transparent-dark.png' });
  check('SVG paths and palette match the selected mark; all served files are truly transparent; source PNG unchanged');
  assert.equal(report.errors.length, 0); check('Zero browser exceptions');
} catch (e) { report.failure = { message: e.message, stack: e.stack }; throw e; }
finally { report.completedAt = new Date().toISOString(); await writeFile(out + '/verification.json', JSON.stringify(report, null, 2)); await browser.close(); const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
