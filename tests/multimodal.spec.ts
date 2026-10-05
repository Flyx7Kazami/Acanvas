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

test('Markdown reads safely with direct selection and scrolling and persists whole original references', async ({ page, app }, info) => {
  const source = '# Field notes\n\nA **clear** paragraph.\n\n- First item\n- Second item\n\n> Quiet contrast\n\n```js\nconst count = 2;\n```\n\n[Source](https://example.com)\n\n[Unsafe](javascript:alert(1))\n\n<img src=x onerror="window.mdInjected=true">\n\n![Diagram](https://example.com/tracker.png)\n\n' + 'Further observations.\n\n'.repeat(50);
  let externalLoads = 0; page.on('request', request => { if (request.url().startsWith('https://example.com/tracker')) externalLoads++; });
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'field-notes.md', mimeType: 'text/plain', buffer: Buffer.from(source) });
  const object = page.locator('.board-object[data-content-kind="markdown"]'); await expect(object).toBeVisible(); await expect(object.locator('h1')).toHaveText('Field notes');
  await expect(object.locator('strong')).toHaveText('clear'); await expect(object.locator('img')).toHaveCount(0); await expect(object.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).mdInjected)).toBeUndefined(); expect(externalLoads).toBe(0);
  await object.locator('.object-caption').click(); const state = await app.state(), original = state.objects[0], originalAsset = state.assets[0];
  const world = await page.locator('.canvas-world').getAttribute('style'); await expect(page.getByRole('button', { name: 'Interact with content', exact: true })).toHaveCount(0);
  const document = object.locator('.markdown-content'); await document.hover(); await page.mouse.wheel(0, 220); await expect.poll(() => document.evaluate(element => element.scrollTop)).toBeGreaterThan(0); expect(await page.locator('.canvas-world').getAttribute('style')).toBe(world);
  await document.focus(); await document.press('Escape');
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

test('audio plays real media in one row and saves explicit time range without frames', async ({ page, app }, info) => {
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'reference-tone.wav', mimeType: 'application/octet-stream', buffer: toneWav() });
  const object = page.locator('.board-object[data-content-kind="audio"]'); await expect(object.locator('audio')).toHaveCount(1);
  await expect.poll(() => object.locator('audio').evaluate((audio: HTMLAudioElement) => audio.duration)).toBeGreaterThan(4);
  const original = (await app.state()).objects[0]; expect(original.height).toBe(88);
  await object.getByRole('button', { name: /Play audio/ }).click(); await expect.poll(() => object.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(.1);
  expect((await app.state()).objects[0].version).toBe(original.version);
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

test('HTML runs explicitly with direct controls and stops outside the frame', async ({ page, app }, info) => {
  const source = '<!doctype html><html><body><h1>Counter</h1><button id="count" onclick="this.textContent=Number(this.textContent)+1">0</button><input aria-label="Label"><script>window.parent.postMessage({type:"arbitrary-command"},"*")</script></body></html>';
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'counter.html', mimeType: 'text/html', buffer: Buffer.from(source) });
  const object = page.locator('.board-object[data-content-kind="html"]'); await expect(object.getByRole('button', { name: 'Run preview', exact: true })).toBeVisible(); await expect(object.locator('iframe')).toHaveCount(0);
  await object.getByRole('button', { name: 'Run preview', exact: true }).click(); await expect(object.locator('iframe')).toHaveCount(1); await expect(object.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await object.locator('.object-caption').click(); const world = await page.locator('.canvas-world').getAttribute('style');
  const frame = object.frameLocator('iframe'); await frame.getByRole('button', { name: '0', exact: true }).click(); await expect(frame.getByRole('button', { name: '1', exact: true })).toBeVisible(); await frame.getByLabel('Label').fill('Draft state'); expect(await page.locator('.canvas-world').getAttribute('style')).toBe(world);
  await frame.getByLabel('Label').press('Escape'); await expect(page.getByRole('button', { name: 'Exit content', exact: true })).toHaveCount(0);
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
  await page.getByRole('button', { name: 'View detail.wav', exact: true }).click(); await expect(preview.locator('audio')).toHaveCount(1); await expect(preview.getByRole('button', { name: 'Expand audio player' })).toHaveCount(0); await preview.getByRole('button', { name: 'Close media preview', exact: true }).click();
  await page.getByRole('button', { name: 'View detail.html', exact: true }).click(); await expect(preview.locator('iframe')).toHaveCount(0); await preview.getByRole('button', { name: 'Run preview', exact: true }).click(); await expect(preview.frameLocator('iframe').getByRole('button', { name: 'Original HTML', exact: true })).toBeVisible(); await preview.getByRole('button', { name: 'Close media preview', exact: true }).click(); await expect(page.locator('iframe')).toHaveCount(0);
  const saved = await app.state(); expect(saved.tasks[0].snapshot.referenceContent.assets.map(asset => asset.id)).toEqual(initial.assets.map(asset => asset.id)); expect(saved.tasks[0].snapshot.referenceContent.objects).toHaveLength(3);
});

