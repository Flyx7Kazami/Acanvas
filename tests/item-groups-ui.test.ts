import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import type { Page } from 'playwright-core';
import { startServer } from '../src/server/http.js';
import type { Asset, BoardObject } from '../src/shared/types.js';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-group-ui-')));
  const evidence = process.env.ACANVAS_GROUP_EVIDENCE_DIR ? resolve(process.env.ACANVAS_GROUP_EVIDENCE_DIR) : await realpath(await mkdtemp(join(tmpdir(), 'acanvas-group-ui-evidence-')));
  await mkdir(evidence, { recursive: true }); t.diagnostic(`Group evidence: ${evidence}`);
  const running = await startServer({ root, port: 0, webRoot: resolve(process.env.ACANVAS_TEST_WEB_ROOT || 'dist/web'), browser: { headless: true } });
  const session = running.service.createSession('Group acceptance');
  const observation: { page?: Page } = {};
  t.after(async () => { try { await observation.page?.screenshot({ path: join(evidence, 'final.png') }).catch(() => undefined); await writeFile(join(evidence, 'state.json'), JSON.stringify(running.service.state(session.id), null, 2)); } finally { await running.close(); await rm(root, { recursive: true, force: true }); } });
  await running.browser.open(session.id); const page = running.browser.page(session.id)!; observation.page = page;
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('#whiteboard')).toBeVisible();
  const bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json();
  const call = async (path: string, body: unknown) => {
    const response = await fetch(`${running.url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
  };
  const upload = async (name: string, mime: string, bytes: Buffer) => {
    const response = await fetch(`${running.url}/api/assets?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: bytes as BodyInit });
    assert(response.ok); return response.json() as Promise<Asset>;
  };
  const picture = async (name: string, color: string) => {
    const encoded = await page.evaluate(({ color, name }) => { const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200; const ctx = canvas.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 200); ctx.fillStyle = '#F3EBDD'; ctx.beginPath(); ctx.arc(230, 70, 45, 0, Math.PI * 2); ctx.fill(); ctx.font = '24px sans-serif'; ctx.fillText(name, 20, 160); return canvas.toDataURL().split(',')[1]; }, { color, name });
    return upload(name, 'image/png', Buffer.from(encoded, 'base64'));
  };
  const add = async (asset: Asset, x: number, y: number, width = 180, height = 120) => {
    const before = new Set(running.service.objects().map(object => object.id));
    await call('/api/board/operations', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, x, y, width, height } }] });
    const object = running.service.objects().find(object => !before.has(object.id))!;
    await expect(page.locator(`[data-object-id="${object.id}"]`)).toBeVisible(); return object;
  };
  return { running, session, page, call, upload, picture, add, evidence, state: () => running.service.state(session.id) };
}

