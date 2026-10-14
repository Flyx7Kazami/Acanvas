import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(process.env.ACANVAS_PERFORMANCE_BUILD_ROOT || process.cwd());
const { startServer } = await import(pathToFileURL(join(repo, 'dist/src/server/http.js')));
const { chromium } = await import(pathToFileURL(join(repo, 'node_modules/playwright-core/index.mjs')));
const output = process.env.PERF_OUTPUT || await mkdtemp('/private/tmp/acanvas-folder-performance-');
await mkdir(output, { recursive: true });
const root = await mkdtemp('/private/tmp/acanvas-folder-project-');
const server = await startServer({ root, port: 0, webRoot: process.env.PERF_WEB_ROOT || join(repo, 'dist/web') });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
const page = await context.newPage(), errors = [], measured = [], snapshots = [];
page.on('pageerror', error => errors.push(error.message));
const groupId = 'folder-studies', groupName = 'Folder studies';
try {
  const token = (await (await fetch(server.url + '/api/bootstrap')).json()).token;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(server.url + path, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  const upload = async (name, mime, body) => {
    const response = await fetch(server.url + '/api/assets?name=' + encodeURIComponent(name) + '&mime=' + encodeURIComponent(mime), { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body });
    const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
  };
  const session = await call('/api/sessions', 'POST', { name: 'Folder performance' });
  const state = () => call('/api/state?sessionId=' + session.id);
  const content = async id => (await fetch(server.url + '/api/assets/' + id + '/content?sessionId=' + session.id, { headers: { Authorization: 'Bearer ' + token } })).text();
  const svg = color => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="${color}"/><circle cx="230" cy="70" r="45" fill="#f3ebdd"/></svg>`;
  const image = await upload('Study image.svg', 'image/svg+xml', svg('#779d85'));
  const note = await upload('Field notes', 'text/x-acanvas-note', 'Original content');
  const neighbor = await upload('Outside image.svg', 'image/svg+xml', svg('#ea6848'));
  const fixture = [
    { id: 'member-a', assetId: image.id, assetName: image.name, x: 220, y: 210, width: 180, height: 120 },
    { id: 'member-b', assetId: image.id, assetName: image.name, x: 430, y: 210, width: 180, height: 120 },
    { id: 'member-note', assetId: note.id, assetName: note.name, x: 220, y: 390, width: 240, height: 128 },
    { id: 'outside-right', assetId: neighbor.id, assetName: neighbor.name, x: 760, y: 210, width: 180, height: 120 },
    { id: 'outside-below', assetId: neighbor.id, assetName: neighbor.name, x: 220, y: 640, width: 180, height: 120 },
  ];
  for (const { assetName, ...object } of fixture) { await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object }] }); await new Promise(resolve => setTimeout(resolve, 2)); }
  const fixtureState = await state(); assert.deepEqual(fixtureState.objects.map(object => object.id), fixture.map(object => object.id));
  for (const entry of fixture) { const object = fixtureState.objects.find(object => object.id === entry.id); for (const key of ['x', 'y', 'width', 'height']) assert.equal(object[key], entry[key]); }
  await page.addInitScript(() => {
    const perf = window.folderPerf = { active: false, records: {}, phase: '', expected: null, events: [], longTasks: [], lastFrameAt: performance.now() };
    const camera = () => { const m = new DOMMatrix(document.querySelector('.canvas-world')?.style.transform); return { x: m.e, y: m.f, zoom: m.a }; };
    perf.camera = camera;
    const same = (actual, expected) => Object.keys(expected).every(key => Math.abs(actual[key] - expected[key]) < .01);
    const rect = element => element && ({ x: parseFloat(element.style.left), y: parseFloat(element.style.top), width: parseFloat(element.style.width), height: parseFloat(element.style.height) });
    const matches = (expected, terminal) => {
      if (!expected) return false;
      const nav = document.querySelector('.group-navigation'), world = document.querySelector('.canvas-world');
      const group = document.querySelector('[data-group-id="folder-studies"]:not(.group-transition-ghost):not(.group-exterior)');
      let match = false;
      if (expected.type === 'folder' || expected.type === 'frame') match = group?.classList.contains('group-' + expected.type) && !nav;
      if (expected.type === 'nested') match = !!nav && document.querySelectorAll('.board-object:not(.group-exterior)').length === 3;
      if (expected.type === 'root') match = !nav && (terminal ? document.querySelectorAll('.board-group').length === expected.groups && document.querySelectorAll('.board-object').length === expected.objects && (!expected.camera || same(camera(), expected.camera)) : expected.groups === 0 ? !group : true);
      if (expected.type === 'group-pose') match = group && (terminal ? same(rect(group), expected.pose) && !group.hasAttribute('data-moving') : !same(rect(group), expected.original));
      if (expected.type === 'object-pose') { const object = document.querySelector('[data-object-id="' + expected.id + '"]'); match = object && (terminal ? same(rect(object), expected.pose) && !object.hasAttribute('data-moving') : !same(rect(object), expected.original)); }
      if (expected.type === 'note') { const object = document.querySelector('[data-object-id="member-note"]'), editor = object?.querySelector('textarea'); match = editor?.value === expected.text && (!terminal || Number(object.dataset.objectVersion) > expected.version); }
      if (terminal && match) match = !world?.dataset.transitionKind && !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.target instanceof Element && animation.effect.target.closest('.canvas-world')) && !document.querySelector('button[aria-label="Undo"]')?.disabled;
      return !!match;
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'beforeinput', 'input', 'keydown']) document.addEventListener(type, event => {
      if (!perf.active) return;
      const row = perf.records[perf.phase], now = performance.now();
      row.events.push({ type, at: now, trusted: event.isTrusted, ...(type.startsWith('pointer') ? { buttons: event.buttons, x: event.clientX, y: event.clientY, pointerId: event.pointerId } : {}) });
      const starts = perf.expected?.type.endsWith('-pose') ? ['pointerdown'] : ['pointerdown', 'beforeinput', 'input', 'keydown'];
      if (row.inputAt === undefined && starts.includes(type)) row.inputAt = now;
      if (type === 'pointerup' || type === 'input') row.lastInputAt = now;
    }, true);
    new PerformanceObserver(list => { perf.longTasks.push(...list.getEntries().map(entry => ({ at: entry.startTime, duration: entry.duration }))); }).observe({ type: 'longtask', buffered: false });
    const tick = at => {
      if (perf.active) {
        const row = perf.records[perf.phase]; row.frames.push({ at, gap: at - perf.lastFrameAt });
        if (row.inputAt !== undefined && row.feedbackAt === undefined && matches(perf.expected, false)) row.feedbackAt = performance.now();
        if (row.feedbackAt !== undefined && row.terminalAt === undefined && matches(perf.expected, true)) row.terminalAt = performance.now();
      }
      perf.lastFrameAt = at; requestAnimationFrame(tick);
    }; requestAnimationFrame(tick);
  });
  await page.goto(server.url + '/?session=' + session.id);
  await page.locator('[data-object-id="member-a"]').waitFor(); await page.locator('.note-editor').waitFor(); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(500);
  // A real captured comment provides immutable annotation source evidence throughout the sequence.
  await page.locator('[data-object-id="member-b"]').click();
  await page.getByRole('button', { name: 'Mark canvas', exact: true }).click();
  const imageBox = await page.locator('[data-object-id="member-b"]').boundingBox();
  await page.mouse.move(imageBox.x + 30, imageBox.y + 40); await page.mouse.down(); await page.mouse.move(imageBox.x + 100, imageBox.y + 90, { steps: 5 }); await page.mouse.up();
  await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Preserve this reference.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  for (let attempt = 0; attempt < 200; attempt++) { if ((await state()).draft.annotations[0]?.captureState?.status === 'complete') break; await page.waitForTimeout(50); }
  const initialAnnotation = (await state()).draft.annotations[0]; assert.equal(initialAnnotation.captureState.status, 'complete'); assert.equal(initialAnnotation.objectId, 'member-b');
  const provenance = annotation => ({ id: annotation.id, objectId: annotation.objectId, objectIds: annotation.objectIds, assetId: annotation.assetId, bounds: annotation.bounds, coordinateSpace: annotation.coordinateSpace, text: annotation.text, sceneSource: annotation.sceneSource, capture: annotation.capture });
  const annotationSource = provenance(initialAnnotation);
  await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'group.create', group: { id: groupId, name: groupName, color: 'sage', objectIds: ['member-a', 'member-b', 'member-note'] }, expectedVersions: { 'member-a': 1, 'member-b': 1, 'member-note': 1 } }] });
  await page.getByRole('button', { name: 'Select group ' + groupName, exact: true }).click(); await page.waitForTimeout(300);
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  const shape = value => ({ objects: value.objects.map(({ id, assetId, x, y, width, height, groupId, fill }) => ({ id, assetId, assetName: value.assets.find(asset => asset.id === assetId)?.name, x, y, width, height, groupId, fill })), groups: value.groups.map(({ id, name, mode, color, x, y, width, height, objectIds }) => ({ id, name, mode, color, x, y, width, height, objectIds })) });
  const recordState = async name => {
    const value = await state(); assert.deepEqual(provenance(value.draft.annotations[0]), annotationSource, name + ' retains captured annotation provenance');
    const snapshot = { name, shape: shape(value), view: value.session.view, noteContent: await content(value.objects.find(object => object.id === 'member-note').assetId), annotationSourcePreserved: true };
    snapshots.push(snapshot); return snapshot;
  };
  const phase = async (name, expected, action) => {
    await page.evaluate(({ name, expected }) => { const perf = window.folderPerf; perf.phase = name; perf.expected = expected; perf.records[name] = { events: [], frames: [], startedAt: performance.now() }; perf.active = true; }, { name, expected });
    const before = await cdp.send('Performance.getMetrics'); await action();
    await page.waitForFunction(() => window.folderPerf.records[window.folderPerf.phase].terminalAt !== undefined, {}, { timeout: 15000, polling: 'raf' });
    const after = await cdp.send('Performance.getMetrics');
    const facts = await page.evaluate(() => { const perf = window.folderPerf, row = perf.records[perf.phase], endedAt = performance.now(); perf.active = false; return { ...row, endedAt, longTasks: perf.longTasks.filter(entry => entry.at >= row.startedAt && entry.at <= endedAt), camera: perf.camera(), finalPose: [...document.querySelectorAll('.board-object,.board-group')].map(element => ({ objectId: element.dataset.objectId, groupId: element.dataset.groupId, x: parseFloat(element.style.left), y: parseFloat(element.style.top), width: parseFloat(element.style.width), height: parseFloat(element.style.height), moving: element.hasAttribute('data-moving') })), reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, transitionKind: document.querySelector('.canvas-world')?.dataset.transitionKind }; });
    facts.firstFeedbackMs = facts.feedbackAt - facts.inputAt; facts.interactiveTerminalMs = facts.terminalAt - facts.inputAt; facts.lastInputToTerminalMs = facts.terminalAt - (facts.lastInputAt ?? facts.inputAt);
    facts.metrics = Object.fromEntries(after.metrics.filter(metric => /Duration|Count|Heap/.test(metric.name)).map(metric => [metric.name, metric.value - (before.metrics.find(other => other.name === metric.name)?.value ?? 0)]));
    const gaps = facts.frames.map(frame => frame.gap).sort((a, b) => a - b); facts.frameGaps = { count: gaps.length, p50: gaps[Math.floor(gaps.length * .5)], p95: gaps[Math.floor(gaps.length * .95)], max: gaps.at(-1) };
    facts.inputCounts = { pointerDown: facts.events.filter(event => event.type === 'pointerdown').length, pointerMovesWithButtons: facts.events.filter(event => event.type === 'pointermove' && event.buttons).length, pointerUp: facts.events.filter(event => event.type === 'pointerup').length, beforeInput: facts.events.filter(event => event.type === 'beforeinput').length, input: facts.events.filter(event => event.type === 'input').length };
    if (['folder-drag', 'move-inside-folder'].includes(name)) assert.deepEqual({ down: facts.inputCounts.pointerDown, moves: facts.inputCounts.pointerMovesWithButtons, up: facts.inputCounts.pointerUp }, { down: 1, moves: 30, up: 1 });
    assert.equal(facts.reducedMotion, false); assert(Number.isFinite(facts.firstFeedbackMs)); assert(Number.isFinite(facts.interactiveTerminalMs));
    measured.push({ name, expected, ...facts }); console.log(JSON.stringify({ name, firstFeedbackMs: facts.firstFeedbackMs, interactiveTerminalMs: facts.interactiveTerminalMs, lastInputToTerminalMs: facts.lastInputToTerminalMs, frameGaps: facts.frameGaps, longTasks: facts.longTasks, metrics: facts.metrics }));
    return recordState(name);
  };
  const button = name => page.getByRole('button', { name, exact: true });
  const caption = () => button('Select group ' + groupName);
  const waitStable = () => page.waitForFunction(() => !document.querySelector('.canvas-world')?.dataset.transitionKind, {}, { polling: 'raf' });
  const nativeDrag = async (locator, dx, dy) => { const box = await locator.boundingBox(); assert(box); await page.keyboard.down('Alt'); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); for (let index = 1; index <= 30; index++) { await page.mouse.move(box.x + box.width / 2 + dx * index / 30, box.y + box.height / 2 + dy * index / 30); await page.waitForTimeout(8); } await page.mouse.up(); await page.keyboard.up('Alt'); };
  const initial = await recordState('initial-frame');
  const folder = await phase('frame-to-folder', { type: 'folder' }, () => button('Store in folder').click());
  assert(folder.shape.objects.find(object => object.id === 'outside-below').y < initial.shape.objects.find(object => object.id === 'outside-below').y);
  await phase('undo-collapse', { type: 'frame' }, () => button('Undo').click()); assert.deepEqual(snapshots.at(-1).shape, initial.shape);
  await phase('redo-collapse', { type: 'folder' }, () => button('Redo').click()); assert.deepEqual(snapshots.at(-1).shape, folder.shape);
  await caption().click();
  const originalGroup = (await state()).groups[0];
  const dragged = await phase('folder-drag', { type: 'group-pose', original: { x: originalGroup.x, y: originalGroup.y }, pose: { x: originalGroup.x + 60, y: originalGroup.y + 20 } }, () => nativeDrag(caption(), 60, 20));
  for (const id of originalGroup.objectIds) { const before = folder.shape.objects.find(object => object.id === id), after = dragged.shape.objects.find(object => object.id === id); assert.equal(after.x, before.x + 60); assert.equal(after.y, before.y + 20); }
  const parentCamera = await page.evaluate(() => window.folderPerf.camera());
  await page.screenshot({ path: join(output, 'folder.png') });
  await phase('enter-folder', { type: 'nested' }, () => button('Open folder ' + groupName).click());
  assert.equal((await state()).session.view.activeGroupId, groupId);
  assert.equal(await page.locator('.board-object.group-exterior').count(), 2); assert.equal(await page.locator('.board-object.group-exterior').evaluateAll(elements => elements.every(element => element.inert)), true);
  const memberBefore = (await state()).objects.find(object => object.id === 'member-a'), nestedCamera = await page.evaluate(() => window.folderPerf.camera());
  const memberMoved = await phase('move-inside-folder', { type: 'object-pose', id: memberBefore.id, original: { x: memberBefore.x, y: memberBefore.y }, pose: { x: memberBefore.x + 50 / nestedCamera.zoom, y: memberBefore.y + 20 / nestedCamera.zoom } }, () => nativeDrag(page.locator('[data-object-id="member-a"]'), 50, 20));
  await phase('undo-member-move', { type: 'object-pose', id: memberBefore.id, original: { x: memberMoved.shape.objects.find(object => object.id === memberBefore.id).x, y: memberMoved.shape.objects.find(object => object.id === memberBefore.id).y }, pose: { x: memberBefore.x, y: memberBefore.y } }, () => button('Undo').click());
  assert.deepEqual(snapshots.at(-1).shape, snapshots.find(value => value.name === 'enter-folder').shape);
  await phase('redo-member-move', { type: 'object-pose', id: memberBefore.id, original: { x: memberBefore.x, y: memberBefore.y }, pose: { x: memberMoved.shape.objects.find(object => object.id === memberBefore.id).x, y: memberMoved.shape.objects.find(object => object.id === memberBefore.id).y } }, () => button('Redo').click()); assert.deepEqual(snapshots.at(-1).shape, memberMoved.shape);
  const editor = page.locator('[data-object-id="member-note"] .note-editor');
  const edited = await phase('edit-folder-note', { type: 'note', text: 'Nested saved content', version: (await state()).objects.find(object => object.id === 'member-note').version }, async () => { await editor.click(); await page.keyboard.press('Meta+A'); await page.keyboard.insertText('Nested saved content'); await page.keyboard.press('Tab'); }); assert.equal(edited.noteContent, 'Nested saved content');
  await phase('undo-folder-note', { type: 'note', text: 'Original content', version: (await state()).objects.find(object => object.id === 'member-note').version }, () => button('Undo').click()); assert.equal(snapshots.at(-1).noteContent, 'Original content');
  await phase('redo-folder-note', { type: 'note', text: 'Nested saved content', version: (await state()).objects.find(object => object.id === 'member-note').version }, () => button('Redo').click()); assert.equal(snapshots.at(-1).noteContent, 'Nested saved content');
  await page.screenshot({ path: join(output, 'secondary.png') });
  await phase('return-parent-view', { type: 'root', groups: 1, objects: 2, camera: parentCamera }, () => button('Back to board').click()); assert.equal((await state()).session.view.activeGroupId, undefined);
  await caption().click();
  const expanded = await phase('expand-to-frame', { type: 'frame' }, () => button('Expand on board').click()); assert.equal(expanded.shape.objects.filter(object => object.groupId === groupId).length, 3);
  await caption().click(); await button('Store in folder').click(); await waitStable(); await page.waitForTimeout(50);
  const beforeUngroup = await recordState('before-direct-ungroup'); await caption().click();
  const ungrouped = await phase('direct-folder-ungroup', { type: 'root', groups: 0, objects: 5 }, () => button('Ungroup').click()); assert(ungrouped.shape.objects.every(object => !object.groupId));
  await phase('undo-folder-ungroup', { type: 'folder' }, () => button('Undo').click()); assert.deepEqual(snapshots.at(-1).shape, beforeUngroup.shape);
  await phase('redo-folder-ungroup', { type: 'root', groups: 0, objects: 5 }, () => button('Redo').click()); assert.deepEqual(snapshots.at(-1).shape, ungrouped.shape);
  await page.reload(); await page.locator('[data-object-id="member-note"] .note-editor').waitFor(); await page.waitForTimeout(300);
  const reloaded = await recordState('reload'); assert.deepEqual(reloaded.shape, ungrouped.shape); assert.equal(reloaded.noteContent, 'Nested saved content');
  await page.screenshot({ path: join(output, 'ungrouped.png') });
  assert.deepEqual(errors, []);
  const facts = { measuredAt: new Date().toISOString(), browser: browser.version(), root, webRoot: process.env.PERF_WEB_ROOT || join(repo, 'dist/web'), fixture, initialObjectOrder: fixtureState.objects.map(object => object.id), viewport: { width: 1280, height: 900 }, dpr: 2, reducedMotion: false, instrumentation: 'Real pointer/button/keyboard input in an isolated project. Feedback ends at RAF observation of the requested DOM state. Interactive terminal additionally waits for the matching final geometry, enabled Undo, original CSS motion, and group transition cleanup. The product retains 420ms motion and 620ms transition lifecycle. CDP script/layout duration distinguishes main-thread work from animation wall time; compositor presentation delay is outside this measurement. Screenshots and HTTP state/source assertions run outside timed phases. Same immutable source annotation is asserted after each operation. Internal note editing uses native keyboard input and blur save. Objects are created sequentially with fixed IDs, creation order, asset names and asserted initial geometry; every gesture addresses an explicit target ID.', errors, measured, snapshots, assertions: { capturedAnnotationSource: true, neighborCompaction: true, wholeFolderTranslation: true, exteriorInert: true, internalMoveUndoRedo: true, internalContentUndoRedo: true, parentViewRestored: true, directUngroupUndoRedo: true, refreshedLayoutContent: true } };
  await writeFile(join(output, 'performance.json'), JSON.stringify(facts, null, 2) + '\n'); console.log('OUTPUT', output);
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  const active = await page.evaluate(() => ({ phase: window.folderPerf?.phase, records: window.folderPerf?.records, html: document.querySelector('.whiteboard')?.outerHTML, animations: document.getAnimations().map(animation => ({ playState: animation.playState, currentTime: animation.currentTime, target: animation.effect?.target?.className })) })).catch(() => undefined);
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), errors, measured, snapshots, active }, null, 2)); throw error;
} finally { await context.close(); await browser.close(); await server.close(); }
