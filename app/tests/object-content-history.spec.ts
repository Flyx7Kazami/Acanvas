import { test as base, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer, type RunningServer } from '../src/server/http.js';
import type { BoardState } from '../src/shared/types.js';

type AppFixture = {
  root: string;
  server: RunningServer;
  token: string;
  call: (path: string, method?: string, body?: unknown) => Promise<any>;
  text: (assetId: string, sessionId?: string) => Promise<string>;
  state: (sessionId?: string) => Promise<BoardState>;
};

const test = base.extend<{ app: AppFixture }>({
  app: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'acanvas-object-content-history-browser-'));
    const server = await startServer({ root, port: 0, webRoot: resolve(process.env.ACANVAS_TEST_WEB_ROOT || 'dist/web') });
    const bootstrap = await (await fetch(`${server.url}/api/bootstrap`)).json() as { token: string };
    const call = async <T = any>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      const response = await fetch(`${server.url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json().catch(() => undefined);
      expect(response.ok, `API ${method} ${path}: ${JSON.stringify(value)}`).toBeTruthy();
      return value as T;
    };
    const text = async (assetId: string, sessionId?: string) => {
      const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
      const response = await fetch(`${server.url}/api/assets/${encodeURIComponent(assetId)}/content${suffix}`, { headers: { Authorization: `Bearer ${bootstrap.token}` } });
      expect(response.ok, `asset content ${assetId}`).toBeTruthy();
      return response.text();
    };
    const state = async (sessionId?: string) => call<BoardState>(`/api/state?sessionId=${encodeURIComponent(sessionId || (await call<{ id: string }[]>('/api/sessions'))[0].id)}`);
    try { await use({ root, server, token: bootstrap.token, call, text, state }); }
    finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  },
});

async function open(page: Page, app: AppFixture, sessionId?: string) {
  await page.goto(`${app.server.url}/${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`);
  await expect(page.locator('#whiteboard')).toBeVisible();
  await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved');
  await expect(page.locator('.connection-feedback')).toHaveCount(0);
}

async function addNote(page: Page) {
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
  const board = (await page.locator('#whiteboard').boundingBox())!;
  await page.mouse.click(board.x + board.width / 2, board.y + board.height / 2);
  const note = page.locator('.board-object[data-content-kind="note"]').last();
  await expect(note).toBeVisible();
  return { note, editor: note.locator('textarea.note-editor') };
}

async function objectText(app: AppFixture, sessionId: string, objectId: string) {
  const object = (await app.state(sessionId)).objects.find(value => value.id === objectId);
  return object ? app.text(object.assetId, sessionId) : undefined;
}

async function waitText(app: AppFixture, sessionId: string, objectId: string, expected: string) {
  await expect.poll(() => objectText(app, sessionId, objectId)).toBe(expected);
}

async function waitObject(app: AppFixture, sessionId: string, objectId: string, predicate: (object: BoardState['objects'][number] | undefined) => boolean) {
  await expect.poll(async () => predicate((await app.state(sessionId)).objects.find(value => value.id === objectId))).toBeTruthy();
}

test('a large board keeps editor selection and current camera interactions through zoom', async ({ page, app }) => {
  await open(page, app);
  const { note, editor } = await addNote(page);
  const initial = await app.state(), sessionId = initial.session.id, id = initial.objects[0].id;
  await editor.fill('Composition study'); await editor.blur(); await waitText(app, sessionId, id, 'Composition study');
  const response = await fetch(`${app.server.url}/api/assets?name=Study.svg&mime=image%2Fsvg%2Bxml`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}` }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#315ad9"/></svg>' });
  expect(response.ok).toBeTruthy(); const asset = await response.json();
  await app.call('/api/board/operations', 'POST', { sessionId, operations: Array.from({ length: 199 }, (_, index) => ({ type: 'create', object: { id: `study-${index}`, assetId: asset.id, x: 1800 + (index % 20) * 240, y: Math.floor(index / 20) * 180, width: 200, height: 120 } })) });
  await expect(page.locator('.board-object')).toHaveCount(200);
  await editor.focus();
  await editor.evaluate(element => { (window as any).studyEditor = element; (element as HTMLTextAreaElement).setSelectionRange(2, 8); });
  const box = (await editor.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, 120); await page.keyboard.up('Control');
  await expect.poll(async () => (await app.state(sessionId)).session.view.zoom).toBeLessThan(.7);
  expect(await editor.evaluate(element => ({ same: (window as any).studyEditor === element, start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd }))).toEqual({ same: true, start: 2, end: 8 });

  // A content-edge drag uses the camera from the completed zoom.
  const beforeDrag = (await app.state(sessionId)).objects.find(object => object.id === id)!;
  const camera = (await app.state(sessionId)).session.view, card = (await note.locator('.note-card').boundingBox())!;
  const dragStart = { x: card.x + card.width / 4, y: card.y + 2 };
  expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.classList.contains('note-card'), dragStart)).toBe(true);
  await page.keyboard.down('Alt'); await page.mouse.move(dragStart.x, dragStart.y); await page.mouse.down();
  await page.mouse.move(dragStart.x + 60, dragStart.y + 30, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Alt');
  await expect.poll(async () => (await app.state(sessionId)).objects.find(object => object.id === id)!.x).toBeCloseTo(beforeDrag.x + 60 / camera.zoom, 1);
  await expect.poll(async () => (await app.state(sessionId)).objects.find(object => object.id === id)!.y).toBeCloseTo(beforeDrag.y + 30 / camera.zoom, 1);
  const handle = page.locator(`[data-resize-id="${id}"][data-resize-corner="se"]`);
  await handle.focus(); await handle.press('ArrowRight');
  await expect.poll(async () => (await app.state(sessionId)).objects.find(object => object.id === id)!.width).toBe(beforeDrag.width + 10);
  await editor.fill('Revised composition'); await editor.blur(); await waitText(app, sessionId, id, 'Revised composition');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await waitText(app, sessionId, id, 'Composition study');
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await waitText(app, sessionId, id, 'Revised composition');
  await page.reload(); await expect(page.locator('.board-object')).toHaveCount(200);
  await expect(page.locator(`[data-object-id="${id}"] textarea.note-editor`)).toHaveValue('Revised composition');
});

