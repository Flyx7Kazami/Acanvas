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
  await page.getByRole('button', { name: '添加批注', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '添加批注', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '批注内容', exact: true }).fill('保留中部构图，增加呼吸感。');
  await page.getByRole('button', { name: '加入需求草稿', exact: true }).click();
  await expect(page.locator('.draft-annotation')).toHaveCount(1);
  const before = await app.state();
  const annotation = before.draft.annotations[0];
  expect(annotation.bounds.x).toBe(0); expect(annotation.bounds.y).toBe(0);
  expect(annotation.bounds.width).toBe(1); expect(annotation.bounds.height).toBe(1);
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
  expect((annotationBox.x - currentBox.x) / currentBox.width).toBeCloseTo(0, 1);
  expect((annotationBox.y - currentBox.y) / currentBox.height).toBeCloseTo(0, 1);
  await page.getByLabel('创作需求', { exact: true }).fill('根据参考和批注生成一个新版本。');
  await page.getByRole('button', { name: '发送需求', exact: true }).click();
  await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(1);
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
  await page.getByRole('button', { name: /记录/ }).click();
  await expect(page.locator('.task-card[data-status="completed"]')).toHaveCount(1);
  await expect(page.getByText('参考图已回填到共享白板。', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
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
  await expect.poll(async () => page.locator('.composer').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(34, 34, 34)');
  await page.locator('.board-object img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
  const pixels = await page.locator('.board-object img').evaluateAll(images => images.map(image => { const frame = document.createElement('canvas'); frame.width = 600; frame.height = 300; const context = frame.getContext('2d')!; context.drawImage(image as HTMLImageElement, 0, 0); return [...context.getImageData(130, 80, 1, 1).data]; }));
  expect(pixels).toEqual([[37,37,37,255], [37,37,37,255]]);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: info.outputPath('dark-board.png') });
  await page.reload(); await expect(page.locator('.board-object')).toHaveCount(2);
  await page.getByRole('button', { name: /记录/ }).click();
  await expect(page.locator('.task-card[data-status="completed"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('two URL task contexts keep drafts and sends isolated through delayed saves and refresh', async ({ page, app }) => {
  await open(page, app);
  const initial = await app.state(), firstId = initial.session.id;
  const second = await app.call('/api/sessions', 'POST', { name: '另一条探索' });
  const secondPage = await page.context().newPage();
  await secondPage.goto(`${app.server.url}/?session=${second.id}`);
  await expect(secondPage.locator('#instruction')).toHaveValue('');
  await expect(page.locator('.session-list,.session-panel')).toHaveCount(0);
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  await page.route(`**/api/sessions/${firstId}/draft`, async route => {
    if (held) return route.continue(); held = true;
    const response = await route.fetch(); entered(); await delayed; await route.fulfill({ response });
  });
  await page.locator('#instruction').fill('第一个上下文的草稿'); await enteredPromise;
  await secondPage.locator('#instruction').fill('第二个上下文的新想法');
  release();
  await expect.poll(async () => (await app.state(second.id)).draft.text).toBe('第二个上下文的新想法');
  await expect(secondPage.locator('#instruction')).toHaveValue('第二个上下文的新想法');
  await expect(page.locator('#instruction')).toHaveValue('第一个上下文的草稿');
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
  await expect(secondPage.locator('.queue-item')).toHaveCount(0);
  await page.locator('#instruction').fill('发送后的下一条草稿');
  await expect.poll(async () => (await app.state(firstId)).draft.text).toBe('发送后的下一条草稿');
  await expect(page.locator('.draft-save')).toHaveText('已保存');
  await page.reload(); await expect(page.locator('#instruction')).toHaveValue('发送后的下一条草稿');
  await secondPage.reload(); await expect(secondPage.locator('#instruction')).toHaveValue('第二个上下文的新想法');
  expect((await app.state(second.id)).draft.text).toBe('第二个上下文的新想法');
  await secondPage.close();
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
  await page.getByLabel('选择画布素材文件', { exact: true }).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep the existing design') });
  await expect(page.locator('.board-object')).toHaveCount(4);
  await page.locator('.board-object').last().focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '附加到需求', exact: true }).click();
  await expect(page.locator('.draft-asset')).toHaveCount(1);
  expect((await app.state()).objects).toHaveLength(4);
  await expect.poll(async () => (await app.state()).draft.attachments.length).toBe(1);
});

