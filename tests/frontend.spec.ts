import { test as base, expect, type Page } from '@playwright/test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import type { BoardState, Claim, Asset } from '../src/shared/types.js';

const runtime = resolve('.runtime/node_modules/node/bin/node');
const execute = promisify(execFile);
async function cli(args: string[]): Promise<any> {
  const { stdout } = await execute(runtime, [resolve('dist/src/cli.js'), ...args], { maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout);
}
async function startAppProcess(root: string, port = 0) {
  const child = spawn(runtime, [resolve('dist/src/server/main.js'), '--project', root, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  const url = await new Promise<string>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('The isolated service did not start.')), 10_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Service exited during startup: ${code}/${signal}`)); });
    child.stdout.on('data', chunk => { output += chunk.toString(); const address = output.match(/acanvas: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]; if (address) { clearTimeout(timer); resolveReady(address); } });
  });
  return { url, close: async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    expect(child.signalCode, errors).toBeNull(); expect(child.exitCode, errors).toBe(0);
    expect(errors).not.toContain('Assertion failed');
  } };
}
type AppFixture = { root: string; server: { url: string }; restart: (samePort?: boolean) => Promise<void>; replaceProject: () => Promise<string>; call: (path: string, method?: string, body?: unknown) => Promise<any>; state: (sessionId?: string) => Promise<BoardState> };
const test = base.extend<{ app: AppFixture }>({
  app: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'acanvas-browser-project-'));
    const additionalRoots: string[] = [];
    let running = await startAppProcess(root);
    const server = { url: running.url };
    let token = (await (await fetch(`${server.url}/api/bootstrap`)).json()).token;
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${server.url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(response.ok, `API ${method} ${path}`).toBeTruthy();
      return response.json();
    };
    const state = async (sessionId?: string) => call(`/api/state?sessionId=${sessionId || (await call('/api/sessions'))[0].id}`) as Promise<BoardState>;
    const restart = async (samePort = false) => { const port = samePort ? Number(new URL(server.url).port) : 0; await running.close(); running = await startAppProcess(root, port); server.url = running.url; token = (await (await fetch(`${server.url}/api/bootstrap`)).json()).token; };
    const replaceProject = async () => { const nextRoot = await mkdtemp(join(tmpdir(), 'acanvas-other-project-')); additionalRoots.push(nextRoot); const port = Number(new URL(server.url).port); await running.close(); running = await startAppProcess(nextRoot, port); server.url = running.url; token = (await (await fetch(`${server.url}/api/bootstrap`)).json()).token; return nextRoot; };
    try { await use({ root, server, restart, replaceProject, call, state }); }
    finally { await running.close(); await rm(root, { recursive: true, force: true }); for (const directory of additionalRoots) await rm(directory, { recursive: true, force: true }); }
  },
});

async function open(page: Page, app: AppFixture) {
  await page.goto(app.server.url);
  await expect(page.getByRole('heading', { name: '给想法一个空间' })).toBeVisible();
  await expect(page.locator('.connection-status')).toHaveText('已保存');
  expect(await page.locator('dialog:not([open])').evaluateAll(elements => elements.every(element => getComputedStyle(element).display === 'none'))).toBeTruthy();
}

async function png(page: Page) {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 300;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#e2e2e0'; context.fillRect(0, 0, 600, 300);
    context.fillStyle = '#252525'; context.fillRect(120, 60, 360, 180);
    context.fillStyle = '#fff'; context.font = '32px sans-serif'; context.fillText('Canvas reference', 155, 162);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') };
}

test('real image import, zoomed media annotation, move/resize, CLI publication and refresh', async ({ page, app }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page, app);
  const image = await png(page);
  await page.getByLabel('选择画布素材文件', { exact: true }).setInputFiles(image);
  const object = page.locator('.board-object').first();
  await expect(object).toBeVisible();
  await expect(object.locator('img')).toHaveJSProperty('naturalWidth', 600);
  await object.click({ position: { x: 80, y: 40 } });
  await page.getByRole('button', { name: '放大画布', exact: true }).click();
  await page.getByRole('button', { name: '绘制区域批注', exact: true }).click();
  const imageBox = (await object.locator('img').boundingBox())!;
  await page.mouse.move(imageBox.x + imageBox.width * .2, imageBox.y + imageBox.height * .2);
  await page.mouse.down();
  await page.mouse.move(imageBox.x + imageBox.width * .7, imageBox.y + imageBox.height * .6, { steps: 7 });
  await page.mouse.up();
  await expect(page.getByRole('dialog', { name: '添加批注', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '批注内容', exact: true }).fill('保留中部构图，增加呼吸感。');
  await page.getByRole('button', { name: '加入需求草稿', exact: true }).click();
  await expect(page.locator('.draft-annotation')).toHaveCount(1);
  const before = await app.state();
  const annotation = before.draft.annotations[0];
  expect(annotation.bounds.x).toBeCloseTo(.2, 1); expect(annotation.bounds.y).toBeCloseTo(.2, 1);
  expect(annotation.bounds.width).toBeCloseTo(.5, 1); expect(annotation.bounds.height).toBeCloseTo(.4, 1);
  await page.getByRole('button', { name: '选择素材', exact: true }).click();
  const box = (await object.boundingBox())!;
  await page.mouse.move(box.x + box.width * .8, box.y + box.height * .8); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .8 + 60, box.y + box.height * .8 + 30, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await app.state()).objects[0].version).toBe(2);
  const handle = page.getByRole('button', { name: '调整尺寸 reference.png', exact: true });
  await handle.focus(); await handle.press('ArrowRight');
  await expect.poll(async () => (await app.state()).objects[0].version).toBe(3);
  const currentBox = (await object.locator('img').boundingBox())!;
  const annotationBox = (await page.locator('.annotation-outline').boundingBox())!;
  expect((annotationBox.x - currentBox.x) / currentBox.width).toBeCloseTo(.2, 1);
  expect((annotationBox.y - currentBox.y) / currentBox.height).toBeCloseTo(.2, 1);
  await page.getByLabel('向 创作会话 发送需求', { exact: true }).fill('根据参考和批注生成一个新版本。');
  await page.getByRole('button', { name: '发送需求', exact: true }).click();
  await expect(page.locator('.task-card[data-status="queued"]')).toHaveCount(1);
  await expect(page.locator('.draft-annotation')).toHaveCount(0);
  const taskState = await app.state(), sessionId = taskState.session.id;
  const args = ['--project', app.root, '--url', app.server.url, '--session', sessionId];
  const claimed = await cli(['task', 'next', ...args, '--consumer', 'browser-agent']) as Claim;
  expect(claimed.task?.snapshot.annotations[0].text).toBe(annotation.text);
  const inputFile = join(app.root, 'input.png');
  await cli(['asset', 'read', ...args, '--asset', claimed.task!.snapshot.referenceContent.assets[0].id, '--out', inputFile]);
  const outputFile = join(app.root, 'output.png'); await writeFile(outputFile, image.buffer);
  const output = await cli(['asset', 'import', ...args, '--file', outputFile, '--mime', 'image/png', '--task', claimed.task!.id, '--run', claimed.run!.id, '--consumer', 'browser-agent']) as Asset;
  const completionFile = join(app.root, 'completion.json');
  await writeFile(completionFile, JSON.stringify({ summary: '参考图已回填到共享白板。', assetIds: [output.id], validation: ['读取了原图与发送时批注', '产物文件已保存'], operations: [{ type: 'create', object: { assetId: output.id, x: 800, y: 250, width: 300, height: 150 } }] }));
  await cli(['task', 'complete', ...args, '--task', claimed.task!.id, '--run', claimed.run!.id, '--consumer', 'browser-agent', '--input', completionFile]);
  await expect(page.locator('.board-object')).toHaveCount(2);
  await expect(page.locator('.task-card[data-status="completed"]')).toHaveCount(1);
  await expect(page.getByText('参考图已回填到共享白板。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '适配全部素材', exact: true }).click();
  await expect.poll(async () => (await app.state()).session.view.zoom).not.toBe(1.2);
  await expect(page.locator('.board-object img')).toHaveCount(2);
  await expect.poll(async () => page.locator('.board-object img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth === 600))).toBeTruthy();
  await page.locator('.board-object').first().focus(); await page.keyboard.press('Enter');
  await page.locator('.board-object').nth(1).focus(); await page.keyboard.press('Shift+Enter');
  await expect(page.locator('.board-object[data-selected=true]')).toHaveCount(2);
  await page.getByRole('button', { name: '附加到需求', exact: true }).click();
  await expect(page.locator('.draft-asset')).toHaveCount(2);
  await expect(page.locator('.draft-save')).toHaveText('已保存');
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('light-board.png') });
  await page.getByRole('button', { name: '切换暗色主题', exact: true }).click();
  await expect.poll(async () => page.locator('.session-button.active').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(48, 48, 48)');
  await page.locator('.board-object img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
  const pixels = await page.locator('.board-object img').evaluateAll(images => images.map(image => { const frame = document.createElement('canvas'); frame.width = 600; frame.height = 300; const context = frame.getContext('2d')!; context.drawImage(image as HTMLImageElement, 0, 0); return [...context.getImageData(130, 80, 1, 1).data]; }));
  expect(pixels).toEqual([[37,37,37,255], [37,37,37,255]]);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: info.outputPath('dark-board.png') });
  await page.reload(); await expect(page.locator('.board-object')).toHaveCount(2);
  await expect(page.locator('.task-card[data-status="completed"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('session and draft identity survive delayed saves, sends and refresh', async ({ page, app }) => {
  await open(page, app);
  const initial = await app.state(), firstId = initial.session.id;
  const second = await app.call('/api/sessions', 'POST', { name: '另一条探索' });
  await expect(page.getByRole('button', { name: '另一条探索', exact: true })).toBeVisible();
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  await page.route(`**/api/sessions/${firstId}/draft`, async route => {
    if (held) return route.continue(); held = true;
    const response = await route.fetch(); entered(); await delayed; await route.fulfill({ response });
  });
  await page.locator('#instruction').fill('第一会话的草稿'); await enteredPromise;
  await page.getByRole('button', { name: '另一条探索', exact: true }).click();
  await expect(page.locator('#instruction')).toHaveValue('');
  await page.locator('#instruction').fill('第二会话的新想法');
  release();
  await expect.poll(async () => (await app.state(second.id)).draft.text).toBe('第二会话的新想法');
  await expect(page.locator('#instruction')).toHaveValue('第二会话的新想法');
  await page.getByRole('button', { name: '创作会话', exact: true }).click();
  await expect(page.locator('#instruction')).toHaveValue('第一会话的草稿');
  await page.unroute(`**/api/sessions/${firstId}/draft`);
  let releaseSend!: () => void, saving!: () => void;
  const savingPromise = new Promise<void>(resolve => { saving = resolve; });
  const sendDelay = new Promise<void>(resolve => { releaseSend = resolve; });
  await page.route(`**/api/sessions/${firstId}/draft`, async route => { const response = await route.fetch(); saving(); await sendDelay; await route.fulfill({ response }); });
  await page.locator('#instruction').fill('发送这条完整需求');
  await page.getByRole('button', { name: '发送需求', exact: true }).click(); await savingPromise;
  await expect(page.locator('#instruction')).toBeDisabled();
  releaseSend(); await expect(page.locator('#instruction')).toBeEnabled(); await expect(page.locator('#instruction')).toHaveValue('');
  await expect.poll(async () => (await app.state(firstId)).draft.id).not.toBe(initial.draft.id);
  expect((await app.state(firstId)).tasks[0].snapshot.userRequest.text).toBe('发送这条完整需求');
  await page.locator('#instruction').fill('发送后的下一条草稿');
  await expect.poll(async () => (await app.state(firstId)).draft.text).toBe('发送后的下一条草稿');
  await expect(page.locator('.draft-save')).toHaveText('已保存');
  await page.reload(); await expect(page.locator('#instruction')).toHaveValue('发送后的下一条草稿');
  expect((await app.state(second.id)).draft.text).toBe('第二会话的新想法');
});

test('real video and file imports, time/frame annotations and decode fallback', async ({ page, app }) => {
  await open(page, app);
  await page.getByLabel('选择画布素材文件', { exact: true }).setInputFiles(resolve('tests/fixtures/frontend-video.mp4'));
  const video = page.locator('video'); await expect(video).toHaveJSProperty('videoWidth', 320);
  await video.evaluate(element => { (element as HTMLVideoElement).currentTime = .75; });
  await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.locator('.object-caption').first().click();
  await page.getByRole('button', { name: '添加批注', exact: true }).click();
  await expect(page.getByText('视频时间点 0:00', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '批注内容', exact: true }).fill('在这个时间点保留主体。');
  await page.getByRole('button', { name: '加入需求草稿', exact: true }).click();
  await expect.poll(async () => (await app.state()).draft.annotations.length).toBe(1);
  const annotation = (await app.state()).draft.annotations[0]; expect(annotation.timeStart).toBeCloseTo(.75, 1); expect(annotation.snapshotAssetId).toBeTruthy();
  await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 1.5; });
  await page.getByRole('button', { name: /批注 1：/ }).click();
  await expect(video).toHaveJSProperty('currentTime', annotation.timeStart!);
  await expect(page.getByRole('dialog', { name: '批注内容', exact: true }).locator('img')).toBeVisible();
  await page.getByRole('button', { name: '关闭批注内容', exact: true }).click();
  await page.getByLabel('选择画布素材文件', { exact: true }).setInputFiles([{ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Project reference material') }, { name: 'unsupported.mp4', mimeType: 'video/mp4', buffer: Buffer.from('Undecodable video fixture') }]);
  await expect(page.locator('.board-object')).toHaveCount(3);
  await expect(page.getByText('浏览器暂时无法预览此文件', { exact: true })).toBeVisible();
  await expect(page.getByText('brief.txt', { exact: true }).first()).toBeVisible();
  await page.getByLabel('选择需求附件文件', { exact: true }).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep the existing design') });
  await expect(page.locator('.draft-asset')).toHaveCount(1);
  expect((await app.state()).objects).toHaveLength(3);
  await expect.poll(async () => (await app.state()).draft.attachments.length).toBe(1);
});

test('synthetic file paste/drop route by target and preserve text editing', async ({ page, app }) => {
  await open(page, app); const image = await png(page); const data = [...image.buffer];
  const unprevented = await page.locator('#instruction').evaluate(element => { const data = new DataTransfer(); data.setData('text/plain', '普通文字'); const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }); element.dispatchEvent(event); return !event.defaultPrevented; });
  expect(unprevented).toBeTruthy();
  await page.locator('#instruction').fill('保留这段文字');
  await page.locator('#instruction').evaluate((element, data) => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(data)], 'pasted.png', { type: 'image/png' })); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); }, data);
  await expect(page.locator('.draft-asset')).toHaveCount(1); await expect(page.locator('#instruction')).toHaveValue('保留这段文字');
  expect((await app.state()).objects).toHaveLength(0);
  await page.locator('#whiteboard').evaluate((element, data) => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(data)], 'dropped.png', { type: 'image/png' })); element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); }, data);
  await expect(page.locator('.board-object')).toHaveCount(1);
  await expect.poll(async () => (await app.state()).draft.attachments.length).toBe(1);
});

test('dark narrow drawers, focus restoration and reduced motion', async ({ page, app }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, app);
  await page.getByRole('button', { name: '切换暗色主题', exact: true }).click();
  await page.getByRole('button', { name: '打开需求与队列', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '需求与队列', exact: true }); await expect(drawer).toBeVisible();
  await page.locator('#instruction').focus(); await expect(page.locator('#instruction')).toBeFocused();
  await page.locator('#instruction').fill('窄屏中的真实草稿');
  await expect.poll(async () => (await app.state()).draft.text).toBe('窄屏中的真实草稿');
  const colors = await drawer.evaluate(element => ({ surface: getComputedStyle(element).backgroundColor, ink: getComputedStyle(element).color, overflow: document.documentElement.scrollWidth > innerWidth }));
  expect(colors.surface).toBe('rgb(34, 34, 34)'); expect(colors.ink).toBe('rgb(243, 243, 243)'); expect(colors.overflow).toBeFalsy();
  await page.screenshot({ path: info.outputPath('dark-narrow-composer.png') });
  await page.keyboard.press('Escape'); await expect(drawer).not.toBeVisible();
  await expect(page.getByRole('button', { name: '打开需求与队列', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '白板会话', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '打开会话列表', exact: true })).toBeFocused();
  await page.screenshot({ path: info.outputPath('dark-narrow-board.png') });
});

test('clean drafts absorb CLI edits; conflicting unsaved drafts keep both copies', async ({ page, app }, info) => {
  await open(page, app);
  const first = await app.state();
  const args = ['--project', app.root, '--url', app.server.url, '--session', first.session.id];
  const externalFile = join(app.root, 'external-draft.json');
  await writeFile(externalFile, JSON.stringify({ ...first.draft, text: 'CLI 保存的草稿' }));
  await cli(['draft', 'save', ...args, '--input', externalFile]);
  await expect(page.locator('#instruction')).toHaveValue('CLI 保存的草稿');
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/sessions/${first.session.id}/draft`, async route => { entered(); await delayed; await route.continue(); });
  await page.locator('#instruction').fill('本地尚未保存的想法');
  await enteredPromise;
  const current = await app.state();
  await writeFile(externalFile, JSON.stringify({ ...current.draft, text: '服务端新增的完整想法' }));
  await cli(['draft', 'save', ...args, '--input', externalFile]);
  await expect(page.getByText('草稿在其他入口更新', { exact: true })).toBeVisible();
  await expect(page.locator('#instruction')).toHaveValue('本地尚未保存的想法');
  await page.getByRole('button', { name: '查看两份草稿', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '处理草稿更新', exact: true });
  await expect(dialog.getByText('本地尚未保存的想法', { exact: true })).toBeVisible();
  await expect(dialog.getByText('服务端新增的完整想法', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('draft-conflict.png') });
  release();
  await expect(page.getByRole('button', { name: '发送需求', exact: true })).toBeDisabled();
  expect((await app.state()).draft.text).toBe('服务端新增的完整想法');
  await page.getByRole('button', { name: '保留当前草稿', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await app.state()).draft.text).toBe('本地尚未保存的想法');
  await expect(page.locator('.draft-save')).toHaveText('已保存');
  await page.unroute(`**/api/sessions/${first.session.id}/draft`);
  await page.locator('#instruction').fill('第二次本地输入');
  const latest = await app.state();
  await app.call(`/api/sessions/${first.session.id}/draft`, 'PUT', { ...latest.draft, text: '第二次服务端更新' });
  await expect(page.getByText('草稿在其他入口更新', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看两份草稿', exact: true }).click();
  await page.getByRole('button', { name: '使用服务端草稿', exact: true }).click();
  await expect(page.locator('#instruction')).toHaveValue('第二次服务端更新');
});

test('view actions during a delayed session switch preserve the target viewport', async ({ page, app }) => {
  await open(page, app);
  const first = await app.state();
  const second = await app.call('/api/sessions', 'POST', { name: '独立视口' });
  const secondView = { x: 740, y: 220, zoom: .5, selectedObjectIds: [] };
  await app.call(`/api/sessions/${second.id}/view`, 'PUT', secondView);
  await expect(page.getByRole('button', { name: '独立视口', exact: true })).toBeVisible();
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/state?sessionId=${second.id}`, async route => { const response = await route.fetch(); entered(); await delayed; await route.fulfill({ response }); });
  await page.getByRole('button', { name: '独立视口', exact: true }).click(); await enteredPromise;
  for (const label of ['放大画布', '缩小画布', '适配全部素材']) await expect(page.getByRole('button', { name: label, exact: true })).toBeDisabled();
  await page.locator('#whiteboard').focus(); await page.keyboard.press('Equal');
  await page.mouse.move(600, 300); await page.keyboard.down('Control'); await page.mouse.wheel(0, -200); await page.keyboard.up('Control');
  release(); await expect(page.locator('.zoom-label')).toHaveText('50%');
  expect((await app.state(second.id)).session.view).toEqual(secondView);
  expect((await app.state(first.session.id)).session.view.zoom).toBe(1);
});

test('committed saves converge after lost responses before or after SSE confirmation', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  for (const delay of [0, 180]) {
    let handled!: () => void;
    const handledPromise = new Promise<void>(resolve => { handled = resolve; });
    await page.route(`**/api/sessions/${sessionId}/draft`, async route => {
      await route.fetch();
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      await route.abort('failed'); handled();
    });
    const text = `已持久保存但响应丢失 ${delay}`;
    await page.locator('#instruction').fill(text);
    await expect.poll(async () => (await app.state()).draft.text).toBe(text);
    await expect(page.locator('.draft-save')).toHaveText('已保存');
    await expect(page.locator('.draft-conflict')).toHaveCount(0);
    await expect(page.locator('#instruction')).toHaveValue(text);
    await handledPromise;
    await expect(page.locator('.draft-save')).toHaveText('已保存');
    await page.unroute(`**/api/sessions/${sessionId}/draft`);
  }
  await page.getByRole('button', { name: '发送需求', exact: true }).click();
  await expect(page.locator('.task-card[data-status="queued"]')).toHaveCount(1);
  expect((await app.state()).tasks[0].snapshot.userRequest.text).toBe('已持久保存但响应丢失 180');
});

test('isolated production processes repeatedly restart, claim and publish without native lifecycle failures', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  for (let index = 0; index < 3; index++) {
    await page.locator('#instruction').fill(`生产生命周期需求 ${index + 1}`);
    await page.getByRole('button', { name: '发送需求', exact: true }).click();
    await expect(page.locator('.task-card[data-status="queued"]')).toHaveCount(1);
    const args = ['--project', app.root, '--url', app.server.url, '--session', sessionId];
    const claimed = await cli(['task', 'next', ...args, '--consumer', `lifecycle-agent-${index}`]) as Claim;
    const outputFile = join(app.root, `result-${index}.txt`); await writeFile(outputFile, `Published result ${index}`);
    const output = await cli(['asset', 'import', ...args, '--file', outputFile, '--mime', 'text/plain', '--task', claimed.task!.id, '--run', claimed.run!.id, '--consumer', `lifecycle-agent-${index}`]) as Asset;
    const completionFile = join(app.root, `completion-${index}.json`);
    await writeFile(completionFile, JSON.stringify({ summary: `已完成第 ${index + 1} 次交付`, assetIds: [output.id], validation: ['产物文件已保存'], operations: [{ type: 'create', object: { assetId: output.id, x: 20 + index * 290, y: 120, width: 250, height: 150 } }] }));
    await cli(['task', 'complete', ...args, '--task', claimed.task!.id, '--run', claimed.run!.id, '--consumer', `lifecycle-agent-${index}`, '--input', completionFile]);
    expect((await cli(['task', 'next', ...args, '--consumer', `lifecycle-agent-${index}`])).task).toBeNull();
    await expect(page.locator('.board-object')).toHaveCount(index + 1);
    await app.restart(); await page.goto(`${app.server.url}/?session=${sessionId}`);
    await expect(page.locator('.board-object')).toHaveCount(index + 1);
    await expect(page.locator('.task-card[data-status="completed"]')).toHaveCount(index + 1);
  }
});

test('same-port service restart refreshes authentication and SSE while the browser stays open', async ({ page, app }) => {
  await open(page, app);
  await page.locator('#instruction').fill('重启前已入队的需求');
  await page.getByRole('button', { name: '发送需求', exact: true }).click();
  await expect(page.locator('.task-card[data-status="queued"]')).toHaveCount(1);
  await page.locator('#instruction').fill('重启前的持久草稿');
  await expect(page.locator('.draft-save')).toHaveText('已保存');
  const url = page.url();
  let bootstrapResponses = 0;
  page.on('response', response => { if (response.url().endsWith('/api/bootstrap') && response.status() === 200) bootstrapResponses++; });
  await app.restart(true);
  await expect.poll(() => bootstrapResponses, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(page.locator('.connection-status')).toHaveText('已保存', { timeout: 15_000 });
  expect(page.url()).toBe(url);
  await expect(page.locator('#instruction')).toHaveValue('重启前的持久草稿');
  await expect(page.locator('.task-card[data-status="queued"]')).toHaveCount(1);
  await page.locator('#instruction').fill('自动重连后的新草稿');
  await expect.poll(async () => (await app.state()).draft.text).toBe('自动重连后的新草稿');
  await page.getByRole('button', { name: '发送需求', exact: true }).click();
  await expect(page.locator('.task-card[data-status="queued"]')).toHaveCount(2);
});

test('a different project on the same port keeps dirty content and blocks asset/session/draft writes', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  const image = await png(page);
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let assetWrites = 0, sessionWrites = 0, draftWrites = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/api/assets?')) assetWrites++;
    if (request.method() === 'POST' && request.url().endsWith('/api/sessions')) sessionWrites++;
    if (request.method() === 'PUT' && request.url().endsWith(`/api/sessions/${sessionId}/draft`)) draftWrites++;
  });
  await page.route(`**/api/sessions/${sessionId}/draft`, async route => { entered(); await delayed; await route.continue(); });
  await page.locator('#instruction').fill('旧项目尚未保存的完整输入'); await enteredPromise;
  await page.getByRole('button', { name: '新建白板会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建白板会话', exact: true });
  await page.getByLabel('会话名称', { exact: true }).fill('旧上下文的新会话');
  const nextRoot = await app.replaceProject();
  await page.getByLabel('选择画布素材文件', { exact: true }).setInputFiles(image);
  await expect(page.getByRole('alert')).toContainText('这个地址已连接其他项目');
  release();
  await dialog.locator('form').dispatchEvent('submit');
  await expect(page.getByRole('button', { name: '创建会话', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '关闭新建白板会话', exact: true }).click();
  await expect(page.locator('#instruction')).toHaveValue('旧项目尚未保存的完整输入');
  await expect(page.locator('#instruction')).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: '发送需求', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '重新打开白板', exact: true })).toBeVisible();
  expect(await app.call('/api/sessions')).toEqual([]);
  expect(await readdir(join(nextRoot, '.acanvas', 'assets'))).toEqual([]);
  expect(await readdir(join(nextRoot, '.acanvas', 'tmp'))).toEqual([]);
  expect(assetWrites).toBe(1); expect(sessionWrites).toBe(0); expect(draftWrites).toBe(1);
});

test('lost send responses query the persisted draft association and keep one task', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  let handled!: () => void;
  const handledPromise = new Promise<void>(resolve => { handled = resolve; });
  await page.route(`**/api/sessions/${sessionId}/tasks`, async route => { await route.fetch(); await route.abort('failed'); handled(); });
  await page.locator('#instruction').fill('响应丢失仍保留的一次需求');
  await page.getByRole('button', { name: '发送需求', exact: true }).click(); await handledPromise;
  await expect(page.locator('.task-card[data-status="queued"]')).toHaveCount(1);
  await expect(page.locator('#instruction')).toHaveValue('');
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await page.unroute(`**/api/sessions/${sessionId}/tasks`);
  await page.locator('#instruction').fill('后续独立需求');
  await page.getByRole('button', { name: '发送需求', exact: true }).click();
  await expect(page.locator('.task-card[data-status="queued"]')).toHaveCount(2);
  expect((await app.state()).tasks.map(task => task.snapshot.userRequest.text)).toEqual(['响应丢失仍保留的一次需求', '后续独立需求']);
});
