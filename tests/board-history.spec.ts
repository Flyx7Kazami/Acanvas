import { test as base, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer, type RunningServer } from '../src/server/http.js';
import type { BoardState } from '../src/shared/types.js';

type AppFixture = {
  root: string;
  server: RunningServer;
  call: (path: string, method?: string, body?: unknown) => Promise<any>;
  state: (sessionId?: string) => Promise<BoardState>;
};

const test = base.extend<{ app: AppFixture }>({
  app: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'acanvas-history-browser-'));
    const server = await startServer({ root, port: 0, webRoot: resolve('dist/web') });
    const bootstrap = await (await fetch(`${server.url}/api/bootstrap`)).json() as { token: string };
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${server.url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(response.ok, `API ${method} ${path}`).toBeTruthy();
      return response.json();
    };
    const state = async (sessionId?: string) => call(`/api/state?sessionId=${encodeURIComponent(sessionId || (await call('/api/sessions'))[0].id)}`) as Promise<BoardState>;
    try { await use({ root, server, call, state }); }
    finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  },
});

async function open(page: Page, app: AppFixture, sessionId?: string) {
  await page.goto(`${app.server.url}/${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`);
  await expect(page.locator('#whiteboard')).toBeVisible();
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  await expect(page.locator('.connection-feedback')).toHaveCount(0);
}

async function png(page: Page) {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 120;
    const context = canvas.getContext('2d')!; context.fillStyle = '#2b2b2b'; context.fillRect(0, 0, 240, 120); context.fillStyle = '#fff'; context.fillRect(24, 24, 192, 72);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name: 'history-reference.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') };
}

async function waitForObject(app: AppFixture, id: string, predicate: (object: BoardState['objects'][number] | undefined) => boolean) {
  await expect.poll(async () => predicate((await app.state()).objects.find(object => object.id === id))).toBeTruthy();
}

test('toolbar history restores object identity through move resize delete reload and clears redo on a new write', async ({ page, app }) => {
  await open(page, app);
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  await expect(undo).toBeDisabled(); await expect(redo).toBeDisabled();

  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(await png(page));
  const object = page.locator('.board-object'); await expect(object).toHaveCount(1);
  const created = (await app.state()).objects[0];
  await expect(undo).toBeEnabled(); await expect(redo).toBeDisabled();

  await object.click();
  const beforeMove = (await app.state()).objects[0], moveBox = (await object.boundingBox())!;
  await page.mouse.move(moveBox.x + moveBox.width / 2, moveBox.y + moveBox.height / 2); await page.mouse.down();
  await page.mouse.move(moveBox.x + moveBox.width / 2 + 80, moveBox.y + moveBox.height / 2 + 30, { steps: 4 }); await page.mouse.up();
  await waitForObject(app, created.id, value => !!value && (value.x !== beforeMove.x || value.y !== beforeMove.y));
  const moved = (await app.state()).objects[0];
  await undo.click(); await waitForObject(app, created.id, value => !!value && value.x === beforeMove.x && value.y === beforeMove.y);
  await expect(redo).toBeEnabled(); await redo.click(); await waitForObject(app, created.id, value => !!value && value.x === moved.x && value.y === moved.y);

  await object.click();
  const beforeResize = (await app.state()).objects[0], handle = page.locator(`[data-resize-id="${created.id}"][data-resize-corner="se"]`);
  await expect(handle).toBeVisible(); const handleBox = (await handle.boundingBox())!;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2); await page.mouse.down();
  await page.mouse.move(handleBox.x + 48, handleBox.y + 28, { steps: 3 }); await page.mouse.up();
  await waitForObject(app, created.id, value => !!value && (value.width !== beforeResize.width || value.height !== beforeResize.height));
  await undo.click(); await waitForObject(app, created.id, value => !!value && value.width === beforeResize.width && value.height === beforeResize.height);

  await object.click(); await page.getByRole('button', { name: 'Remove selected files from canvas', exact: true }).click();
  await expect(page.locator('.board-object')).toHaveCount(0); await expect(undo).toBeEnabled();
  await undo.click(); await expect(page.locator(`.board-object[data-object-id="${created.id}"]`)).toBeVisible();
  await expect(page.locator('.board-object').first()).toHaveAttribute('data-object-id', created.id);
  await expect(redo).toBeEnabled();

  await page.reload(); await expect(page.locator(`.board-object[data-object-id="${created.id}"]`)).toBeVisible();
  await expect(redo).toBeEnabled(); await redo.click(); await expect(page.locator('.board-object')).toHaveCount(0);
  await page.reload(); await expect(page.locator('.board-object')).toHaveCount(0); await expect(undo).toBeEnabled(); await expect(redo).toBeDisabled();

  await undo.click(); const restored = page.locator(`.board-object[data-object-id="${created.id}"]`); await expect(restored).toBeVisible();
  await restored.click(); const restoredBox = (await restored.boundingBox())!;
  await page.mouse.move(restoredBox.x + restoredBox.width / 2, restoredBox.y + restoredBox.height / 2); await page.mouse.down(); await page.mouse.move(restoredBox.x + restoredBox.width / 2 + 40, restoredBox.y + restoredBox.height / 2, { steps: 3 }); await page.mouse.up();
  await expect.poll(async () => (await app.state()).history.canRedo).toBe(false);
  await expect(redo).toBeDisabled();
});