test('file paste and drop add canvas objects from every input while text remains editable', async ({ page, app }) => {
  await open(page, app); const image = await png(page); const data = [...image.buffer];
  const unprevented = await page.locator('#instruction').evaluate(element => { const data = new DataTransfer(); data.setData('text/plain', '普通文字'); const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }); element.dispatchEvent(event); return !event.defaultPrevented; });
  expect(unprevented).toBeTruthy();
  await page.locator('#instruction').fill('保留这段文字');
  await page.locator('#instruction').evaluate((element, data) => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(data)], 'pasted.png', { type: 'image/png' })); element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); }, data);
  await expect(page.locator('.board-object')).toHaveCount(1);
  await expect(page.locator('.draft-asset')).toHaveCount(0); await expect(page.locator('#instruction')).toHaveValue('保留这段文字');
  const first = await app.state(), bounds = (await page.locator('#whiteboard').boundingBox())!;
  expect(first.objects[0].x + first.objects[0].width / 2).toBeCloseTo((bounds.width / 2 - first.session.view.x) / first.session.view.zoom, 1);
  expect(first.objects[0].y + first.objects[0].height / 2).toBeCloseTo((bounds.height / 2 - first.session.view.y) / first.session.view.zoom, 1);
  await page.locator('#whiteboard').evaluate((element, data) => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(data)], 'dropped.png', { type: 'image/png' })); const bounds = element.getBoundingClientRect(); element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: bounds.left + 300, clientY: bounds.top + 210, dataTransfer: transfer })); }, data);
  await expect(page.locator('.board-object')).toHaveCount(2);
  const dropped = await app.state();
  expect(dropped.objects[1].x + dropped.objects[1].width / 2).toBeCloseTo((300 - dropped.session.view.x) / dropped.session.view.zoom, 1);
  expect(dropped.objects[1].y + dropped.objects[1].height / 2).toBeCloseTo((210 - dropped.session.view.y) / dropped.session.view.zoom, 1);
  await page.locator('.composer').evaluate((element, data) => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(data)], 'composer-drop.png', { type: 'image/png' })); element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); }, data);
  await expect(page.locator('.board-object')).toHaveCount(3);
  expect((await app.state()).draft.attachments).toEqual([]);
  await expect(page.locator('#instruction')).toHaveValue('保留这段文字');
});

