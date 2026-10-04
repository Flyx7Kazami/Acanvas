import { test as base, expect } from '@playwright/test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import type { BoardState } from '../src/shared/types.js';

type Fixture = { root: string; url: string; restart: () => Promise<void>; call: (path: string, method?: string, body?: unknown) => Promise<any>; state: () => Promise<BoardState> };
const test = base.extend<{ app: Fixture }>({ app: async ({ page }, use) => {
  const root = await mkdtemp(join(tmpdir(), 'acanvas-multimodal-'));
  let child = spawn(resolve('.runtime/node_modules/node/bin/node'), [resolve('dist/src/server/main.js'), '--project', root, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', value => { errors += value; });
  const url = await new Promise<string>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(`Service startup timeout: ${errors}`)), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', value => { output += value; const address = output.match(/acanvas: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]; if (address) { clearTimeout(timer); accept(address); } });
  });
  let bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.ok, `${method} ${path}`).toBeTruthy(); return response.json();
  };
  await page.goto(url); await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  const sessionId = new URL(page.url()).searchParams.get('session')!;
  const restart = async () => { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; child = spawn(resolve('.runtime/node_modules/node/bin/node'), [resolve('dist/src/server/main.js'), '--project', root, '--port', new URL(url).port], { stdio: ['ignore', 'pipe', 'pipe'] }); child.stderr.on('data', value => { errors += value; }); await once(child.stdout, 'data'); bootstrap = await (await fetch(`${url}/api/bootstrap`)).json(); };
  try { await use({ root, url, restart, call, state: () => call(`/api/state?sessionId=${sessionId}`) }); }
  finally { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } expect(child.exitCode, errors).toBe(0); await rm(root, { recursive: true, force: true }); }
} });

function toneWav(seconds = 5): Buffer {
  const samples = 44100 * seconds, result = Buffer.alloc(44 + samples * 2);
  result.write('RIFF', 0); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(44100, 24); result.writeUInt32LE(88200, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) result.writeInt16LE(Math.round(Math.sin(index / 44100 * 440 * 2 * Math.PI) * 10000), 44 + index * 2);
  return result;
}

test('Markdown reads safely, separates layout interaction and persists whole original references', async ({ page, app }, info) => {
  const source = '# Field notes\n\nA **clear** paragraph.\n\n- First item\n- Second item\n\n> Quiet contrast\n\n```js\nconst count = 2;\n```\n\n[Source](https://example.com)\n\n[Unsafe](javascript:alert(1))\n\n<img src=x onerror="window.mdInjected=true">\n\n![Diagram](https://example.com/tracker.png)\n\n' + 'Further observations.\n\n'.repeat(50);
  let externalLoads = 0; page.on('request', request => { if (request.url().startsWith('https://example.com/tracker')) externalLoads++; });
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'field-notes.md', mimeType: 'text/plain', buffer: Buffer.from(source) });
  const object = page.locator('.board-object[data-content-kind="markdown"]'); await expect(object).toBeVisible(); await expect(object.locator('h1')).toHaveText('Field notes');
  await expect(object.locator('strong')).toHaveText('clear'); await expect(object.locator('img')).toHaveCount(0); await expect(object.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).mdInjected)).toBeUndefined(); expect(externalLoads).toBe(0);
  await object.click(); const state = await app.state(), original = state.objects[0], originalAsset = state.assets[0];
  const world = await page.locator('.canvas-world').getAttribute('style'); await page.getByRole('button', { name: 'Interact with content', exact: true }).click(); await expect(object).toHaveAttribute('data-interacting', 'true');
  const document = object.locator('.markdown-content'); await document.hover(); await page.mouse.wheel(0, 220); await expect.poll(() => document.evaluate(element => element.scrollTop)).toBeGreaterThan(0); expect(await page.locator('.canvas-world').getAttribute('style')).toBe(world);
  await document.focus(); await document.press('Escape'); await expect(object).not.toHaveAttribute('data-interacting', 'true');
  const resize = object.getByRole('button', { name: /Resize field-notes.md bottom right/ }); await resize.focus(); await resize.press('ArrowRight'); await expect.poll(async () => (await app.state()).objects[0].width).toBe(original.width + 10); expect((await app.state()).objects[0].height).toBe(original.height);
  await page.getByRole('button', { name: 'Annotate', exact: true }).click(); await page.getByLabel('Add a comment', { exact: true }).fill('Read this document.'); await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved'); await page.getByLabel('Add a comment', { exact: true }).press('Escape');
  await page.locator('#instruction').fill('Use the notes'); await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect.poll(async () => (await app.state()).tasks.length).toBe(1); const saved = await app.state(), annotation = saved.tasks[0].snapshot.annotations[0]; expect(annotation.bounds).toEqual({ x: 0, y: 0, width: 1, height: 1 }); expect(annotation.timeStart).toBeUndefined(); expect(annotation.snapshotAssetId).toBeUndefined(); expect(saved.tasks[0].snapshot.referenceContent.assets[0].id).toBe(originalAsset.id);
  const originalResponse = await page.request.get(`${app.url}/api/assets/${originalAsset.id}/content`); expect(await originalResponse.text()).toBe(source);
  await page.screenshot({ path: info.outputPath('markdown-whole-reference.png') });
});

