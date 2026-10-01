import { test as base, expect, type Browser, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type App = { url: string; call: (path: string, method?: string, body?: unknown) => Promise<any>; stop: () => Promise<void> };
const test = base.extend<{ app: App }>({
  app: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'acanvas-import-binding-'));
    const child = spawn(resolve('.runtime/node_modules/node/bin/node'), [resolve('dist/src/server/main.js'), '--project', root, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const url = await new Promise<string>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${errors}`)), 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Fixture exited: ${errors}`)); });
      child.stdout.on('data', chunk => { output += chunk; const address = output.match(/acanvas: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]; if (address) { clearTimeout(timer); resolveReady(address); } });
    });
    const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json(); expect(response.ok, `${method} ${path}`).toBeTruthy(); return value;
    };
    const stop = async () => { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; } };
    try { await use({ url, call, stop }); }
    finally { await stop(); await rm(root, { recursive: true, force: true }); }
  },
});

async function open(page: Page, url: string) {
  await page.goto(url); await expect(page.locator('#instruction')).toBeVisible(); await expect(page.locator('.connection-status')).toHaveText('已保存');
}
const contextId = async (page: Page) => new URL(page.url()).searchParams.get('session')!;

async function requireIsolatedHeadlessClipboard(browser: Browser) {
  const protocol = await browser.newBrowserCDPSession();
  const { arguments: flags } = await protocol.send('Browser.getBrowserCommandLine');
  await protocol.detach();
  // Chromium headless installs an in-memory clipboard independent of macOS.
  // https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/headless/chrome_browser_main_extra_parts_headless.cc
  expect(flags.some(flag => flag.startsWith('--headless'))).toBeTruthy();
}

test('trusted PNG keyboard paste routes BODY, button, canvas and composer once', async ({ page, context, browser, app }) => {
  await requireIsolatedHeadlessClipboard(browser);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    (window as any).pasteEvidence = [];
    document.addEventListener('paste', event => { (window as any).pasteEvidence.push({ trusted: event.isTrusted, files: event.clipboardData?.files.length }); });
  });
  await open(page, app.url);
  let uploads = 0; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/assets') uploads++; });
  const writePng = () => page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 48;
    const paint = canvas.getContext('2d')!; paint.fillStyle = '#2387dc'; paint.fillRect(0, 0, 80, 48);
    const image = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
  });
  const pasteKey = process.platform === 'darwin' ? 'Meta+V' : 'Control+V';
  await writePng(); await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press(pasteKey); await expect(page.locator('.board-object')).toHaveCount(1);
  await writePng(); await page.getByRole('button', { name: '选择素材', exact: true }).focus();
  await page.keyboard.press(pasteKey); await expect(page.locator('.board-object')).toHaveCount(2);
  await page.locator('#instruction').fill('保留原输入');
  const bounds = (await page.locator('#whiteboard').boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width - 20, bounds.y + 30);
  await expect(page.locator('#whiteboard')).toBeFocused();
  await writePng(); await page.keyboard.press(pasteKey); await expect(page.locator('.board-object')).toHaveCount(3);
  await page.locator('#instruction').focus(); await writePng(); await page.keyboard.press(pasteKey);
  await expect(page.locator('.draft-asset')).toHaveCount(1); await expect(page.locator('#instruction')).toHaveValue('保留原输入');
  await expect(page.locator('.board-object')).toHaveCount(3); expect(uploads).toBe(4);
  const evidence = await page.evaluate(() => (window as any).pasteEvidence);
  expect(evidence).toHaveLength(4); expect(evidence.every((entry: any) => entry.trusted && entry.files === 1)).toBeTruthy();
  await page.evaluate(() => navigator.clipboard.writeText('普通粘贴文字'));
  await page.locator('#instruction').press('End'); await page.keyboard.press(pasteKey);
  await expect(page.locator('#instruction')).toHaveValue('保留原输入普通粘贴文字'); expect(uploads).toBe(4);
});

test('items-only file paste imports once, unsupported items and offline service explain the result', async ({ page, app }) => {
  await open(page, app.url);
  const dispatch = async (readable: boolean) => page.evaluate(readable => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['Known fixture'], 'items-only.txt', { type: 'text/plain' }));
    const item = transfer.items[0];
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [], items: [{ kind: 'file', getAsFile: () => readable ? item.getAsFile() : null }] } });
    document.body.dispatchEvent(event); return event.defaultPrevented;
  }, readable);
  expect(await dispatch(true)).toBeTruthy(); await expect(page.locator('.board-object')).toHaveCount(1);
  expect((await app.call(`/api/state?sessionId=${await contextId(page)}`)).assets).toHaveLength(1);
  await dispatch(false); await expect(page.getByText('剪贴板中的文件暂时无法读取。请拖入文件或选择素材。', { exact: true })).toBeVisible();
  await app.stop(); await expect(page.locator('.connection-status')).toHaveText('重新连接中');
  await dispatch(true); await expect(page.getByRole('alert')).toContainText('白板连接已中断');
  await expect(page.locator('.board-object')).toHaveCount(1);
});

test('bare tabs receive independent contexts while bound legacy URLs retain their queue', async ({ page, context, app }) => {
  const old = await app.call('/api/sessions', 'POST', { name: 'Saved agent scope' });
  const before = await app.call(`/api/state?sessionId=${old.id}`);
  const saved = await app.call(`/api/sessions/${old.id}/draft`, 'PUT', { ...before.draft, text: '旧上下文中的需求' });
  await app.call(`/api/sessions/${old.id}/tasks`, 'POST', { draftId: saved.id, expectedRevision: saved.revision });
  const bootstrap = await app.call('/api/bootstrap');
  await page.addInitScript(({ projectId, sessionId }) => localStorage.setItem(`acanvas-session:${projectId}`, sessionId), { projectId: bootstrap.project.id, sessionId: old.id });
  await open(page, app.url); const first = await contextId(page); expect(first).not.toBe(old.id);
  await page.locator('#instruction').fill('第一个标签页');
  const other = await context.newPage(); await open(other, app.url); const second = await contextId(other);
  expect(second).not.toBe(first); expect(second).not.toBe(old.id); await other.locator('#instruction').fill('第二个标签页');
  await expect.poll(async () => (await app.call(`/api/state?sessionId=${first}`)).draft.text).toBe('第一个标签页');
  await expect.poll(async () => (await app.call(`/api/state?sessionId=${second}`)).draft.text).toBe('第二个标签页');
  await page.reload(); await expect(page.locator('#instruction')).toHaveValue('第一个标签页'); expect(await contextId(page)).toBe(first);
  const legacy = await context.newPage(); await open(legacy, `${app.url}/?version=p0&session=${old.id}`);
  await expect(legacy.locator('.queue-title')).toHaveText('旧上下文中的需求'); expect(await contextId(legacy)).toBe(old.id);
  expect(await legacy.getByRole('button', { name: /白板会话|会话列表/ }).count()).toBe(0);
});