test('compact input preserves multiline drafts and references with a merged centered tool rail', async ({ page, app }, info) => {
  await open(page, app);
  const measurements: object[] = [];
  const image = await png(page);
  await page.getByLabel('选择画布素材文件', { exact: true }).setInputFiles(image);
  await page.locator('.board-object').focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '附加到需求', exact: true }).click();
  const text = '保持主体的轮廓与比例。\n留出标题空间。\n使用现有参考中的色彩。';
  await page.locator('#instruction').fill(text);
  await expect.poll(async () => (await app.state()).draft.text).toBe(text);
  await page.reload(); await expect(page.locator('#instruction')).toHaveValue(text);
  await expect(page.locator('.draft-asset')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '为当前需求添加附件', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('选择需求附件文件', { exact: true })).toHaveCount(0);
  await expect(page.locator('.composer .lucide-plus')).toHaveCount(0);
  for (const [name, width, height, dark] of [['light', 1440, 1000, false], ['dark', 1440, 1000, true], ['narrow', 390, 844, true]] as const) {
    await page.setViewportSize({ width, height });
    if (width <= 1160) await page.getByRole('button', { name: '适配全部素材', exact: true }).click();
    if (dark && await page.getByRole('button', { name: '切换暗色主题', exact: true }).count()) await page.getByRole('button', { name: '切换暗色主题', exact: true }).click();
    const input = page.locator('#instruction'); await input.focus();
    const composer = (await page.locator('.composer').boundingBox())!, box = (await input.boundingBox())!, send = (await page.getByRole('button', { name: '发送需求', exact: true }).boundingBox())!;
    const canvas = (await page.locator('#whiteboard').boundingBox())!, tools = (await page.getByRole('toolbar', { name: '白板工具', exact: true }).boundingBox())!;
    expect(composer.height).toBe(52); expect(composer.width).toBeLessThanOrEqual(720);
    expect(Math.abs(box.y + box.height / 2 - send.y - send.height / 2)).toBeLessThan(1);
    expect(tools.x - canvas.x).toBe(16); expect(tools.height).toBeGreaterThan(tools.width);
    expect(tools.y + tools.height / 2).toBeCloseTo(canvas.y + canvas.height / 2, 1);
    expect(tools.y).toBeGreaterThan(canvas.y); expect(tools.y + tools.height).toBeLessThan(composer.y);
    expect(tools.width).toBe(40);
    await expect(page.locator('.canvas-toolbar button')).toHaveCount(6);
    await expect(page.locator('.canvas-zoom')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '绘制区域批注', exact: true })).toHaveCount(0);
    await expect(page.locator('.draft-save')).toBeVisible();
    expect(await input.evaluate(element => ({ rows: (element as HTMLTextAreaElement).rows, overflow: element.scrollHeight > element.clientHeight, outline: getComputedStyle(element).outlineStyle, border: getComputedStyle(element).borderWidth, shadow: getComputedStyle(element).boxShadow, surface: getComputedStyle(element).backgroundColor }))).toEqual({ rows: 1, overflow: true, outline: 'none', border: '0px', shadow: 'none', surface: 'rgba(0, 0, 0, 0)' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBeFalsy();
    measurements.push({ name, viewport: { width, height }, composer, input: box, send, canvas, tools, references: await page.locator('.draft-attachments').boundingBox() });
    await page.locator('.board-object img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: info.outputPath(`compact-${name}.png`) });
  }
  await page.locator('#instruction').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await expect(page.locator('.queue-item')).toHaveCount(1);
  const sent = await app.state(); expect(sent.tasks[0].snapshot.userRequest.text).toBe(text); expect(sent.tasks[0].snapshot.referenceContent.assets).toHaveLength(1);
  for (let index = 2; index <= 6; index++) {
    await page.locator('#instruction').fill(`构图探索 ${index}`);
    await page.getByRole('button', { name: '发送需求', exact: true }).click();
    await expect(page.locator('.queue-item')).toHaveCount(index);
  }
  await page.locator('.board-object').focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '附加到需求', exact: true }).click();
  await page.locator('#instruction').fill(text);
  await expect(page.locator('.draft-save')).toHaveText('已保存');
  await expect(page.locator('.toast')).toHaveCount(0);
  await page.locator('.queue-expand').click(); await expect(page.locator('.queue-item:visible')).toHaveCount(6);
  for (const width of [390, 560, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const queue = (await page.locator('.queue-list').boundingBox())!, tools = (await page.locator('.canvas-toolbar').boundingBox())!, composer = (await page.locator('.composer').boundingBox())!, references = (await page.locator('.draft-attachments').boundingBox())!;
    expect(queue.x).toBeGreaterThanOrEqual(tools.x + tools.width + 4);
    expect(references.x).toBeGreaterThanOrEqual(tools.x + tools.width + 4);
    expect(references.height).toBeLessThanOrEqual(44); expect(references.y + references.height).toBeLessThan(composer.y);
    expect((await page.locator('.queue-item').last().boundingBox())!.y + (await page.locator('.queue-item').last().boundingBox())!.height).toBeLessThanOrEqual(references.y);
    expect(composer.height).toBe(52);
    expect(await page.locator('.canvas-toolbar button').evaluateAll(buttons => buttons.every(button => { const bounds = button.getBoundingClientRect(); return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === button; }))).toBeTruthy();
    measurements.push({ name: `expanded-queue-${width}`, viewport: { width, height: 844 }, queue, tools, composer, references });
    await page.screenshot({ path: info.outputPath(`compact-queue-${width}.png`) });
  }
  await writeFile(info.outputPath('compact-geometry.json'), JSON.stringify(measurements, null, 2));
});