for (const [extension, mime] of [['mp3', 'audio/mpeg'], ['m4a', 'audio/mp4']]) test(`${extension.toUpperCase()} decodes plays seeks and exposes real amplitude in Chrome`, async ({ page, app }, info) => {
  const buffer = await readFile(resolve(`tests/fixtures/reference-tone.${extension}`));
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: `reference-tone.${extension}`, mimeType: 'application/octet-stream', buffer });
  const object = page.locator('.board-object[data-content-kind="audio"]'), audio = object.locator('audio');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration)).toBeGreaterThan(3.5);
  await object.getByRole('button', { name: 'Play audio', exact: true }).click(); await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(.1);
  await expect.poll(() => object.locator('canvas').evaluate(element => Number(element.dataset.maximumRms))).toBeGreaterThan(.06);
  expect(Number(await object.locator('canvas').getAttribute('data-maximum-rms'))).toBeLessThan(.11);
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
  await expect.poll(() => object.locator('canvas').evaluate(element => Number(element.dataset.maximumRms))).toBeGreaterThan(.1);
  expect((await app.state()).objects[0].version).toBe(1);
  await writeFile(info.outputPath('play-cancellation-contract.json'), JSON.stringify({ scope: 'WHATWG AbortError cancellation contract; native second playback, clock and time-domain amplitude', retainsAudio: await object.locator('audio').count(), retainsPlayback: await object.locator('audio').evaluate((audio: HTMLAudioElement) => !audio.paused) }, null, 2));
});