test('note content forms A to B to C history and keeps a shared source independent', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  const { note, editor } = await addNote(page);
  const first = (await app.state(sessionId)).objects[0];

  await editor.fill('A'); await editor.blur(); await waitText(app, sessionId, first.id, 'A');
  await editor.fill('B'); await editor.blur(); await waitText(app, sessionId, first.id, 'B');
  await editor.fill('C'); await editor.blur(); await waitText(app, sessionId, first.id, 'C');
  const contentC = (await app.state(sessionId)).objects.find(value => value.id === first.id)!;

  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await waitText(app, sessionId, first.id, 'B');
  await page.locator(`.board-object[data-object-id="${first.id}"] textarea.note-editor`).press('Meta+Z'); await waitText(app, sessionId, first.id, 'A');
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await waitText(app, sessionId, first.id, 'B');
  await page.locator(`.board-object[data-object-id="${first.id}"] textarea.note-editor`).press('Meta+Shift+Z'); await waitText(app, sessionId, first.id, 'C');
  await expect.poll(async () => (await app.state(sessionId)).objects.find(value => value.id === first.id)?.assetId).toBe(contentC.assetId);

  await app.call('/api/board/operations', 'POST', { sessionId, operations: [{ type: 'create', object: { assetId: first.assetId, x: first.x + 360, y: first.y, width: first.width, height: first.height } }] });
  await expect(page.locator('.board-object[data-content-kind="note"]')).toHaveCount(2);
  const objects = (await app.state(sessionId)).objects.filter(value => value.assetId === first.assetId);
  const second = objects.find(value => value.id !== first.id)!;
  const firstEditor = page.locator(`.board-object[data-object-id="${first.id}"] textarea.note-editor`);
  await firstEditor.fill('first object only'); await firstEditor.blur(); await waitText(app, sessionId, first.id, 'first object only');
  await waitText(app, sessionId, second.id, '');
  await expect.poll(async () => (await app.state(sessionId)).objects.find(value => value.id === second.id)?.assetId).toBe(first.assetId);
});