test('dark narrow composer keeps text styling stable, restores dialog focus and respects reduced motion', async ({ page, app }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, app);
  await page.getByRole('button', { name: '切换暗色主题', exact: true }).click();
  const composer = page.locator('.composer'), input = page.locator('#instruction');
  const before = await composer.evaluate(element => ({ border: getComputedStyle(element).borderColor, surface: getComputedStyle(element).backgroundColor }));
  await input.focus(); await expect(input).toBeFocused();
  await input.fill('窄屏中的真实草稿');
  await expect.poll(async () => (await app.state()).draft.text).toBe('窄屏中的真实草稿');
  const styling = await input.evaluate(element => ({ outline: getComputedStyle(element).outlineStyle, border: getComputedStyle(element).borderWidth, background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow, animation: getComputedStyle(element).animationName, overflow: document.documentElement.scrollWidth > innerWidth }));
  expect(styling).toEqual({ outline: 'none', border: '0px', background: 'rgba(0, 0, 0, 0)', shadow: 'none', animation: 'none', overflow: false });
  expect(await composer.evaluate(element => ({ border: getComputedStyle(element).borderColor, surface: getComputedStyle(element).backgroundColor }))).toEqual(before);
  const box = (await composer.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(16); expect(box.x + box.width).toBeLessThanOrEqual(374);
  await page.screenshot({ path: info.outputPath('dark-narrow-composer.png') });
  await page.getByRole('button', { name: '记录', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '需求记录', exact: true }); await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: '记录', exact: true })).toBeFocused();
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

test('two URL task contexts preserve their independent viewport during a delayed load', async ({ page, app }) => {
  await open(page, app);
  const first = await app.state();
  const second = await app.call('/api/sessions', 'POST', { name: '独立视口' });
  const secondView = { x: 740, y: 220, zoom: .5, selectedObjectIds: [] };
  await app.call(`/api/sessions/${second.id}/view`, 'PUT', secondView);
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const secondPage = await page.context().newPage();
  await secondPage.route(`**/api/state?sessionId=${second.id}`, async route => { const response = await route.fetch(); entered(); await delayed; await route.fulfill({ response }); });
  const navigation = secondPage.goto(`${app.server.url}/?session=${second.id}`); await enteredPromise;
  await page.getByRole('button', { name: '放大画布', exact: true }).click();
  release(); await navigation; await expect(secondPage.locator('.zoom-label')).toHaveText('50%');
  expect((await app.state(second.id)).session.view).toEqual(secondView);
  await expect.poll(async () => (await app.state(first.session.id)).session.view.zoom).toBe(1.2);
  await secondPage.close();
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
  await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(1);
  expect((await app.state()).tasks[0].snapshot.userRequest.text).toBe('已持久保存但响应丢失 180');
});

test('isolated production processes repeatedly restart, claim and publish without native lifecycle failures', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  for (let index = 0; index < 3; index++) {
    await page.locator('#instruction').fill(`生产生命周期需求 ${index + 1}`);
    await page.getByRole('button', { name: '发送需求', exact: true }).click();
    await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(1);
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
    await page.getByRole('button', { name: /记录/ }).click();
    await expect(page.locator('.task-card[data-status="completed"]')).toHaveCount(index + 1);
    await page.keyboard.press('Escape');
  }
});

test('same-port service restart refreshes authentication and SSE while the browser stays open', async ({ page, app }) => {
  await open(page, app);
  await page.locator('#instruction').fill('重启前已入队的需求');
  await page.getByRole('button', { name: '发送需求', exact: true }).click();
  await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(1);
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
  await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(1);
  await page.locator('#instruction').fill('自动重连后的新草稿');
  await expect.poll(async () => (await app.state()).draft.text).toBe('自动重连后的新草稿');
  await page.getByRole('button', { name: '发送需求', exact: true }).click();
  await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(2);
});