test('Markdown and HTML interact directly and all four resize corners adjust independent dimensions', async ({ page, app }, info) => {
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles([
    { name: 'long-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Long notes\n\n' + Array.from({ length: 80 }, (_, index) => `Observation ${index + 1}: quiet colors and generous spacing make a clear reading rhythm.\n\n`).join('')) },
    { name: 'palette.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><h1>Palette notes</h1><button onclick="this.textContent=\'Selected\'">Choose</button><input aria-label="Palette name">') },
  ]);
  await expect(page.locator('.board-object')).toHaveCount(2); let state = await app.state();
  await app.call('/api/board/operations', 'POST', { sessionId: state.session.id, operations: state.objects.map((object, index) => ({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: 140 + index * 560, y: 160, width: 420, height: 320 } })) });
  const md = page.locator('.board-object[data-content-kind="markdown"]'), html = page.locator('.board-object[data-content-kind="html"]');
  await expect(page.getByRole('button', { name: 'Interact with content', exact: true })).toHaveCount(0); await expect(page.locator('.content-layout-shield')).toHaveCount(0);
  await md.locator('.object-caption').click(); const before = await app.state(), camera = await page.locator('.canvas-world').getAttribute('style');
  const paragraph = md.locator('.markdown-body p').first(), textBox = (await paragraph.boundingBox())!;
  await page.mouse.move(textBox.x + 2, textBox.y + 8); await page.mouse.down(); await page.mouse.move(textBox.x + 160, textBox.y + 8, { steps: 8 }); await page.mouse.up();
  expect(await page.evaluate(() => getSelection()?.toString())).toContain('Observation'); expect((await app.state()).objects[0]).toEqual(before.objects[0]);
  const document = md.locator('.markdown-content'); await document.hover(); await page.mouse.wheel(0, 250); await expect.poll(() => document.evaluate(element => element.scrollTop)).toBeGreaterThan(0); expect(await page.locator('.canvas-world').getAttribute('style')).toBe(camera);
  const scrollHit = await document.evaluate(element => { const rect = element.getBoundingClientRect(); return !!window.document.elementFromPoint(rect.right - 3, rect.top + 30)?.closest('.object-drag-edge'); }); expect(scrollHit).toBe(false);
  await html.getByRole('button', { name: 'Run preview', exact: true }).click(); await html.frameLocator('iframe').getByRole('button', { name: 'Choose', exact: true }).click(); await expect(html.frameLocator('iframe').getByRole('button', { name: 'Selected', exact: true })).toBeVisible(); await html.frameLocator('iframe').getByLabel('Palette name').fill('Haze'); expect(await page.locator('.canvas-world').getAttribute('style')).toBe(camera);
  for (const node of [md, html]) {
    await node.locator('.object-caption').click();
    for (const corner of ['nw', 'ne', 'sw', 'se']) for (const axis of ['x', 'y']) {
      const id = await node.getAttribute('data-object-id'), original = (await app.state()).objects.find(object => object.id === id)!;
      const handle = node.locator(`[data-resize-corner="${corner}"]`), box = (await handle.boundingBox())!;
      const dx = axis === 'x' ? corner.endsWith('w') ? -22 : 22 : 0, dy = axis === 'y' ? corner.startsWith('n') ? -18 : 18 : 0;
      await page.keyboard.down('Alt'); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 }); await page.mouse.up(); await page.keyboard.up('Alt');
      await expect.poll(async () => (await app.state()).objects.find(object => object.id === id)!.version).toBe(original.version + 1);
      const resized = (await app.state()).objects.find(object => object.id === id)!; expect(resized.width).toBeCloseTo(original.width + (axis === 'x' ? 22 : 0), 2); expect(resized.height).toBeCloseTo(original.height + (axis === 'y' ? 18 : 0), 2);
    }
    const edge = node.locator('.object-drag-edge.drag-edge-top'), box = (await edge.boundingBox())!, id = await node.getAttribute('data-object-id'), original = (await app.state()).objects.find(object => object.id === id)!;
    await page.keyboard.down('Alt'); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2 + 15, { steps: 6 }); await page.mouse.up(); await page.keyboard.up('Alt');
    await expect.poll(async () => (await app.state()).objects.find(object => object.id === id)!.version).toBe(original.version + 1);
    const moved = (await app.state()).objects.find(object => object.id === id)!; expect(moved.x).toBeCloseTo(original.x + 25, 2); expect(moved.y).toBeCloseTo(original.y + 15, 2);
  }
  await page.screenshot({ path: info.outputPath('direct-document-resize.png') });
});