test('GIF retains native animation and shared thumbnail rendering', async ({ page, app }, info) => {
  const buffer = await readFile(resolve('tests/fixtures/animated-reference.gif'));
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'motion.gif', mimeType: 'application/octet-stream', buffer });
  const object = page.locator('.board-object[data-content-kind="gif"]'); await expect(object.locator('img')).toBeVisible();
  const frames: Buffer[] = [];
  for (let index = 0; index < 10; index++) { frames.push(await object.locator('img').screenshot()); await page.waitForTimeout(85); }
  const different = frames.some(frame => !frame.equals(frames[0]));
  expect(different).toBeTruthy(); await object.click(); await page.getByRole('button', { name: 'Attach to request' }).click(); await expect(page.locator('.draft-asset .asset-thumb')).toHaveAttribute('data-kind', 'gif');
  expect((await app.state()).assets[0].kind).toBe('image'); await page.screenshot({ path: info.outputPath('gif-reference.png') });
});

test('audio plays real media, changes compact geometry once and saves explicit time range without frames', async ({ page, app }, info) => {
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'reference-tone.wav', mimeType: 'application/octet-stream', buffer: toneWav() });
  const object = page.locator('.board-object[data-content-kind="audio"]'); await expect(object.locator('audio')).toHaveCount(1);
  await expect.poll(() => object.locator('audio').evaluate((audio: HTMLAudioElement) => audio.duration)).toBeGreaterThan(4);
  const original = (await app.state()).objects[0]; expect(original.height).toBe(130);
  await object.getByRole('button', { name: /Play audio/ }).click(); await expect.poll(() => object.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(.1);
  expect((await app.state()).objects[0].version).toBe(original.version);
  await object.getByRole('button', { name: /Expand audio/ }).click(); await expect.poll(async () => (await app.state()).objects[0].height).toBe(220);
  const expandedVersion = (await app.state()).objects[0].version; await page.waitForTimeout(200); expect((await app.state()).objects[0].version).toBe(expandedVersion);
  await object.locator('.object-caption').click(); await page.getByRole('button', { name: 'Annotate', exact: true }).click();
  await page.getByLabel('Audio annotation target', { exact: true }).selectOption('time'); const input = page.getByLabel('Add a comment', { exact: true }); await input.fill('Use this part of the sound.');
  await page.getByLabel('End time', { exact: true }).fill('4'); await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved'); await input.press('Escape'); await page.locator('#instruction').fill('Compose from this range'); await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect.poll(async () => (await app.state()).tasks.length).toBe(1); const saved = await app.state(), annotation = saved.tasks[0].snapshot.annotations[0];
  expect(annotation.timeStart).toBeGreaterThan(0); expect(annotation.timeEnd).toBe(4); expect(annotation.snapshotAssetId).toBeUndefined(); expect(annotation.bounds).toEqual({ x: 0, y: 0, width: 1, height: 1 }); expect(saved.tasks[0].snapshot.referenceContent.assets).toHaveLength(1); expect(saved.tasks[0].snapshot.referenceContent.assets[0].mime).toBe('audio/wav');
  await page.getByRole('button', { name: 'Edit request 1', exact: true }).click(); await page.locator('.annotation-content').first().click();
  const edit = page.getByLabel('Annotation text', { exact: true }); await edit.fill('Use this revised sound range.'); await page.getByLabel('End time', { exact: true }).fill('3.8'); await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved'); await edit.press('Escape'); await page.getByRole('button', { name: 'Save edit', exact: true }).click();
  await expect.poll(async () => (await app.state()).tasks[0].snapshot.annotations[0].text).toBe('Use this revised sound range.');
  const edited = (await app.state()).tasks[0].snapshot.annotations[0]; expect(edited.id).toBe(annotation.id); expect(edited.assetId).toBe(annotation.assetId); expect(edited.timeStart).toBe(annotation.timeStart); expect(edited.timeEnd).toBe(3.8); expect(edited.snapshotAssetId).toBeUndefined();
  await page.screenshot({ path: info.outputPath('audio-range-reference.png') });
});