test('a different project on the same port keeps dirty content and blocks asset/session/draft writes', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  const image = await png(page);
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let assetWrites = 0, sessionWrites = 0, draftWrites = 0, failedAssetWrites = 0;
  const assetStatuses: number[] = [], successfulWrites: string[] = [];
  page.on('response', response => {
    const request = response.request();
    if (request.method() === 'POST' && request.url().includes('/api/assets?')) assetStatuses.push(response.status());
    if (['POST', 'PUT', 'DELETE'].includes(request.method()) && response.ok()) successfulWrites.push(request.url());
  });
  page.on('requestfailed', request => { if (request.method() === 'POST' && request.url().includes('/api/assets?')) failedAssetWrites++; });
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/api/assets?')) assetWrites++;
    if (request.method() === 'POST' && request.url().endsWith('/api/sessions')) sessionWrites++;
    if (request.method() === 'PUT' && request.url().endsWith(`/api/sessions/${sessionId}/draft`)) draftWrites++;
  });
  await page.route(`**/api/sessions/${sessionId}/draft`, async route => { entered(); await delayed; await route.continue(); });
  await page.locator('#instruction').fill('旧项目尚未保存的完整输入'); await enteredPromise;
  const nextRoot = await app.replaceProject();
  await page.getByLabel('选择画布素材文件', { exact: true }).setInputFiles(image);
  await expect(page.getByRole('alert')).toContainText('这个地址已连接其他项目');
  release();
  await expect(page.locator('#instruction')).toHaveValue('旧项目尚未保存的完整输入');
  await expect(page.locator('#instruction')).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: '发送需求', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '重新打开白板', exact: true })).toBeVisible();
  expect(await app.call('/api/sessions')).toEqual([]);
  expect(await readdir(join(nextRoot, '.acanvas', 'assets'))).toEqual([]);
  expect(await readdir(join(nextRoot, '.acanvas', 'tmp'))).toEqual([]);
  expect(assetWrites).toBeLessThanOrEqual(1);
  await expect.poll(() => assetStatuses.length + failedAssetWrites).toBe(assetWrites);
  expect(assetStatuses.every(status => status >= 400)).toBeTruthy();
  expect(successfulWrites).toEqual([]);
  expect(sessionWrites).toBe(0); expect(draftWrites).toBe(1);
});

test('lost send responses query the persisted draft association and keep one task', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  let handled!: () => void;
  const handledPromise = new Promise<void>(resolve => { handled = resolve; });
  await page.route(`**/api/sessions/${sessionId}/tasks`, async route => { await route.fetch(); await route.abort('failed'); handled(); });
  await page.locator('#instruction').fill('响应丢失仍保留的一次需求');
  await page.getByRole('button', { name: '发送需求', exact: true }).click(); await handledPromise;
  await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(1);
  await expect(page.locator('#instruction')).toHaveValue('');
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await page.unroute(`**/api/sessions/${sessionId}/tasks`);
  await page.locator('#instruction').fill('后续独立需求');
  await page.getByRole('button', { name: '发送需求', exact: true }).click();
  await expect(page.locator('.queue-item[data-status="queued"]')).toHaveCount(2);
  expect((await app.state()).tasks.map(task => task.snapshot.userRequest.text)).toEqual(['响应丢失仍保留的一次需求', '后续独立需求']);
});