test('item groups use real selection, folders, navigation, editing and current-layer capture', { timeout: 120_000 }, async t => {
  const f = await fixture(t), { page, evidence } = f;
  await mkdir(evidence, { recursive: true });
  const a = await f.add(await f.picture('Study 01', '#315AD9'), 220, 210);
  const b = await f.add(await f.picture('Study 02', '#779D85'), 430, 210);
  const c = await f.add(await f.picture('Outside', '#EA6848'), 760, 210);
  const note = await f.upload('Field notes', 'text/x-acanvas-note', Buffer.from('Shapes, color, composition.'));
  const n = await f.add(note, 220, 390, 240, 128);
  const below = await f.add(await f.picture('Below', '#ADA0DE'), 220, 640, 180, 120);
  // A native marquee selects exactly the three members.
  await page.mouse.move(190, 180); await page.mouse.down(); await page.mouse.move(650, 550, { steps: 8 }); await page.mouse.up();
  await expect(page.locator('.board-object.selected')).toHaveCount(3);
  await page.getByRole('button', { name: 'Group', exact: true }).click();
  await expect(page.locator('.group-frame')).toHaveCount(1);
  await expect(page.locator('.group-frame .group-name-slot')).toHaveText('Group 1');
  let group = f.state().groups[0]; assert.deepEqual(new Set(group.objectIds), new Set([a.id, b.id, n.id]));
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Group name', exact: true }); await name.fill('Color studies'); await name.press('Enter');
  await expect.poll(() => f.state().groups[0].name).toBe('Color studies');
  await page.screenshot({ path: join(evidence, 'frame.png') });
  // Moving the title persists a whole-group translation.
  const title = page.getByRole('button', { name: 'Select group Color studies', exact: true });
  const titleBox = (await title.boundingBox())!;
  await page.mouse.move(titleBox.x + 15, titleBox.y + 10); await page.mouse.down(); await page.mouse.move(titleBox.x + 45, titleBox.y + 40, { steps: 6 }); await page.mouse.up();
  await expect.poll(() => f.state().objects.find(object => object.id === a.id)!.x).toBeGreaterThan(a.x);
  await page.getByRole('button', { name: 'Store in folder', exact: true }).click();
  await expect(page.locator('.group-folder')).toHaveCount(1);
  await expect(page.locator('.board-object')).toHaveCount(2);
  group = f.state().groups[0];
  const folder = page.getByRole('button', { name: 'Open folder Color studies', exact: true });
  assert.equal(await folder.locator('.folder-preview-card').count(), 3);
  const belowAfter = f.state().objects.find(object => object.id === below.id)!; assert(belowAfter.y < below.y);
  const captionBox = (await page.locator('.group-folder .folder-caption').boundingBox())!, belowBox = (await page.locator(`[data-object-id="${below.id}"]`).boundingBox())!;
  assert(belowBox.y >= captionBox.y + captionBox.height + 24, 'The compacted item clears the folder caption by at least 24px.');
  assert.equal(await folder.evaluate(element => getComputedStyle(element).boxShadow), 'none');
  await page.screenshot({ path: join(evidence, 'folder.png') });
  // Root Done captures folder art while its members stay out of presentation metadata.
  const folderBox = (await folder.boundingBox())!;
  await page.getByRole('button', { name: 'Mark canvas', exact: true }).click();
  await page.mouse.move(folderBox.x - 12, folderBox.y - 12); await page.mouse.down(); await page.mouse.move(folderBox.x + folderBox.width + 12, folderBox.y + folderBox.height + 40, { steps: 5 }); await page.mouse.up();
  await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Folder on the main board');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => f.state().draft.annotations.at(-1)?.captureState?.status, { timeout: 20_000 }).toBe('complete');
  const rootCapture = f.state().draft.annotations.at(-1)!.capture!;
  assert(rootCapture.presentation!.layers.every(layer => !group.objectIds.includes(layer.objectId)));
  assert(rootCapture.presentation!.layers.every(layer => f.state().objects.some(object => object.id === layer.objectId)));
  await writeFile(join(evidence, 'folder-annotation.png'), Buffer.from(await (await fetch(`${f.running.url}/api/assets/${rootCapture.screenshotAssetId}/content?sessionId=${f.session.id}`, { headers: { Authorization: `Bearer ${(await (await fetch(`${f.running.url}/api/bootstrap`)).json()).token}` } })).arrayBuffer()));
  const parent = await page.locator('.canvas-world').getAttribute('style');
  await folder.click(); await expect(page.getByRole('button', { name: 'Back to board', exact: true })).toBeVisible();
  await expect(page.locator('.board-object:not(.group-exterior)')).toHaveCount(3);
  await expect(page.locator('.board-object.group-exterior')).toHaveCount(2);
  await expect(page.locator('.canvas-world')).not.toHaveAttribute('data-transition-kind', /.+/);
  assert.equal(await page.locator(`[data-object-id="${c.id}"]`).getAttribute('inert'), '');
  await page.screenshot({ path: join(evidence, 'secondary.png') });
  // Existing media and text retain normal editing and keyboard movement.
  const current = f.state().objects.find(object => object.id === a.id)!;
  await page.locator(`[data-object-id="${a.id}"]`).focus(); await page.keyboard.press('Enter'); await page.keyboard.press('ArrowRight');
  await expect.poll(() => f.state().objects.find(object => object.id === a.id)!.x).toBe(current.x + 10);
  await page.getByRole('button', { name: 'Add note', exact: true }).click(); await page.mouse.click(740, 580);
  await expect(page.locator('.note-editor').last()).toBeFocused(); await page.locator('.note-editor').last().fill('Inside the collection');
  await expect.poll(() => f.state().objects.filter(object => object.groupId === group.id).length).toBe(4);
  const input = page.getByLabel('Import files into canvas', { exact: true });
  await input.setInputFiles({ name: 'Imported.txt', mimeType: 'text/plain', buffer: Buffer.from('Group import') });
  await expect.poll(() => f.state().objects.filter(object => object.groupId === group.id).length).toBe(5);
  // A region annotation belongs to the current group and captures only rendered layers.
  await page.getByRole('button', { name: 'Mark canvas', exact: true }).click(); await page.mouse.move(100, 150); await page.mouse.down(); await page.mouse.move(1170, 780, { steps: 6 }); await page.mouse.up();
  const comment = page.getByRole('textbox', { name: 'Add a comment', exact: true }); await expect(comment).toBeVisible(); await comment.fill('Collection context');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => f.state().draft.annotations.find(value => value.text === 'Collection context')?.captureState?.status, { timeout: 20_000 }).toBe('complete');
  const annotation = f.state().draft.annotations.find(value => value.text === 'Collection context')!; assert.equal(annotation.boardGroupId, group.id); assert(annotation.capture);
  const layers = annotation.capture.presentation!.layers; assert(layers.every(layer => f.state().objects.some(object => object.id === layer.objectId)));
  await writeFile(join(evidence, 'secondary-annotation.png'), await (await fetch(`${f.running.url}/api/assets/${annotation.capture.screenshotAssetId}/content?sessionId=${f.session.id}`, { headers: { Authorization: `Bearer ${(await (await fetch(`${f.running.url}/api/bootstrap`)).json()).token}` } })).arrayBuffer().then(bytes => Buffer.from(bytes)));
  await page.getByRole('button', { name: 'Back to board', exact: true }).click();
  await expect(page.locator('.canvas-world')).toHaveAttribute('style', parent!);
  await expect(page.locator(`.canvas-annotation-note[data-annotation-id="${annotation.id}"]`)).toHaveCount(0);
  await expect.poll(() => f.state().session.view.activeGroupId).toBeUndefined();
  await page.reload(); await expect(page.locator('.group-folder')).toHaveCount(1); assert.equal(f.state().groups[0].color, group.color);
  // Keyboard entry and responsive, dark presentation retain the same controls.
  await page.setViewportSize({ width: 390, height: 760 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Theme', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click();
  await page.getByRole('button', { name: 'Fit all files', exact: true }).click();
  const narrowFolder = page.getByRole('button', { name: 'Open folder Color studies', exact: true }); await narrowFolder.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Back to board', exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'secondary-dark-390.png') });
  await page.getByRole('button', { name: 'Expand on board', exact: true }).click(); await expect(page.locator('.group-frame')).toHaveCount(1);
  await page.getByRole('button', { name: 'Select group Color studies', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Ungroup', exact: true }).focus(); await page.keyboard.press('Enter'); await expect(page.locator('.board-group')).toHaveCount(0);
  assert.equal(f.state().objects.length, 7); assert(f.state().objects.every(object => !object.groupId));
  // Region captures keep their identity after the collection is dissolved.
  await page.locator('.annotation-content').last().click();
  await expect(page.getByRole('textbox', { name: 'Annotation text', exact: true })).toBeVisible();
  assert.equal(f.state().draft.annotations.at(-1)!.boardGroupId, group.id);
  assert.equal(f.state().draft.annotations.at(-1)!.capture!.id, annotation.capture.id);
  await page.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('Collection context after ungroup');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Annotation text', exact: true })).toHaveCount(0);
  await page.locator(`[data-object-id="${a.id}"]`).focus(); await page.keyboard.press('Enter');
  const targetBox = (await page.locator(`[data-object-id="${a.id}"]`).boundingBox())!;
  await page.getByRole('button', { name: 'Mark canvas', exact: true }).click(); await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
  await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Retained object capture'); await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => f.state().draft.annotations.find(value => value.text === 'Retained object capture')?.captureState?.status, { timeout: 20_000 }).toBe('complete');
  await page.locator(`[data-object-id="${a.id}"]`).focus(); await page.keyboard.press('Enter'); await page.getByRole('button', { name: 'Remove selected files from canvas', exact: true }).click();
  await expect(page.locator(`[data-object-id="${a.id}"]`)).toHaveCount(0);
  await page.locator('.annotation-content').last().click();
  const retainedText = page.getByRole('textbox', { name: 'Annotation text', exact: true }); await expect(retainedText).toBeVisible(); await retainedText.fill('Retained capture after source removal');
  await expect(page.getByText('Source removed', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => f.state().draft.annotations.at(-1)?.text).toBe('Retained capture after source removal');
  // A removed focused group does not mask a newly selected group.
  await page.locator(`[data-object-id="${b.id}"]`).focus(); await page.keyboard.press('Enter');
  await page.locator(`[data-object-id="${n.id}"]`).focus(); await page.keyboard.press('Shift+Enter');
  await page.getByRole('button', { name: 'Group', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select group Group 2', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ungroup', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  const regroupName = page.getByRole('textbox', { name: 'Group name', exact: true }); await regroupName.fill('Regrouped'); await regroupName.press('Enter');
  await expect.poll(() => f.state().groups[0]?.name).toBe('Regrouped');
  await expect(page.getByRole('button', { name: 'Ungroup', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Ungroup', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.board-group')).toHaveCount(0);

});

test('layer projection excludes hidden snap targets and keeps asynchronous import ownership', { timeout: 90_000 }, async t => {
  const f = await fixture(t), { page } = f;
  const image = await f.picture('Material', '#315AD9');
  const a = await f.add(image, 200, 210), b = await f.add(image, 430, 210);
  const c = await f.add(image, 850, 210), d = await f.add(image, 1080, 210);
  const createGroup = async (id: string, name: string, objects: BoardObject[]) => f.call('/api/board/operations', { sessionId: f.session.id, operations: [{ type: 'group.create', group: { id, name, objectIds: objects.map(object => object.id) }, expectedVersions: Object.fromEntries(objects.map(object => [object.id, object.version])) }] });
  await createGroup('group-a', 'First collection', [a, b]); await createGroup('group-b', 'Second collection', [c, d]);
  for (const id of ['group-a', 'group-b']) {
    const group = f.state().groups.find(group => group.id === id)!;
    await f.call('/api/board/operations', { sessionId: f.session.id, operations: [{ type: 'group.update', groupId: id, expectedVersion: group.version, changes: { mode: 'folder' } }] });
  }
  await expect(page.locator('.group-folder')).toHaveCount(2);
  const secondGroup = f.state().groups.find(group => group.id === 'group-b')!;
  await f.call('/api/board/operations', { sessionId: f.session.id, operations: [{ type: 'group.update', groupId: secondGroup.id, expectedVersion: secondGroup.version, changes: { x: 950 } }] });
  const hidden = f.state().objects.find(object => object.id === b.id)!;
  const targetX = hidden.x + hidden.width + 3;
  const free = await f.add(image, targetX + 100, 420, 100, 80);
  const freeCaption = (await page.locator(`[data-object-id="${free.id}"] .object-caption`).boundingBox())!;
  await page.mouse.move(freeCaption.x + 15, freeCaption.y + 8); await page.mouse.down(); await page.mouse.move(freeCaption.x - 85, freeCaption.y + 8, { steps: 6 }); await page.mouse.up();
  await expect.poll(() => f.state().objects.find(object => object.id === free.id)!.x).toBe(targetX);
  await expect(page.getByRole('button', { name: 'Select files', exact: true })).toBeEnabled();
  // Fit includes folder placeholders and the free item, then keyboard entry isolates group A.
  await page.getByRole('button', { name: 'Open folder First collection', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Back to board', exact: true })).toBeVisible();
  let reached!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => reached = resolve), gate = new Promise<void>(resolve => release = resolve);
  await page.route('**/api/assets?*', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); reached(); await gate; await route.fulfill({ response });
  });
  await page.getByLabel('Import files into canvas', { exact: true }).setInputFiles({ name: 'Delayed import.txt', mimeType: 'text/plain', buffer: Buffer.from('Belongs to the first collection.') });
  await pending;
  await page.getByRole('button', { name: 'Back to board', exact: true }).click();
  await page.getByRole('button', { name: 'Open folder Second collection', exact: true }).focus(); await page.keyboard.press('Enter');
  release(); await expect.poll(() => f.state().objects.length).toBe(6);
  const imported = f.state().objects.find(object => f.state().assets.find(asset => asset.id === object.assetId)?.name === 'Delayed import.txt')!;
  assert.equal(imported.groupId, 'group-a');
  await expect(page.locator('.board-object:not(.group-exterior)')).toHaveCount(2);
  await expect(page.locator(`[data-object-id="${imported.id}"]`)).toHaveCount(0);
  // The free item is visible as a blurred exterior but never influences dragging inside group B.
  await expect(page.locator('.canvas-world')).not.toHaveAttribute('data-transition-kind', /.+/);
  const member = f.state().objects.find(object => object.id === c.id)!;
  const currentFree = f.state().objects.find(object => object.id === free.id)!;
  await f.call('/api/board/operations', { sessionId: f.session.id, operations: [{ type: 'update', objectId: free.id, expectedVersion: currentFree.version, changes: { x: member.x + 117, y: member.y + 220 } }] });
  await expect(page.locator(`[data-object-id="${free.id}"]`)).toHaveClass(/group-exterior/);
  const caption = (await page.locator(`[data-object-id="${c.id}"] .object-caption`).boundingBox())!;
  const transform = await page.locator('.canvas-world').getAttribute('style'); const zoom = Number(/scale\(([^)]+)\)/.exec(transform!)![1]);
  await page.mouse.move(caption.x + 15, caption.y + 8); await page.mouse.down(); await page.mouse.move(caption.x + 15 + 220 * zoom, caption.y + 8, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => f.state().objects.find(object => object.id === c.id)!.x).toBe(member.x + 220);
  await page.setViewportSize({ width: 320, height: 700 });
  const navigation = (await page.locator('.group-navigation').boundingBox())!;
  assert(navigation.x >= 0 && navigation.x + navigation.width <= 320);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Group name', exact: true }); await name.fill('Second'); await name.press('Enter');
  await expect.poll(() => f.state().groups.find(group => group.id === 'group-b')!.name).toBe('Second');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Back to board', exact: true }).click();
  await expect(page.locator('.canvas-world')).not.toHaveAttribute('data-transition-kind', /.+/);
  await page.getByRole('button', { name: 'Reset zoom to 100%', exact: true }).click();
  await expect.poll(() => page.locator('.canvas-world').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a)).toBe(1);
  // An object and a group may have the same persistent ID; their snap units remain distinct.
  const e = await f.add(image, 24, 40, 120, 80), h = await f.add(image, 144, 110, 72, 60);
  await createGroup(free.id, 'Shared ID collection', [e, h]);
  const collision = f.state().groups.find(group => group.id === free.id)!;
  await f.call('/api/board/operations', { sessionId: f.session.id, operations: [{ type: 'group.update', groupId: collision.id, expectedVersion: collision.version, changes: { mode: 'folder' } }] });
  const placeFree = async (x: number) => {
    const object = f.state().objects.find(object => object.id === free.id)!;
    await f.call('/api/board/operations', { sessionId: f.session.id, operations: [{ type: 'update', objectId: object.id, expectedVersion: object.version, changes: { x, y: 350 } }] });
    await expect(page.locator(`[data-object-id="${free.id}"]`)).toHaveCSS('left', `${x}px`);
  };
  await placeFree(500);
  const sharedCaption = (await page.locator(`[data-object-id="${free.id}"] .object-caption`).boundingBox())!;
  await page.mouse.move(sharedCaption.x + 15, sharedCaption.y + 8); await page.mouse.down(); await page.mouse.move(sharedCaption.x + 15 - 287, sharedCaption.y + 8, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => f.state().objects.find(object => object.id === free.id)!.x).toBe(216);
  await placeFree(300); await page.locator(`[data-object-id="${free.id}"]`).focus(); await page.keyboard.press('Enter');
  const handle = (await page.locator(`[data-resize-id="${free.id}"][data-resize-corner="nw"]`).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down(); await page.mouse.move(handle.x + handle.width / 2 - 87, handle.y + handle.height / 2 - 69.6, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => f.state().objects.find(object => object.id === free.id)!.x).toBe(216);
  assert.equal(f.state().groups.find(group => group.id === free.id)!.x, 0);
});

test('group names, hover actions, independent selection and camera transitions follow native controls', { timeout: 100_000 }, async t => {
  const f = await fixture(t), { page } = f;
  const image = await f.picture('Archive', '#315AD9'), a = await f.add(image, 220, 210), b = await f.add(image, 430, 390);
  await f.call('/api/board/operations', { sessionId: f.session.id, operations: [{ type: 'group.create', group: { id: 'archive', name: 'Archive', objectIds: [a.id, b.id], color: 'cobalt' }, expectedVersions: { [a.id]: a.version, [b.id]: b.version } }] });
  const frame = page.locator('[data-group-id="archive"]'); await expect(frame).toBeVisible();
  await page.mouse.click(600, 190); // Empty frame area selects the group.
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeVisible();
  await expect(page.locator('.board-object.selected')).toHaveCount(0); assert.equal(await frame.getAttribute('class'), 'board-group group-frame');
  const original = (await frame.locator('.group-name-slot').boundingBox())!;
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Group name', exact: true }); await expect(input).toBeFocused();
  const box = (await input.boundingBox())!; assert(Math.abs(box.x - original.x) < 1 && Math.abs(box.y - original.y) < 1 && Math.abs(box.width - original.width) < 1);
  const appearance = await input.evaluate(element => { const style = getComputedStyle(element); return [style.borderWidth, style.outlineWidth, style.boxShadow, style.backgroundColor]; });
  assert.deepEqual(appearance, ['0px', '0px', 'none', 'rgba(0, 0, 0, 0)']);
  await input.fill('Cancel'); await input.press('Escape'); assert.equal(f.state().groups[0].name, 'Archive');
  await page.getByRole('button', { name: 'Rename', exact: true }).click(); await input.fill('档案');
  await input.dispatchEvent('compositionstart'); await input.press('Enter'); await expect(input).toBeVisible(); assert.equal(f.state().groups[0].name, 'Archive');
  await input.dispatchEvent('compositionend'); await input.press('Enter'); await expect.poll(() => f.state().groups[0].name).toBe('档案');
  await expect(page.locator('.board-object.selected')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select files', exact: true })).toBeEnabled();
  const before = f.state().objects.find(object => object.id === a.id)!;
  await page.mouse.move(600, 190); await page.mouse.down(); await page.mouse.move(630, 220, { steps: 5 }); await page.mouse.up();
  await expect.poll(() => f.state().objects.find(object => object.id === a.id)!.x).toBe(before.x + 30);
  await expect(page.getByRole('button', { name: 'Store in folder', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Mark canvas', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Add a comment', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Add a comment', exact: true }).fill('Whole collection'); await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => f.state().draft.annotations.find(value => value.text === 'Whole collection')?.captureState?.status).toBe('complete');
  assert.deepEqual(new Set(f.state().draft.annotations.find(value => value.text === 'Whole collection')!.objectIds), new Set([a.id, b.id]));
  await expect(page.locator('.board-object.selected')).toHaveCount(0);
  await page.getByRole('button', { name: 'Store in folder', exact: true }).click();
  await expect(page.locator('.canvas-world')).not.toHaveAttribute('data-transition-kind', /.+/);
  await page.mouse.click(1050, 700); // Clear independent selection before testing hover.
  const folder = page.getByRole('button', { name: 'Open folder 档案', exact: true }); await folder.hover();
  const rename = page.getByRole('button', { name: 'Rename', exact: true }); await expect(rename).toBeVisible();
  const action = (await rename.boundingBox())!, folderArea = (await folder.boundingBox())!;
  await page.mouse.move(action.x + action.width / 2, folderArea.y - 4, { steps: 4 }); await page.mouse.move(action.x + action.width / 2, action.y + action.height / 2, { steps: 4 });
  await expect(rename).toBeVisible(); await rename.click();
  const folderName = (await input.boundingBox())!; assert(folderName.y >= folderArea.y + 224); await input.fill('Field archive'); await input.press('Enter');
  await expect.poll(() => f.state().groups[0].name).toBe('Field archive');
  await page.locator('.group-folder').screenshot({ path: join(f.evidence, 'folder-closeup.png') });
  // Repeated zoom clicks accumulate from the pending destination, while display has real eased intermediate frames.
  const zoom = () => page.locator('.canvas-world').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
  await page.evaluate(() => { const button = document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!; button.click(); button.click(); button.click(); });
  await page.waitForTimeout(100); const early = await zoom(); assert(early > 1 && early < 1.35);
  await expect.poll(zoom).toBeCloseTo(1.728, 3);
  await page.getByRole('button', { name: 'Reset zoom to 100%', exact: true }).click(); await expect.poll(zoom).toBeCloseTo(1, 3);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await page.waitForTimeout(100);
  await page.keyboard.down('Control'); await page.mouse.move(900, 600); await page.mouse.wheel(0, 100); await page.keyboard.up('Control'); await page.waitForTimeout(50);
  const handoff = await zoom(); await page.waitForTimeout(500); assert(Math.abs(await zoom() - handoff) < .001);
  await page.getByRole('button', { name: 'Reset zoom to 100%', exact: true }).click(); await expect.poll(zoom).toBeCloseTo(1, 3);
  const parent = await page.locator('.canvas-world').getAttribute('style');
  await page.getByRole('button', { name: 'Open folder Field archive', exact: true }).click();
  await expect.poll(() => f.state().session.view.activeGroupId).toBe('archive');
  await page.waitForTimeout(100); assert(await zoom() > 1 && await zoom() < 1.5);
  await page.reload(); await expect(page.getByRole('button', { name: 'Back to board', exact: true })).toBeVisible(); await expect.poll(zoom).toBeCloseTo(1.5, 3);
  await page.getByRole('button', { name: 'Back to board', exact: true }).click(); await expect.poll(() => f.state().session.view.activeGroupId).toBeUndefined();
  await page.reload(); await expect(page.locator('.canvas-world')).toHaveAttribute('style', parent!);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); assert(Math.abs(await zoom() - 1.2) < .001);
});

test('mid-collapse Done copies scaled articles and pointer gestures take over group layout', { timeout: 90_000 }, async t => {
  const f = await fixture(t), { page } = f;
  const image = await f.picture('Caption sample', '#315AD9'), a = await f.add(image, 260, 240), b = await f.add(image, 500, 420);
  await f.call('/api/board/operations', { sessionId: f.session.id, operations: [{ type: 'group.create', group: { id: 'motion', name: 'Motion', objectIds: [a.id, b.id] }, expectedVersions: { [a.id]: a.version, [b.id]: b.version } }] });
  await page.getByRole('button', { name: 'Mark canvas', exact: true }).click(); await page.mouse.move(160, 150); await page.mouse.down(); await page.mouse.move(780, 650, { steps: 5 }); await page.mouse.up();
  const comment = page.getByRole('textbox', { name: 'Add a comment', exact: true }); await comment.fill('Moving collection'); await comment.press('Escape');
  await page.getByRole('button', { name: 'Select group Motion', exact: true }).click(); await page.getByRole('button', { name: 'Store in folder', exact: true }).click();
  await page.locator('.annotation-content').first().click(); await expect(page.getByRole('textbox', { name: 'Annotation text', exact: true })).toBeVisible();
  await page.waitForTimeout(100);
  const frozen = await page.evaluate(objectId => {
    document.querySelectorAll<HTMLElement>('.board-object,.board-group').forEach(element => element.getAnimations().forEach(animation => animation.pause()));
    const object = document.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`)!, bounds = object.getBoundingClientRect(), caption = object.querySelector('.object-caption')!.getBoundingClientRect();
    const scale = new DOMMatrix(getComputedStyle(object).transform).a;
    return { scale, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, caption: { x: caption.x, y: caption.y, width: caption.width, height: caption.height } };
  }, a.id);
  assert(frozen.scale > .22 && frozen.scale < 1, `Expected an intermediate compositor scale, got ${frozen.scale}`);
  await page.screenshot({ path: join(f.evidence, 'collapse-middle.png') });
  await page.evaluate(objectId => { document.querySelector<HTMLButtonElement>('[aria-label="Done"]')!.addEventListener('click', () => { (window as any).doneArticleWidth = document.querySelector<HTMLElement>(`[data-object-id="${objectId}"]`)!.getBoundingClientRect().width; }, { once: true, capture: true }); }, a.id);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => f.state().draft.annotations.find(value => value.text === 'Moving collection')?.captureState?.status, { timeout: 20_000 }).toBe('complete');
  const capture = f.state().draft.annotations.find(value => value.text === 'Moving collection')!.capture!;
  const layer = capture.presentation!.layers.find(layer => layer.objectId === a.id)!; assert(layer);
  assert(layer.contentWorldBounds!.width > 0 && layer.contentWorldBounds!.width < a.width);
  assert(Math.abs(layer.contentWorldBounds!.width - await page.evaluate(() => (window as any).doneArticleWidth)) < .5);
  assert(layer.worldBounds.height < a.height + 92, 'Caption, outline and shadow remain inside the scaled article bounds.');
  // Expanding then immediately dragging finishes the prior layout and follows the pointer directly.
  await page.getByRole('button', { name: 'Open folder Motion', exact: true }).hover(); await page.getByRole('button', { name: 'Expand on board', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select group Motion', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select group Motion', exact: true }).click(); await page.getByRole('button', { name: 'Store in folder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select files', exact: true })).toBeEnabled();
  const folder = page.getByRole('button', { name: 'Open folder Motion', exact: true }), box = (await folder.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 120); await page.mouse.down();
  const start = (await folder.boundingBox())!; await page.mouse.move(box.x + 140, box.y + 150);
  const moved = (await folder.boundingBox())!; assert(Math.abs(moved.x - start.x - 40) < 1 && Math.abs(moved.y - start.y - 30) < 1);
  await page.mouse.up(); await expect(page.locator('.canvas-world')).not.toHaveAttribute('data-transition-kind', /.+/);
  await folder.hover(); await page.getByRole('button', { name: 'Expand on board', exact: true }).click();
  await expect(page.locator('.canvas-world')).not.toHaveAttribute('data-transition-kind', /.+/);
  const group = f.state().groups[0], neighbor = await f.add(image, group.x + group.width + 70, group.y + 100, 120, 80);
  await page.getByRole('button', { name: 'Select group Motion', exact: true }).click(); await page.getByRole('button', { name: 'Store in folder', exact: true }).click();
  await page.waitForTimeout(80); const moving = page.locator(`[data-object-id="${neighbor.id}"]`), beforeGrab = (await moving.boundingBox())!;
  await page.keyboard.down('Alt'); await page.mouse.move(beforeGrab.x + 30, beforeGrab.y + 40);
  await moving.evaluate(element => element.addEventListener('pointerdown', () => { (window as any).grabStartLeft = element.getBoundingClientRect().x; }, { capture: true, once: true }));
  await page.mouse.down();
  const pressedLeft = await page.evaluate(() => (window as any).grabStartLeft);
  const grabbed = (await moving.boundingBox())!; assert(Math.abs(grabbed.x - pressedLeft) < 1, 'Pointer down retains the displayed neighbor pose.');
  await page.mouse.move(beforeGrab.x + 60, beforeGrab.y + 40); const dragged = (await moving.boundingBox())!;
  assert(Math.abs(dragged.x - grabbed.x - 30) < 1, 'The grabbed neighbor follows the pointer directly.');
  await page.mouse.up(); await page.keyboard.up('Alt');
  await expect.poll(() => f.state().objects.find(object => object.id === neighbor.id)!.x).toBeCloseTo(grabbed.x + 30, 1);
});