test('keyboard undo waits behind a delayed object update in the same mutation queue', async ({ page, app }) => {
  await open(page, app);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(await png(page));
  const object = page.locator('.board-object'); await expect(object).toHaveCount(1);
  const before = (await app.state()).objects[0];
  let updateSeen = false, releaseUpdate!: () => void;
  const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve; });
  await page.route('**/api/board/operations', async route => {
    const operations = route.request().postDataJSON()?.operations;
    if (Array.isArray(operations) && operations.some((operation: { type?: string }) => operation.type === 'update')) { updateSeen = true; await updateGate; }
    await route.continue();
  });
  await object.focus(); await page.keyboard.press('ArrowRight'); await expect.poll(() => updateSeen).toBe(true);
  await page.keyboard.press('Control+Z'); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  releaseUpdate(); await expect.poll(async () => (await app.state()).objects.find(value => value.id === before.id)?.x).toBe(before.x);
  await expect.poll(async () => (await app.state()).history.canRedo).toBe(true);
  await page.unroute('**/api/board/operations');
});

test('keyboard undo queues behind a delayed import create', async ({ page, app }) => {
  await open(page, app);
  let createSeen = false, releaseCreate!: () => void;
  const createGate = new Promise<void>(resolve => { releaseCreate = resolve; });
  await page.route('**/api/board/operations', async route => {
    const operations = route.request().postDataJSON()?.operations;
    if (Array.isArray(operations) && operations.some((operation: { type?: string }) => operation.type === 'create')) { createSeen = true; await createGate; }
    await route.continue();
  });
  const importPromise = page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(await png(page));
  await expect.poll(() => createSeen).toBe(true);
  await page.locator('#whiteboard').press('Control+Z'); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  releaseCreate(); await importPromise; await expect(page.locator('.board-object')).toHaveCount(0); await expect.poll(async () => (await app.state()).history.canRedo).toBe(true);
  await page.unroute('**/api/board/operations');
});