test('HTML runs explicitly, exits interaction through trusted bridge and stops outside the frame', async ({ page, app }, info) => {
  const source = '<!doctype html><html><body><h1>Counter</h1><button id="count" onclick="this.textContent=Number(this.textContent)+1">0</button><input aria-label="Label"><script>window.parent.postMessage({type:"arbitrary-command"},"*")</script></body></html>';
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'counter.html', mimeType: 'text/html', buffer: Buffer.from(source) });
  const object = page.locator('.board-object[data-content-kind="html"]'); await expect(object.getByRole('button', { name: 'Run preview', exact: true })).toBeVisible(); await expect(object.locator('iframe')).toHaveCount(0);
  await object.getByRole('button', { name: 'Run preview', exact: true }).click(); await expect(object.locator('iframe')).toHaveCount(1); await expect(object.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await object.locator('.object-caption').click(); const world = await page.locator('.canvas-world').getAttribute('style'); await page.getByRole('button', { name: 'Interact with content', exact: true }).click();
  const frame = object.frameLocator('iframe'); await frame.getByRole('button', { name: '0', exact: true }).click(); await expect(frame.getByRole('button', { name: '1', exact: true })).toBeVisible(); await frame.getByLabel('Label').fill('Draft state'); expect(await page.locator('.canvas-world').getAttribute('style')).toBe(world);
  await frame.getByLabel('Label').press('Escape'); await expect(object).not.toHaveAttribute('data-interacting', 'true');
  await object.getByRole('button', { name: 'Stop HTML preview', exact: true }).click(); await expect(object.locator('iframe')).toHaveCount(0); await object.getByRole('button', { name: 'Run preview', exact: true }).click(); await expect(frame.getByRole('button', { name: '0', exact: true })).toBeVisible(); await expect(frame.getByLabel('Label')).toHaveValue('');
  expect((await app.state()).assets).toHaveLength(1); await page.screenshot({ path: info.outputPath('html-isolated-counter.png') });
});

test('file input, paste, drop and CLI share multimodal fallback without changing bytes', async ({ page, app }) => {
  const source = '# Imported notes\n\nKeep the source.';
  await page.evaluate(source => {
    const transfer = new DataTransfer(); transfer.items.add(new File([source], 'pasted.markdown'));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, source);
  await expect(page.locator('.board-object[data-content-kind="markdown"]')).toHaveCount(1);
  await page.evaluate(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['<!doctype html><button>Imported counter</button>'], 'dropped.htm', { type: 'application/octet-stream' }));
    document.querySelector('#whiteboard')!.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: 850, clientY: 400 }));
  });
  await expect(page.locator('.board-object[data-content-kind="html"]')).toHaveCount(1);
  const path = join(app.root, 'cli-notes.MD'); await writeFile(path, source);
  const { stdout } = await promisify(execFile)(resolve('.runtime/node_modules/node/bin/node'), [resolve('dist/src/cli.js'), 'asset', 'import', '--project', app.root, '--url', app.url, '--file', path]);
  const asset = JSON.parse(stdout); expect(asset.mime).toBe('text/markdown'); expect(asset.kind).toBe('file');
  const state = await app.state(); expect(state.assets.find(value => value.name === 'pasted.markdown')?.mime).toBe('text/markdown'); expect(state.assets.find(value => value.name === 'dropped.htm')?.mime).toBe('text/html');
  const imported = await page.request.get(`${app.url}/api/assets/${asset.id}/content`); expect(await imported.text()).toBe(source);
});

