import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import type { Page } from 'playwright-core';
import { startServer } from '../src/server/http.js';
import type { Asset, RequestReference } from '../src/shared/types.js';

async function fixture(t: test.TestContext, narrow = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-reference-ui-')));
  const evidence = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-reference-evidence-'))); t.diagnostic(`Evidence: ${evidence}`);
  const running = await startServer({ root, port: 0, webRoot: resolve('dist/web'), browser: { headless: true } });
  const session = running.service.createSession('Reference occurrences');
  await running.browser.open(session.id); const page = running.browser.page(session.id)!;
  if (narrow) await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.locator('#whiteboard')).toBeVisible();
  const bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json();
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${running.url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
  };
  const saved = async () => { await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved'); return running.service.draft(session.id); };
  const image = async (name = 'Repeated.png') => {
    const data = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 240; canvas.getContext('2d')!.fillRect(0, 0, 400, 240); return canvas.toDataURL('image/png').split(',')[1]; });
    const response = await fetch(`${running.url}/api/assets?name=${encodeURIComponent(name)}&mime=image/png`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: new Uint8Array(Buffer.from(data, 'base64')) });
    assert(response.ok); return response.json() as Promise<Asset>;
  };
  const object = async () => {
    const asset = await image(); await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, x: 40, y: 100, width: 180, height: 108 } }] });
    const value = running.service.objects().at(-1)!; await expect(page.locator(`[data-object-id="${value.id}"]`)).toBeVisible(); return value;
  };
  t.after(async () => {
    if (!page.isClosed()) { await page.screenshot({ path: join(evidence, 'final-ui.png') }); await writeFile(join(evidence, 'state.json'), JSON.stringify(running.service.state(session.id), null, 2)); }
    await running.close(); await rm(root, { recursive: true, force: true });
  });
  return { page, evidence, session, running, call, saved, object, state: () => running.service.state(session.id) };
}

async function select(page: Page, start: number, end = start) {
  await page.locator('#instruction').evaluate((root, selection) => {
    (root as HTMLElement).focus();
    const point = (position: number): [Node, number] => {
      let cursor = 0;
      for (const node of Array.from(root.childNodes)) {
        const length = node.nodeType === Node.TEXT_NODE ? node.textContent?.length || 0 : 1;
        if (node.nodeType === Node.TEXT_NODE && position <= cursor + length) return [node, position - cursor];
        if (position <= cursor) return [root, Array.from(root.childNodes).indexOf(node)];
        cursor += length;
      }
      return [root, root.childNodes.length];
    };
    const range = document.createRange(); range.setStart(...point(selection.start)); range.setEnd(...point(selection.end));
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange'));
  }, { start, end });
}