test('bottom queue stacks 1, 3 and 6 tasks, expands upward by hover and focus, and exposes real task actions', async ({ page, browser, app }, info) => {
  await open(page, app);
  const composer = page.locator('.composer'), input = page.locator('#instruction');
  const original = (await composer.boundingBox())!;
  for (let index = 1; index <= 6; index++) {
    await input.fill(`构图探索 ${index}`);
    await page.getByRole('button', { name: '发送需求', exact: true }).click();
    await expect(page.locator('.queue-item')).toHaveCount(index);
    if ([1, 3, 6].includes(index)) {
      await expect(page.locator('.queue-item:visible')).toHaveCount(Math.min(index, 3));
      await expect(page.locator('.queue-peeks>span')).toHaveCount(Math.max(0, Math.min(index - 3, 2)));
      const queue = (await page.locator('.queue-list').boundingBox())!;
      expect(queue.y).toBeLessThan(original.y);
      expect(queue.y + queue.height).toBeGreaterThan(original.y);
      expect((await composer.boundingBox())!.y).toBeCloseTo(original.y, 1);
      await page.screenshot({ path: info.outputPath(`queue-${index}-collapsed.png`) });
    }
  }
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text: string) => { (window as Window & { copiedCommand?: string }).copiedCommand = text; } }); });
  await page.getByRole('button', { name: '复制接续口令', exact: true }).click();
  const command = await page.evaluate(() => (window as Window & { copiedCommand?: string }).copiedCommand);
  expect(command).toContain(`项目：${(await app.state()).project.root}`);
  expect(command).toContain(`白板：${page.url()}`);
  expect(command).not.toContain('白板会话');
  expect(command).not.toContain('任务上下文');
  await page.locator('.queue-task').first().hover();
  await expect(page.locator('.queue-stack')).toHaveClass(/expanded/);
  await expect(page.locator('.queue-item:visible')).toHaveCount(6);
  const expanded = (await page.locator('.queue-list').boundingBox())!;
  expect(expanded.height).toBeLessThanOrEqual(360);
  expect((await composer.boundingBox())!.y).toBeCloseTo(original.y, 1);
  await page.locator('.queue-task').nth(4).hover();
  await expect(page.locator('.queue-stack')).toHaveClass(/expanded/);
  await page.screenshot({ path: info.outputPath('queue-6-hover-expanded.png') });
  const toggle = page.locator('.queue-expand');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.queue-item:visible')).toHaveCount(3);
  await expect(toggle).toBeFocused();
  await page.mouse.move(30, 180);
  await input.focus();
  await page.locator('.queue-task').first().hover();
  await expect(page.locator('.queue-item:visible')).toHaveCount(6);
  await page.mouse.move(original.x + 35, original.y - 25);
  await toggle.focus();
  expect(await page.locator('.queue-stack').evaluate(element => element.matches(':hover'))).toBeTruthy();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.queue-item:visible')).toHaveCount(3);
  await expect(toggle).toBeFocused();
  expect(await page.locator('.queue-stack').evaluate(element => element.matches(':hover'))).toBeTruthy();
  await toggle.press('Enter');
  await expect(page.locator('.queue-item:visible')).toHaveCount(6);
  await toggle.press('Space');
  await expect(page.locator('.queue-item:visible')).toHaveCount(3);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.move(30, 180);
  await input.focus();
  await expect(page.locator('.queue-stack')).not.toHaveClass(/expanded/);
  await page.locator('.queue-task').first().focus();
  await expect(page.locator('.queue-stack')).toHaveClass(/expanded/);
  await page.locator('.queue-task').nth(3).focus();
  await page.keyboard.press('Enter');
  const details = page.getByRole('dialog', { name: '需求 4', exact: true });
  await expect(details).toBeVisible(); await expect(details.getByText('构图探索 4', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('.queue-task').nth(3)).toBeFocused();
  await page.getByRole('button', { name: '撤回需求 4', exact: true }).click();
  await expect.poll(async () => (await app.state()).tasks[3].status).toBe('cancelled');
  await expect(page.locator('.queue-item')).toHaveCount(5);
  await page.getByRole('button', { name: /记录/ }).click();
  const history = page.getByRole('dialog', { name: '需求记录', exact: true });
  await expect(history.locator('.task-card')).toHaveCount(6);
  await expect(history.locator('.task-card[data-status="cancelled"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const touch = await touchContext.newPage();
    await touch.goto(page.url()); await expect(touch.locator('.queue-item:visible')).toHaveCount(3);
    await touch.locator('.queue-expand').tap();
    await expect(touch.locator('.queue-item:visible')).toHaveCount(5);
    await expect(touch.locator('.composer')).toBeVisible();
    expect(await touch.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBeFalsy();
    await touch.screenshot({ path: info.outputPath('touch-queue-expanded.png') });
    await touch.locator('.queue-expand').tap();
    await expect(touch.locator('.queue-item:visible')).toHaveCount(3);
    await expect(touch.locator('.queue-expand')).toHaveAttribute('aria-expanded', 'false');
    await touch.locator('.queue-expand').tap();
    await expect(touch.locator('.queue-item:visible')).toHaveCount(5);
    await touch.locator('.queue-expand').tap();
    await expect(touch.locator('.queue-item:visible')).toHaveCount(3);
  } finally { await touchContext.close(); }
});