test('mixed Markdown and HTML group annotation saves one comment and preserves full sources through edits and removal', async ({ page, app }, info) => {
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles([
    { name: 'group-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Group notes\n\nQuiet colors.') },
    { name: 'group-palette.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><button>Haze</button>') },
  ]);
  await expect(page.locator('.board-object')).toHaveCount(2); const initial = await app.state();
  await app.call('/api/board/operations', 'POST', { sessionId: initial.session.id, operations: initial.objects.map((object, index) => ({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: 180 + index * 470, y: 180 } })) });
  const nodes = page.locator('.board-object'); await nodes.nth(0).locator('.object-caption').click(); await nodes.nth(1).locator('.object-caption').click({ modifiers: ['Shift'] }); await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Annotate', exact: true }).click(); await page.getByLabel('Add a comment', { exact: true }).fill('Use these two complete references together.'); await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  const created = await app.state(), annotation = created.draft.annotations[0]; expect(annotation.scope).toBe('group'); expect(annotation.objectIds).toHaveLength(2); expect(annotation.objectId).toBeUndefined(); expect(annotation.assetId).toBeUndefined(); expect(annotation.timeStart).toBeUndefined(); expect(annotation.snapshotAssetId).toBeUndefined(); await expect(page.locator('.annotation-outline')).toHaveCount(0);
  await page.getByLabel('Add a comment', { exact: true }).press('Escape');
  await page.waitForTimeout(320); const pin = page.locator('.canvas-annotation-group .annotation-pin').first(), originalPin = (await pin.boundingBox())!;
  await app.call('/api/board/operations', 'POST', { sessionId: initial.session.id, operations: created.objects.map(object => ({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: object.x + 35, y: object.y + 20 } })) });
  await expect.poll(async () => (await pin.boundingBox())!.x).toBeCloseTo(originalPin.x + 35, 1); await expect.poll(async () => (await pin.boundingBox())!.y).toBeCloseTo(originalPin.y + 20, 1); expect((await app.state()).draft.annotations[0]).toEqual(annotation);
  await page.locator('#instruction').fill('Compose from this set.'); await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect.poll(async () => (await app.state()).tasks.length).toBe(1);
  const sent = (await app.state()).tasks[0]; expect(sent.snapshot.annotations).toHaveLength(1); expect(sent.snapshot.referenceContent.assets).toHaveLength(2); expect(sent.snapshot.referenceContent.objects).toHaveLength(2);
  await page.getByRole('button', { name: 'Edit request 1', exact: true }).click(); await page.locator('.annotation-content').first().click(); await page.getByLabel('Annotation text', { exact: true }).fill('Keep these complete references as one set.'); await page.getByLabel('Annotation text', { exact: true }).press('Escape'); await page.getByRole('button', { name: 'Save edit', exact: true }).click();
  await expect.poll(async () => (await app.state()).tasks[0].snapshot.annotations[0].text).toBe('Keep these complete references as one set.'); const edited = (await app.state()).tasks[0].snapshot.annotations[0]; expect(edited).toEqual({ ...sent.snapshot.annotations[0], text: 'Keep these complete references as one set.' });
  const current = await app.state(); await app.call('/api/board/operations', 'POST', { sessionId: initial.session.id, operations: [{ type: 'delete', objectId: current.objects[0].id, expectedVersion: current.objects[0].version }] }); await page.reload(); await page.locator('.queue-task').first().click();
  const group = page.locator('.task-reference-group[data-annotation-id]').first(); await expect(group.locator('.task-reference-source')).toHaveCount(2); await expect(group.locator('.task-annotation-text')).toContainText('Keep these complete references'); expect((await app.state()).tasks[0].snapshot.annotations[0]).toEqual(edited);
  await page.screenshot({ path: info.outputPath('mixed-group-reference.png') });
});