test('HTML origin changes request an explicit board reload and preserve the draft', async ({ page, app }) => {
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'restart.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><button>Ready</button>') });
  const origin = await page.locator('meta[name="acanvas-html-preview-origin"]').getAttribute('content'); expect(origin).toBeTruthy();
  await page.locator('#instruction').fill('Keep this unsent request.'); await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  await app.restart(); await page.locator('.board-object').getByRole('button', { name: 'Run preview', exact: true }).click();
  await expect(page.getByText('Reload the board to run HTML preview.', { exact: true })).toBeVisible(); await expect(page.locator('iframe')).toHaveCount(0); await expect(page.locator('#instruction')).toHaveValue('Keep this unsent request.');
  await page.getByRole('button', { name: 'Reload board', exact: true }).click(); await expect(page.locator('#instruction')).toHaveValue('Keep this unsent request.');
  expect(await page.locator('meta[name="acanvas-html-preview-origin"]').getAttribute('content')).not.toBe(origin);
  await page.locator('.board-object').getByRole('button', { name: 'Run preview', exact: true }).click(); await expect(page.locator('iframe')).toHaveCount(1); await expect(page.frameLocator('iframe').getByRole('button', { name: 'Ready', exact: true })).toBeVisible();
});

test('removed task sources use the shared document audio and HTML detail renderers', async ({ page, app }) => {
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles([
    { name: 'detail.md', mimeType: 'text/markdown', buffer: Buffer.from('# Source notes\n\nRead the original.') },
    { name: 'detail.wav', mimeType: 'audio/wav', buffer: toneWav(3) },
    { name: 'detail.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><button>Original HTML</button>') },
  ]);
  await expect(page.locator('.board-object')).toHaveCount(3); const initial = await app.state();
  const draft = await app.call(`/api/sessions/${initial.session.id}/draft`, 'PUT', { ...initial.draft, text: 'Read these original sources.', attachments: initial.assets.map(asset => asset.id), references: { ...initial.draft.references, objectIds: initial.objects.map(object => object.id) } });
  await app.call(`/api/sessions/${initial.session.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision });
  await app.call('/api/board/operations', 'POST', { sessionId: initial.session.id, operations: initial.objects.map(object => ({ type: 'delete', objectId: object.id, expectedVersion: object.version })) });
  await expect(page.locator('.board-object')).toHaveCount(0); await page.locator('.queue-task').first().click();
  await page.getByRole('button', { name: 'View detail.md', exact: true }).click(); const preview = page.locator('.task-media-preview'); await expect(preview.locator('h1')).toHaveText('Source notes'); await preview.getByRole('button', { name: 'Close media preview', exact: true }).click(); await expect(preview).toHaveCount(0);
  await page.getByRole('button', { name: 'View detail.wav', exact: true }).click(); await expect(preview.locator('audio')).toHaveCount(1); await preview.getByRole('button', { name: 'Collapse audio player', exact: true }).click(); await expect(preview.locator('.audio-canvas-player')).toHaveAttribute('data-expanded', 'false'); await preview.getByRole('button', { name: 'Close media preview', exact: true }).click();
  await page.getByRole('button', { name: 'View detail.html', exact: true }).click(); await expect(preview.locator('iframe')).toHaveCount(0); await preview.getByRole('button', { name: 'Run preview', exact: true }).click(); await expect(preview.frameLocator('iframe').getByRole('button', { name: 'Original HTML', exact: true })).toBeVisible(); await preview.getByRole('button', { name: 'Close media preview', exact: true }).click(); await expect(page.locator('iframe')).toHaveCount(0);
  const saved = await app.state(); expect(saved.tasks[0].snapshot.referenceContent.assets.map(asset => asset.id)).toEqual(initial.assets.map(asset => asset.id)); expect(saved.tasks[0].snapshot.referenceContent.objects).toHaveLength(3);
});

for (const [extension, mime] of [['mp3', 'audio/mpeg'], ['m4a', 'audio/mp4']]) test(`${extension.toUpperCase()} decodes plays seeks and exposes real spectrum in Chrome`, async ({ page, app }, info) => {
  const buffer = await readFile(resolve(`tests/fixtures/reference-tone.${extension}`));
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: `reference-tone.${extension}`, mimeType: 'application/octet-stream', buffer });
  const object = page.locator('.board-object[data-content-kind="audio"]'), audio = object.locator('audio');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration)).toBeGreaterThan(3.5);
  await object.getByRole('button', { name: 'Play audio', exact: true }).click(); await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(.1);
  await expect.poll(() => object.locator('.audio-frequency-bar').evaluateAll(elements => Math.max(...elements.map(element => Number((element as HTMLElement).style.getPropertyValue('--level')))))).toBeGreaterThan(.1);
  await object.getByRole('button', { name: 'Pause audio', exact: true }).click(); const timeline = object.getByRole('slider', { name: 'Audio timeline', exact: true }); await timeline.focus(); await timeline.press('Home');
  for (let index = 0; index < 20; index++) await timeline.press('ArrowRight');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(1.8);
  const state = await app.state(); expect(state.assets[0].mime).toBe(mime); expect(state.objects[0].version).toBe(1);
  const response = await page.request.get(`${app.url}/api/assets/${state.assets[0].id}/content`, { headers: { Range: 'bytes=0-99' } }); expect(response.status()).toBe(206); expect(response.headers()['content-type']).toBe(mime); expect((await response.body()).equals(buffer.subarray(0, 100))).toBeTruthy();
  await page.screenshot({ path: info.outputPath(`${extension}-real-playback.png`) });
});

test('standard play cancellation retains audio and an old rejection preserves newer playback', async ({ page, app }, info) => {
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'interrupted-tone.wav', mimeType: 'audio/wav', buffer: toneWav() });
  const object = page.locator('.board-object[data-content-kind="audio"]'); await expect(object.getByRole('button', { name: 'Play audio', exact: true })).toBeEnabled();
  await object.locator('audio').evaluate((audio: HTMLAudioElement) => {
    const nativePlay = audio.play.bind(audio); let first = true;
    audio.play = () => {
      if (!first) return nativePlay(); first = false;
      return new Promise<void>((_resolve, reject) => { (window as any).cancelPendingPlay = () => reject(new DOMException('The play request was interrupted by pause().', 'AbortError')); });
    };
  });
  await object.getByRole('button', { name: 'Play audio', exact: true }).click(); await page.waitForFunction(() => typeof (window as any).cancelPendingPlay === 'function'); await page.evaluate(() => (window as any).cancelPendingPlay());
  await page.waitForTimeout(80); await expect(object.locator('audio')).toHaveCount(1); await expect(object.locator('.file-card')).toHaveCount(0);
  await object.locator('audio').evaluate((audio: HTMLAudioElement) => {
    const nativePlay = audio.play.bind(audio); let first = true;
    audio.play = () => {
      if (!first) return nativePlay(); first = false;
      return new Promise<void>((_resolve, reject) => { (window as any).cancelOldPlay = () => reject(new DOMException('A previous play request was interrupted.', 'AbortError')); });
    };
  });
  await object.getByRole('button', { name: 'Play audio', exact: true }).click(); await page.waitForFunction(() => typeof (window as any).cancelOldPlay === 'function'); await object.getByRole('button', { name: 'Play audio', exact: true }).click();
  await expect.poll(() => object.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(.1);
  await page.evaluate(() => (window as any).cancelOldPlay()); await expect(object.getByRole('button', { name: 'Pause audio', exact: true })).toBeVisible();
  await expect.poll(() => object.locator('.audio-frequency-bar').evaluateAll(elements => Math.max(...elements.map(element => Number((element as HTMLElement).style.getPropertyValue('--level')))))).toBeGreaterThan(.1);
  expect((await app.state()).objects[0].version).toBe(1);
  await writeFile(info.outputPath('play-cancellation-contract.json'), JSON.stringify({ scope: 'WHATWG AbortError cancellation contract; native second playback, clock and FFT', retainsAudio: await object.locator('audio').count(), retainsPlayback: await object.locator('audio').evaluate((audio: HTMLAudioElement) => !audio.paused) }, null, 2));
});

test('audio form changes keep outer height and internal timeline continuous', async ({ page, app }, info) => {
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'morph-tone.wav', mimeType: 'audio/wav', buffer: toneWav() });
  const object = page.locator('.board-object[data-content-kind="audio"]'); await expect(object.locator('.audio-canvas-player')).toBeVisible();
  const record = async (target = object) => target.evaluate(element => {
    const node = element as HTMLElement, player = node.matches('.audio-canvas-player') ? node : node.querySelector<HTMLElement>('.audio-canvas-player')!, timeline = node.querySelector<HTMLElement>('.audio-player-timeline')!;
    const samples: { t: number; height: number; timeline: number; morph: string }[] = [], started = performance.now();
    const sample = () => { const rect = node.getBoundingClientRect(); samples.push({ t: performance.now() - started, height: rect.height, timeline: timeline.getBoundingClientRect().top - rect.top, morph: getComputedStyle(player).getPropertyValue('--audio-morph') }); };
    sample(); const observer = new MutationObserver(sample); observer.observe(player, { attributes: true, attributeFilter: ['data-expanded'] });
    const step = () => { sample(); if (performance.now() - started < 650) requestAnimationFrame(step); else observer.disconnect(); }; requestAnimationFrame(step);
    (window as any).audioMorphSamples = samples;
  });
  await record(); await object.getByRole('button', { name: 'Expand audio player', exact: true }).click(); await page.waitForTimeout(700); const opening = await page.evaluate(() => (window as any).audioMorphSamples);
  await record(); await object.getByRole('button', { name: 'Collapse audio player', exact: true }).click(); await page.waitForTimeout(700); const closing = await page.evaluate(() => (window as any).audioMorphSamples);
  expect((await app.state()).objects[0].version).toBe(3);
  const state = await app.state(), draft = await app.call(`/api/sessions/${state.session.id}/draft`, 'PUT', { ...state.draft, text: 'Read this sound.', attachments: [state.assets[0].id] });
  await app.call(`/api/sessions/${state.session.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision }); await app.call('/api/board/operations', 'POST', { sessionId: state.session.id, operations: [{ type: 'delete', objectId: state.objects[0].id, expectedVersion: 3 }] });
  await expect(object).toHaveCount(0); await page.locator('.queue-task').first().click(); await page.getByRole('button', { name: 'View morph-tone.wav', exact: true }).click();
  const detail = page.locator('.task-media-preview .audio-canvas-player');
  await record(detail); await detail.getByRole('button', { name: 'Collapse audio player', exact: true }).click(); await page.waitForTimeout(700); const detailClosing = await page.evaluate(() => (window as any).audioMorphSamples);
  await record(detail); await detail.getByRole('button', { name: 'Expand audio player', exact: true }).click(); await page.waitForTimeout(700); const detailOpening = await page.evaluate(() => (window as any).audioMorphSamples);
  await writeFile(info.outputPath('audio-form-geometry.json'), JSON.stringify({ opening, closing, detailOpening, detailClosing }, null, 2));
  for (const samples of [opening, closing, detailOpening, detailClosing]) {
    expect(Math.max(...samples.slice(1).map((sample: any, index: number) => Math.abs(sample.height - samples[index].height)))).toBeLessThan(25);
    expect(Math.max(...samples.slice(1).map((sample: any, index: number) => Math.abs(sample.timeline - samples[index].timeline)))).toBeLessThan(25);
  }
  expect(opening.at(-1).height).toBeCloseTo(220, 1); expect(closing.at(-1).height).toBeCloseTo(130, 1); expect(detailOpening.at(-1).height).toBeCloseTo(220, 1); expect(detailClosing.at(-1).height).toBeCloseTo(130, 1);
});