test('mixed content, move, resize, color and delete undo in one FIFO history', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  const { note, editor } = await addNote(page);
  const first = (await app.state(sessionId)).objects[0];
  await editor.fill('A'); await editor.blur(); await waitText(app, sessionId, first.id, 'A');

  await note.locator('.object-caption').click();
  const beforeMove = (await app.state(sessionId)).objects.find(value => value.id === first.id)!;
  const moveBox = (await note.locator('.object-caption').boundingBox())!;
  await page.mouse.move(moveBox.x + moveBox.width / 2, moveBox.y + moveBox.height / 2); await page.mouse.down();
  await page.mouse.move(moveBox.x + moveBox.width / 2 + 60, moveBox.y + moveBox.height / 2 + 24, { steps: 3 }); await page.mouse.up();
  await waitObject(app, sessionId, first.id, value => !!value && (value.x !== beforeMove.x || value.y !== beforeMove.y));
  const moved = (await app.state(sessionId)).objects.find(value => value.id === first.id)!;

  await note.locator('.object-caption').click();
  const beforeResize = (await app.state(sessionId)).objects.find(value => value.id === first.id)!;
  const handle = page.locator(`[data-resize-id="${first.id}"][data-resize-corner="se"]`); await expect(handle).toBeVisible();
  const handleBox = (await handle.boundingBox())!;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2); await page.mouse.down();
  await page.mouse.move(handleBox.x + 40, handleBox.y + 20, { steps: 3 }); await page.mouse.up();
  await waitObject(app, sessionId, first.id, value => !!value && (value.width !== beforeResize.width || value.height !== beforeResize.height));
  const resized = (await app.state(sessionId)).objects.find(value => value.id === first.id)!;

  await page.getByRole('button', { name: 'Note color', exact: true }).hover(); await page.getByRole('radio', { name: 'Sage', exact: true }).click();
  await waitObject(app, sessionId, first.id, value => value?.fill === 'sage');
  const colorVersion = (await app.state(sessionId)).objects.find(value => value.id === first.id)!;
  const currentEditor = page.locator(`.board-object[data-object-id="${first.id}"] textarea.note-editor`);
  await currentEditor.fill('B'); await currentEditor.blur(); await waitText(app, sessionId, first.id, 'B');

  await page.getByRole('button', { name: 'Remove selected files from canvas', exact: true }).click(); await expect(page.locator('.board-object')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(page.locator(`.board-object[data-object-id="${first.id}"]`)).toBeVisible(); await waitText(app, sessionId, first.id, 'B');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await waitText(app, sessionId, first.id, 'A');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await waitObject(app, sessionId, first.id, value => value?.fill === undefined);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await waitObject(app, sessionId, first.id, value => !!value && value.width === beforeResize.width && value.height === beforeResize.height);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await waitObject(app, sessionId, first.id, value => !!value && value.x === beforeMove.x && value.y === beforeMove.y);
  expect(moved.x).not.toBe(beforeMove.x); expect(resized.width).not.toBe(beforeResize.width); expect(colorVersion.fill).toBe('sage');
});

test('undo flushes immediate and delayed note saves while typing continues', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  const firstCase = await addNote(page); const first = (await app.state(sessionId)).objects[0];
  let firstContentSeen = false; let releaseFirst!: () => void; const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.route('**/api/board/operations', async route => {
    const operations = route.request().postDataJSON()?.operations;
    if (Array.isArray(operations) && operations.some((operation: { type?: string }) => operation.type === 'content')) { firstContentSeen = true; await firstGate; }
    await route.continue();
  });
  await firstCase.editor.fill('A'); const immediateUndo = page.getByRole('button', { name: 'Undo', exact: true }); const immediatePromise = immediateUndo.click();
  await expect.poll(() => firstContentSeen).toBe(true); releaseFirst(); await immediatePromise; await waitText(app, sessionId, first.id, '');
  await page.unroute('**/api/board/operations');

  const secondCase = await addNote(page); await expect.poll(async () => (await app.state(sessionId)).objects.length).toBe(2); const second = (await app.state(sessionId)).objects.find(value => value.id !== first.id)!;
  const contentTexts: string[] = []; let saveCount = 0; let releaseSave!: () => void; const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  await page.route('**/api/board/operations', async route => {
    const operations = route.request().postDataJSON()?.operations;
    if (Array.isArray(operations) && operations.some((operation: { type?: string; text?: string }) => operation.type === 'content')) {
      const content = operations.find((operation: { type?: string; text?: string }) => operation.type === 'content'); contentTexts.push(content?.text || ''); saveCount++;
      if (saveCount === 1) await saveGate;
    }
    await route.continue();
  });
  await secondCase.editor.fill('A'); await expect.poll(() => saveCount).toBe(1); await secondCase.editor.press('End'); await page.keyboard.type('B'); await expect(secondCase.editor).toHaveValue('AB'); await expect.poll(() => secondCase.editor.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(2);
  const delayedUndo = page.getByRole('button', { name: 'Undo', exact: true }); const delayedPromise = delayedUndo.click(); releaseSave(); await delayedPromise;
  await expect.poll(() => saveCount).toBeGreaterThanOrEqual(2); await waitText(app, sessionId, second.id, 'A'); await delayedUndo.click(); await waitText(app, sessionId, second.id, ''); expect(contentTexts.slice(0, 2)).toEqual(['A', 'AB']);
  await page.unroute('**/api/board/operations');
});