test('real embedded MP3 and M4A covers share stable canvas and thumbnail sources while playback stays native', async ({ page, app }) => {
  let artworkHeads = 0; page.on('request', request => { if (request.method() === 'HEAD' && request.url().endsWith('/artwork')) artworkHeads++; });
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles([{ name: 'without-cover.wav', mimeType: 'audio/wav', buffer: toneWav() }, ...await Promise.all(['mp3', 'm4a'].map(async extension => ({ name: `artwork.${extension}`, mimeType: 'application/octet-stream', buffer: await readFile(resolve(`tests/fixtures/amplitude-cover.${extension}`)) })))]);
  const nodes = page.locator('.board-object[data-content-kind="audio"]'); await expect(nodes).toHaveCount(3); const layout = await app.state(); await app.call('/api/board/operations', 'POST', { sessionId: layout.session.id, operations: layout.objects.map((object, index) => ({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: 140 + (index % 2) * 520, y: 180 + Math.floor(index / 2) * 180 } })) }); await expect(nodes.nth(0).locator('.audio-player-cover')).toHaveCount(0); await expect(nodes.nth(2).locator('.audio-player-cover')).toBeVisible(); await expect(nodes.nth(1).locator('.audio-player-cover')).toBeVisible();
  const first = await nodes.nth(2).locator('.audio-player-cover').getAttribute('src'), second = await nodes.nth(1).locator('.audio-player-cover').getAttribute('src'); expect(first).not.toBe(second);
  for (let index = 1; index < 3; index++) { await nodes.nth(index).getByRole('button', { name: 'Play audio', exact: true }).click(); await expect.poll(() => nodes.nth(index).locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(.1); await nodes.nth(index).getByRole('button', { name: 'Pause audio', exact: true }).click(); await nodes.nth(index).getByRole('slider', { name: 'Audio timeline' }).press('PageUp'); await expect.poll(() => nodes.nth(index).locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(11); await nodes.nth(index).locator('.object-caption').click(); await page.getByRole('button', { name: 'Attach to request', exact: true }).click(); }
  await expect(page.locator('.draft-asset .asset-thumb img')).toHaveCount(2); expect(artworkHeads).toBe(3); // one cached absent source and two real cover identities
  await expect.poll(async () => (await app.state()).draft.attachments.length).toBe(2); const state = await app.state(); expect(state.draft.attachments).toHaveLength(2); expect(state.assets).toHaveLength(3); expect(state.assets.every(asset => asset.mime.startsWith('audio/'))).toBeTruthy();
});

test('an explicit multi-image region drag previews the area and saves region instead of whole group', async ({ page, app }) => {
  const encoded = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100; const context = canvas.getContext('2d')!; context.fillStyle = '#a2b7b5'; context.fillRect(0, 0, 160, 100); return canvas.toDataURL().split(',')[1]; });
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(['first.png', 'second.png'].map(name => ({ name, mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') })));
  await expect(page.locator('.board-object')).toHaveCount(2); const state = await app.state(); await app.call('/api/board/operations', 'POST', { sessionId: state.session.id, operations: state.objects.map((object, index) => ({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: 160 + index * 380, y: 200, width: 300, height: 187.5 } })) });
  const nodes = page.locator('.board-object'); await nodes.nth(0).locator('.object-caption').click(); await nodes.nth(1).locator('.object-caption').click({ modifiers: ['Shift'] }); await page.getByRole('button', { name: 'Annotate', exact: true }).click(); await page.getByLabel('Add a comment', { exact: true }).fill('Use this shared image area.');
  await expect(page.locator('.annotation-outline')).toHaveCount(0); await page.mouse.move(200, 230); await page.mouse.down(); await page.mouse.move(780, 335, { steps: 10 }); await expect(page.locator('.editing-outline')).toBeVisible(); await page.mouse.up();
  await expect.poll(async () => (await app.state()).draft.annotations[0]?.scope).toBe('region'); const annotation = (await app.state()).draft.annotations[0]; expect(annotation.coordinateSpace).toBe('world'); expect(annotation.objectIds).toHaveLength(2); expect(annotation.bounds.width).toBeCloseTo(580, 1); expect(annotation.bounds.height).toBeCloseTo(105, 1);
});

test('single audio rows show real optional artwork and a rolling observed amplitude window', async ({ page, app }, info) => {
  await page.addInitScript(() => {
    const record: any = (window as any).playDiagnostics = { suspends: [], closes: [], states: [], mediaPauses: [] };
    const Native = AudioContext;
    window.AudioContext = class extends Native {
      constructor() { super(); (window as any).observedContext = this; this.addEventListener('statechange', () => record.states.push({ time: performance.now(), state: this.state })); }
      suspend() { record.suspends.push(new Error().stack); return super.suspend(); }
      close() { record.closes.push(new Error().stack); return super.close(); }
    };
    const pause = HTMLMediaElement.prototype.pause; HTMLMediaElement.prototype.pause = function() { record.mediaPauses.push({ time: this.currentTime, src: this.currentSrc, stack: new Error().stack }); return pause.call(this); };
  }); await page.reload(); await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');

  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles([
    { name: 'Tone study.wav', mimeType: 'audio/wav', buffer: toneWav(24) },
    { name: 'Amplitude study.mp3', mimeType: 'audio/mpeg', buffer: await readFile(resolve('tests/fixtures/amplitude-cover.mp3')) },
  ]);
  await expect(page.locator('.board-object')).toHaveCount(2); const initial = await app.state();
  await app.call('/api/board/operations', 'POST', { sessionId: initial.session.id, operations: initial.objects.map((object, index) => ({ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: 250, y: 270 + index * 180, width: 600, height: 88 } })) });
  const nodes = page.locator('.board-object[data-content-kind="audio"]'); await expect(nodes.nth(0).locator('.audio-player-cover')).toHaveCount(0); await expect(nodes.nth(1).locator('.audio-player-cover')).toBeVisible();
  await nodes.nth(0).screenshot({ path: info.outputPath('single-row-without-cover.png') }); await nodes.nth(1).screenshot({ path: info.outputPath('single-row-with-cover.png') });
  const cdp = await page.context().newCDPSession(page), mediaEvents: unknown[] = []; for (const name of ['Media.playerEventsAdded', 'Media.playerPropertiesChanged', 'Media.playerMessagesLogged']) cdp.on(name as any, value => mediaEvents.push({ name, value })); await cdp.send('Media.enable');
  await nodes.nth(1).locator('audio').evaluate((audio: HTMLAudioElement) => { const pause = audio.pause.bind(audio); (window as any).observedAudio = audio; (window as any).capturedAudioPauses = []; audio.pause = () => { (window as any).capturedAudioPauses.push({ time: audio.currentTime, stack: new Error().stack }); pause(); }; });
  await nodes.nth(1).getByRole('button', { name: 'Play audio', exact: true }).click();
  try { await expect.poll(() => nodes.nth(1).locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime), { timeout: 17000 }).toBeGreaterThan(13); }
  catch (error) { await writeFile(info.outputPath('native-media-events.json'), JSON.stringify(mediaEvents, null, 2)); await writeFile(info.outputPath('long-playback-diagnostic.json'), JSON.stringify(await nodes.nth(1).locator('audio').evaluate((audio: HTMLAudioElement) => ({ pauses: (window as any).capturedAudioPauses, time: audio.currentTime, paused: audio.paused, ended: audio.ended, ready: audio.readyState, duration: audio.duration, networkState: audio.networkState, bufferedEnd: audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0, contextState: (window as any).observedContext?.state, visibility: document.visibilityState, hiddenMediaStyle: getComputedStyle(audio).display, sameElement: audio === (window as any).observedAudio, diagnostics: (window as any).playDiagnostics, error: audio.error && { code: audio.error.code, message: audio.error.message } })), null, 2)); throw error; }
  const canvas = nodes.nth(1).locator('canvas'); expect(Number(await canvas.getAttribute('data-window-start'))).toBeGreaterThan(2.5); expect(Number(await canvas.getAttribute('data-observed'))).toBeGreaterThan(40);
  await nodes.nth(1).screenshot({ path: info.outputPath('single-row-playing-13s.png') }); await page.screenshot({ path: info.outputPath('audio-rows-real-covers.png') });
  const snapshot = await nodes.nth(1).locator('audio').evaluate((audio: HTMLAudioElement) => ({ paused: audio.paused, currentTime: audio.currentTime, duration: audio.duration })); await writeFile(info.outputPath('rolling-amplitude-capture.json'), JSON.stringify({ ...snapshot, windowStart: Number(await canvas.getAttribute('data-window-start')), observed: Number(await canvas.getAttribute('data-observed')) }, null, 2));
});