test('a background HTML instance exits only its own active content interaction', async ({ page, app }) => {
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles([
    { name: 'foreground.md', mimeType: 'text/markdown', buffer: Buffer.from('# Foreground notes\n\nRead this brief.') },
    { name: 'background.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><input aria-label="Palette name">') },
  ]);
  await expect(page.locator('.board-object')).toHaveCount(2); const initial = await app.state();
  await app.call('/api/board/operations', 'POST', { sessionId: initial.session.id, operations: initial.objects.map((object, index) => ({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: 140 + index * 550, y: 160 } })) });
  const html = page.locator('.board-object[data-content-kind="html"]'), markdown = page.locator('.board-object[data-content-kind="markdown"]'); await html.getByRole('button', { name: 'Run preview', exact: true }).click(); await expect(html.locator('.html-content')).toHaveAttribute('data-preview-ready', 'true');
  await markdown.locator('.object-caption').click(); await page.getByRole('button', { name: 'Interact with content', exact: true }).click(); await expect(markdown).toHaveAttribute('data-interacting', 'true');
  const frame = page.frames().find(frame => frame.url().includes('/preview/'))!;
  await frame.evaluate(() => parent.postMessage({ type: 'acanvas:preview-exit', instanceId: location.pathname.split('/').at(-1) }, '*'));
  await page.waitForTimeout(80); await expect(markdown).toHaveAttribute('data-interacting', 'true'); await page.getByRole('button', { name: 'Exit content', exact: true }).click();
  await html.locator('.object-caption').click(); await page.getByRole('button', { name: 'Interact with content', exact: true }).click(); await html.frameLocator('iframe').getByLabel('Palette name').press('Escape'); await expect(html).not.toHaveAttribute('data-interacting', 'true');
});