test('reselecting one object creates individual atoms with neutral preview styling and one removable occurrence', async t => {
  const app = await fixture(t, true), { page } = app, object = await app.object();
  await page.locator('#instruction').fill('前😀后'); await select(page, 3);
  const formal = page.locator('#instruction .chatbox-reference'), preview = page.locator('#instruction .chatbox-reference-preview');
  const appearance = (locator: typeof preview) => locator.evaluate(element => { const style = getComputedStyle(element); return { background: style.backgroundColor, border: style.borderTopColor, color: style.color }; });
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') { await page.getByRole('button', { name: 'Theme', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click(); }
    await page.locator(`[data-object-id="${object.id}"]`).click({ position: { x: 90, y: 54 } });
    await page.mouse.move(5, 5);
    await expect(preview).toHaveCount(1); const before = await appearance(preview);
    await preview.hover(); const hoveredPreview = await appearance(preview); assert.notEqual(hoveredPreview.background, before.background);
    await preview.screenshot({ path: join(app.evidence, `${theme}-preview.png`) });
    await page.getByRole('button', { name: 'Add selected Repeated.png to request', exact: true }).click();
    await expect(formal).toHaveCount(theme === 'light' ? 1 : 2);
    await page.mouse.move(5, 5);
    const after = await appearance(formal.first()); assert.equal(after.background, before.background); assert.equal(after.border, before.border); assert.notEqual(after.color, before.color);
    await formal.first().hover(); const hoveredFormal = await appearance(formal.first()); assert.equal(hoveredFormal.background, hoveredPreview.background); assert.notEqual(hoveredFormal.background, after.background);
    await page.mouse.move(5, 5);
    assert.deepEqual(await formal.locator('span[title]').allTextContents(), Array(theme === 'light' ? 1 : 2).fill('Repeated.png'));
    await page.locator('.composer').screenshot({ path: join(app.evidence, `${theme}-confirmed.png`) });
    await app.saved();
  }
  const expected: RequestReference[] = [{ kind: 'object', id: object.id, textOffset: 3 }, { kind: 'object', id: object.id, textOffset: 3 }];
  assert.deepEqual((await app.saved()).references, { objectIds: [object.id], taskIds: [], order: expected });
  const hosts = await page.locator('#instruction .inline-reference-node').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.editorHost));
  assert.equal(new Set(hosts).size, 2);
  // A board update and theme update re-render the composer with the same consumed selection.
  await app.call('/api/board/operations', 'POST', { sessionId: app.session.id, operations: [{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x: 45 } }] });
  await page.getByRole('button', { name: 'Theme', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click(); await expect(formal).toHaveCount(2); await expect(preview).toHaveCount(0);
  await formal.nth(1).getByRole('button', { name: 'Remove reference Repeated.png', exact: true }).click();
  await expect(formal).toHaveCount(1); assert.deepEqual((await app.saved()).references.order, [expected[0]]);
  await page.reload(); await expect(formal).toHaveCount(1); assert.deepEqual((await app.saved()).references.order, [expected[0]]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test('repeated @ object and task queries retain every Send and queued edit occurrence in body order', async t => {
  const app = await fixture(t), { page } = app, object = await app.object();
  let draft = await app.saved(); draft = await app.call(`/api/sessions/${app.session.id}/draft`, 'PUT', { ...draft, text: 'Earlier source' });
  const earlier = (await app.call(`/api/sessions/${app.session.id}/tasks`, 'POST', { draftId: draft.id, expectedRevision: draft.revision })).task;
  await page.reload(); await page.locator('#instruction').fill('前😀 '); await select(page, 4);
  const queries = ['@Repeated', ' @Repeated', ' @Request 1', ' @Request 1'];
  for (const query of queries) {
    await page.keyboard.type(query); await expect(page.getByRole('listbox', { name: 'Choose a reference' })).toBeVisible(); await page.keyboard.press('Enter'); await app.saved();
  }
  await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(4);
  const value = await app.saved(), order = value.references.order!;
  assert.deepEqual(value.references.objectIds, [object.id]); assert.deepEqual(value.references.taskIds, [earlier.id]);
  assert.deepEqual(order.map(reference => reference.textOffset), [4, 5, 6, 7]);
  assert.deepEqual(order.map(reference => reference.kind), ['object', 'object', 'task', 'task']);
  await page.reload(); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(4); assert.deepEqual((await app.saved()).references.order, order);
  await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect(page.locator('.queue-item')).toHaveCount(2);
  const task = app.state().tasks[1]; assert.deepEqual(task.snapshot.requestReferences!.order!.map(({ kind, id, textOffset }) => ({ kind, id, textOffset })), order);
  assert.equal(task.snapshot.referenceContent.objects.length, 1); assert.equal(task.snapshot.referenceContent.assets.length, 1); assert.equal(task.snapshot.referenceContent.taskIds.length, 1);
  await page.locator('.queue-expand').click(); await page.getByRole('button', { name: /View request 2:/ }).click();
  const queueRefs = page.locator(`[data-task-id="${task.id}"] .task-inline-reference`); await expect(queueRefs).toHaveCount(4);
  assert.deepEqual(await queueRefs.evaluateAll(elements => elements.map(element => element.lastElementChild?.textContent)), ['Repeated.png', 'Repeated.png', 'Request 1', 'Request 1']);
  await page.getByRole('button', { name: 'Edit request 2', exact: true }).click(); await expect(page.getByRole('button', { name: 'Save edit', exact: true })).toBeVisible();
  await page.locator('#instruction .chatbox-reference[data-reference-kind="task"]').nth(1).getByRole('button').click();
  let edited = await app.saved(); assert.deepEqual(edited.references.taskIds, [earlier.id]); assert.deepEqual(edited.references.order, order.slice(0, 3));
  await select(page, 0); await page.keyboard.insertText('新😀\n'); edited = await app.saved();
  assert.deepEqual(edited.references.order?.map(reference => reference.textOffset), [8, 9, 10]);
  await page.getByRole('button', { name: 'Save edit', exact: true }).click(); await expect(page.locator('.composer-editing')).toHaveCount(0);
  const revised = app.state().tasks[1]; assert.equal(revised.id, task.id); assert.equal(revised.sequence, task.sequence);
  assert.deepEqual(revised.snapshot.requestReferences!.order!.map(({ kind, id, textOffset }) => ({ kind, id, textOffset })), edited.references.order);
});

test('native IME and atomic keyboard deletion preserve equal-position occurrences of one source', async t => {
  const app = await fixture(t), { page } = app, object = await app.object();
  const order = Array.from({ length: 3 }, () => ({ kind: 'object' as const, id: object.id, textOffset: 3 }));
  await app.call(`/api/sessions/${app.session.id}/draft`, 'PUT', { ...await app.saved(), text: '前😀后', references: { objectIds: [object.id], taskIds: [], order } });
  await page.reload(); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(3); await select(page, 0);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 });
  await page.locator('#instruction').dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true }); assert.equal(app.state().tasks.length, 0);
  await cdp.send('Input.insertText', { text: '你好' }); await cdp.detach();
  assert.equal((await app.saved()).text, '你好前😀后'); assert.deepEqual((await app.saved()).references.order?.map(reference => reference.textOffset), [5, 5, 5]);
  await select(page, 7); await page.keyboard.press('Backspace'); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(2);
  assert.equal((await app.saved()).text, '你好前😀后'); assert.deepEqual((await app.saved()).references.order?.map(reference => reference.textOffset), [5, 5]);
  await select(page, 5); await page.keyboard.press('Delete'); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(1);
  assert.deepEqual((await app.saved()).references.objectIds, [object.id]); assert.deepEqual((await app.saved()).references.order?.map(reference => reference.textOffset), [5]);
  await select(page, 5); await page.keyboard.press('Delete'); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(0);
  assert.deepEqual((await app.saved()).references, { objectIds: [], taskIds: [], order: [] });
  assert.equal((await app.saved()).text, '你好前😀后');
});