test('undecodable canvas audio keeps its download visible within the minimum row', async ({ page, app }, info) => {
  const original = Buffer.from('An undecodable owned audio sample');
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'broken-audio.wav', mimeType: 'audio/wav', buffer: original });
  const node = page.locator('.board-object[data-content-kind="audio"]'); await expect(node.locator('a[download]')).toHaveCount(1);
  const state = await app.state(); await app.call('/api/board/operations', 'POST', { sessionId: state.session.id, operations: [{ type: 'update', objectId: state.objects[0].id, expectedVersion: state.objects[0].version, changes: { width: 280, height: 72 } }] }); await expect(node).toHaveCSS('height', '72px');
  const link = node.locator('a[download]'), bounds = (await node.boundingBox())!, download = (await link.boundingBox())!;
  await writeFile(info.outputPath('audio-error-download-geometry.json'), JSON.stringify({ node: bounds, download }, null, 2));
  expect(download.y).toBeGreaterThanOrEqual(bounds.y); expect(download.y + download.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  const result = page.waitForEvent('download'); await link.click(); const file = await result; const path = info.outputPath('original-broken-audio.wav'); await file.saveAs(path); expect((await readFile(path)).equals(original)).toBeTruthy(); expect((await app.state()).assets).toHaveLength(1);
});