test('board shortcuts work on the canvas while note and HTML native undo stay local', async ({ page, app }) => {
  await open(page, app);
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles(await png(page));
  await expect(page.locator('.board-object')).toHaveCount(1);
  await page.locator('#whiteboard').press('Control+Z'); await expect(page.locator('.board-object')).toHaveCount(0);
  await page.locator('#whiteboard').press('Control+Shift+Z'); await expect(page.locator('.board-object')).toHaveCount(1);

  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  const boardBox = (await page.locator('#whiteboard').boundingBox())!;
  await page.mouse.click(boardBox.x + boardBox.width / 2, boardBox.y + boardBox.height / 2);
  const note = page.locator('.board-object[data-content-kind="note"]'); await expect(note).toBeVisible();
  const noteEditor = note.locator('textarea.note-editor'); await expect(noteEditor).toBeVisible(); await noteEditor.click(); await page.keyboard.type('native note text'); const noteBeforeUndo = await noteEditor.inputValue(); await noteEditor.press('Meta+Z'); await expect.poll(() => noteEditor.inputValue()).not.toBe(noteBeforeUndo);
  await expect(page.locator('.board-object[data-content-kind="note"]')).toHaveCount(1);

  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'history-frame.html', mimeType: 'text/html', buffer: Buffer.from('<style>body{margin:0}input{margin:20px}</style><input aria-label="Inside HTML text"><button>Board content</button>') });
  const html = page.locator('.board-object[data-content-kind="html"]'); await expect(html.locator('.html-snapshot')).toBeVisible();
  await page.locator('#whiteboard').click({ position: { x: 5, y: 5 } }); await page.mouse.move(5, 5); await html.locator('.html-content').hover(); await expect(html.locator('.html-live-frame')).toBeVisible();
  const frameInput = html.frameLocator('iframe').getByRole('textbox', { name: 'Inside HTML text', exact: true });
  await frameInput.fill('native html text'); const frameBeforeUndo = await frameInput.inputValue(); await frameInput.press('Meta+Z'); await expect.poll(() => frameInput.inputValue()).not.toBe(frameBeforeUndo);
  await expect(page.locator('.board-object[data-content-kind="html"]')).toHaveCount(1);
});

test('history availability stays isolated between sessions and note color is undoable', async ({ page, app }) => {
  await open(page, app);
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  const boardBox = (await page.locator('#whiteboard').boundingBox())!;
  await page.mouse.click(boardBox.x + boardBox.width / 2, boardBox.y + boardBox.height / 2);
  const note = page.locator('.board-object[data-content-kind="note"]'); await expect(note).toBeVisible();
  const noteId = await note.getAttribute('data-object-id');
  await expect(page.getByRole('button', { name: 'Note color', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Note color', exact: true }).hover(); await page.getByRole('radio', { name: 'Sage', exact: true }).click();
  await expect.poll(async () => (await app.state()).objects.find(object => object.id === noteId)?.fill).toBe('sage');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect.poll(async () => (await app.state()).objects.find(object => object.id === noteId)?.fill).toBeUndefined();
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await expect.poll(async () => (await app.state()).objects.find(object => object.id === noteId)?.fill).toBe('sage');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect.poll(async () => (await app.state()).objects.find(object => object.id === noteId)?.fill).toBeUndefined();
  await page.setViewportSize({ width: 320, height: 760 });
  const narrowUndo = await page.getByRole('button', { name: 'Undo', exact: true }).boundingBox(); expect(narrowUndo).not.toBeNull(); expect(narrowUndo!.x).toBeGreaterThanOrEqual(0); expect(narrowUndo!.x + narrowUndo!.width).toBeLessThanOrEqual(320); expect(narrowUndo!.y).toBeGreaterThanOrEqual(0); expect(narrowUndo!.y + narrowUndo!.height).toBeLessThanOrEqual(760);

  const first = await app.state(), second = await app.call('/api/sessions', 'POST', { name: 'Separate history scope' });
  const other = await page.context().newPage();
  try {
    await open(other, app, second.id);
    await expect(other.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(other.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
    await other.getByLabel('Import files into canvas', { exact: true }).setInputFiles(await png(other)); await expect(other.locator('.board-object')).toHaveCount(2);
    const otherObjectId = (await app.state(second.id)).objects.at(-1)!.id;
    await other.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(other.locator(`.board-object[data-object-id="${otherObjectId}"]`)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    expect((await app.state(first.session.id)).history.canRedo).toBe(true);
  } finally { await other.close(); }
});