test('IME keydown stays with composition and content history keeps focus through delayed rehydration', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  const { note, editor } = await addNote(page); const objectId = (await app.state(sessionId)).objects[0].id;
  await editor.fill('A'); await editor.blur(); await waitText(app, sessionId, objectId, 'A');
  await editor.fill('ABC'); await editor.blur(); await waitText(app, sessionId, objectId, 'ABC');

  await editor.focus();
  await editor.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })));
  await editor.evaluate(element => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', code: 'KeyZ', ctrlKey: true });
    Object.defineProperty(event, 'isComposing', { value: true });
    element.dispatchEvent(event);
  });
  await expect.poll(() => editor.inputValue()).toBe('ABC'); await expect(note).toHaveCount(1);
  await editor.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));

  await editor.focus(); await editor.evaluate(element => { const input = element as HTMLTextAreaElement; input.setSelectionRange(1, 1); });
  let releaseAsset!: () => void; let assetRequestSeen = false; const assetGate = new Promise<void>(resolve => { releaseAsset = resolve; });
  await page.route('**/api/assets/*/content*', async route => {
    if (!assetRequestSeen) { assetRequestSeen = true; await assetGate; }
    await route.continue();
  });
  const undo = page.getByRole('button', { name: 'Undo', exact: true }); const undoPromise = editor.press('Meta+Z');
  await expect.poll(() => assetRequestSeen).toBe(true); await expect(editor).toBeFocused(); releaseAsset(); await undoPromise;
  await waitText(app, sessionId, objectId, 'A'); await expect(editor).toBeFocused(); await expect.poll(() => editor.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(1);
  await editor.press('Meta+Shift+Z'); await waitText(app, sessionId, objectId, 'ABC'); await expect(editor).toBeFocused(); await expect(undo).toBeEnabled();
  await page.unroute('**/api/assets/*/content*');
});

test('Markdown source history updates preview and survives refresh', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'History.md', mimeType: 'text/markdown', buffer: Buffer.from('# Alpha\n\nOriginal body.') });
  const markdown = page.locator('.board-object[data-content-kind="markdown"]'); await expect(markdown).toBeVisible(); await expect(markdown.locator('.markdown-body')).toContainText('Alpha');
  const objectId = (await app.state(sessionId)).objects[0].id;
  await markdown.getByRole('button', { name: 'Edit Markdown', exact: true }).click();
  const source = markdown.locator('textarea.markdown-source'); await source.fill('# Banana\n\nEdited body.'); await markdown.getByRole('button', { name: 'Preview Markdown', exact: true }).click();
  await expect(markdown.locator('.markdown-body')).toContainText('Banana'); await waitText(app, sessionId, objectId, '# Banana\n\nEdited body.');
  await page.reload(); const refreshed = page.locator(`.board-object[data-object-id="${objectId}"]`); await expect(refreshed.locator('.markdown-body')).toContainText('Banana');
  await refreshed.getByRole('button', { name: 'Edit Markdown', exact: true }).click(); await refreshed.locator('textarea.markdown-source').press('Meta+Z'); await expect.poll(() => refreshed.locator('textarea.markdown-source').inputValue()).toContain('Alpha'); await waitText(app, sessionId, objectId, '# Alpha\n\nOriginal body.');
});

test('a dirty editor reports external deletion and restores its pending text after history undo', async ({ page, app }) => {
  await open(page, app);
  const sessionId = (await app.state()).session.id;
  const { note, editor } = await addNote(page); const object = (await app.state(sessionId)).objects[0];
  const second = await app.call('/api/sessions', 'POST', { name: 'External deletion' }) as { id: string };
  const other = await page.context().newPage();
  try {
    await open(other, app, second.id); await editor.fill('local pending');
    await app.call('/api/board/operations', 'POST', { sessionId: second.id, operations: [{ type: 'delete', objectId: object.id, expectedVersion: object.version }] });
    await expect.poll(async () => (await app.state(sessionId)).objects.some(value => value.id === object.id)).toBe(false); await expect(note).toHaveCount(0);
    await expect(page.getByRole('alert')).toContainText('removed from the canvas');
    await app.call('/api/board/undo', 'POST', { sessionId: second.id });
    await expect.poll(async () => (await app.state(sessionId)).objects.some(value => value.id === object.id)).toBe(true);
    const restored = page.locator(`.board-object[data-object-id="${object.id}"] textarea.note-editor`); await expect(restored).toBeVisible(); await expect.poll(() => restored.inputValue()).toBe('local pending');
  } finally { await other.close(); }
});
