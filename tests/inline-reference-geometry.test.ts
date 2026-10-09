import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import type { Page } from 'playwright-core';
import { startServer } from '../src/server/http.js';
import type { Asset, BoardObject } from '../src/shared/types.js';

async function selectText(page: Page, start: number, end = start) {
  await page.locator('#instruction').evaluate((element, selection) => {
    const root = element as HTMLElement; root.focus();
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

async function measurements(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return page.locator('#instruction').evaluate(editor => {
    const editorBox = editor.getBoundingClientRect(), form = editor.closest('.composer')!;
    const box = (element: Element) => { const bounds = element.getBoundingClientRect(); return { x: bounds.x - editorBox.x, y: bounds.y - editorBox.y, width: bounds.width, height: bounds.height }; };
    const properties = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'gap', 'padding', 'margin', 'borderWidth', 'borderRadius', 'backgroundColor', 'maxWidth', 'whiteSpace', 'textOverflow', 'overflow', 'verticalAlign', 'boxShadow'] as const;
    const refs = Array.from(editor.querySelectorAll('.chatbox-reference,.chatbox-reference-preview')).map(reference => {
      const elements = [reference, ...Array.from(reference.querySelectorAll('.reference-content,.reference-label,.asset-thumb,.reference-remove'))];
      return { text: reference.querySelector('.reference-label')!.textContent, color: getComputedStyle(reference).color, elements: elements.map(element => {
        const style = getComputedStyle(element);
        return { tag: element.tagName, rect: box(element), styles: Object.fromEntries(properties.map(property => [property, style[property]])) };
      }), shadows: [reference, ...Array.from(reference.querySelectorAll('*'))].map(element => getComputedStyle(element).boxShadow) };
    });
    const textRects = Array.from(editor.childNodes).flatMap(node => { if (node.nodeType !== Node.TEXT_NODE || !node.textContent) return []; const range = document.createRange(); range.selectNodeContents(node); return Array.from(range.getClientRects()).map(rect => ({ y: rect.y - editorBox.y, height: rect.height })); });
    return { editor: { width: editorBox.width, height: editorBox.height, scrollHeight: editor.scrollHeight, scrollWidth: editor.scrollWidth, lineHeight: parseFloat(getComputedStyle(editor).lineHeight), fontSize: getComputedStyle(editor).fontSize }, composerHeight: form.getBoundingClientRect().height, refs, textRects };
  });
}

test('inline reference states share text line geometry and preserve native editing', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-reference-geometry-project-')));
  const evidence = process.env.ACANVAS_REFERENCE_GEOMETRY_EVIDENCE || await realpath(await mkdtemp(join(tmpdir(), 'acanvas-reference-geometry-evidence-')));
  const results: unknown[] = [], errors: string[] = [];
  let failure: string | undefined;
  const running = await startServer({ root, port: 0, webRoot: resolve(process.env.ACANVAS_TEST_WEB_ROOT || 'dist/web'), browser: { headless: true } });
  const session = running.service.createSession('Inline reference geometry');
  await running.browser.open(session.id);
  const page = running.browser.page(session.id)!;
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('#whiteboard')).toBeVisible();
  const bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json();
  const asset = async (name: string) => {
    const response = await fetch(`${running.url}/api/assets?name=${encodeURIComponent(name)}&mime=text/plain`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: 'Reference content' });
    assert(response.ok); return response.json() as Promise<Asset>;
  };
  const makeObject = async (name: string, x: number) => {
    const imported = await asset(name), before = new Set(running.service.objects().map(object => object.id));
    running.service.boardOperations(session.id, [{ type: 'create', object: { assetId: imported.id, x, y: 180, width: 120, height: 100 } }]);
    const object = running.service.objects().find(value => !before.has(value.id))!;
    await expect(page.locator(`[data-object-id="${object.id}"]`)).toBeVisible(); return object;
  };
  const saved = async () => { await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved'); return running.service.draft(session.id); };
  const selectObjects = async (objects: BoardObject[]) => {
    for (const [index, object] of objects.entries()) { await page.locator(`[data-object-id="${object.id}"]`).focus(); await page.keyboard.press(index ? 'Shift+Enter' : 'Enter'); }
    await expect(page.locator('[data-reference-preview]')).toHaveCount(objects.length);
  };
  const assertLineBoxes = (value: Awaited<ReturnType<typeof measurements>>) => {
    assert.equal(value.editor.scrollWidth <= value.editor.width + 1, true);
    value.refs.forEach(reference => {
      assert.equal(reference.elements[0].rect.height, value.editor.lineHeight);
      assert.equal(reference.elements[0].rect.y % value.editor.lineHeight, 0);
      assert.equal(reference.elements[0].styles.fontSize, value.editor.fontSize);
      assert(reference.elements.slice(1).every(element => element.rect.height <= value.editor.lineHeight));
      assert(reference.shadows.every(shadow => shadow === 'none'));
    });
    const lines = Math.max(1, ...value.refs.map(reference => reference.elements[0].rect.y / value.editor.lineHeight + 1), ...value.textRects.map(rect => Math.floor((rect.y + .5) / value.editor.lineHeight) + 1));
    assert.equal(value.editor.height, lines * value.editor.lineHeight);
  };
  const withoutColor = (value: Awaited<ReturnType<typeof measurements>>) => ({ ...value, refs: value.refs.map(({ color, ...reference }) => reference) });
  try {
    const short = await makeObject('A.txt', 430), long = await makeObject('cr3sh & KYPT - All Nighter Vol. 8 - 08 I SEE THE LONG ORIGINAL FILENAME 中文 😀.txt', 580);
    const cases = [
      { name: 'short-text', text: 'a b', offset: 2, objects: [short] },
      { name: 'long-text', text: 'a b', offset: 2, objects: [long] },
      { name: 'multiple-text', text: 'a b', offset: 2, objects: [short, long] },
      { name: 'pure-references', text: '', offset: 0, objects: [short, long] },
    ];
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const nativeClicks = [];
        for (const editorFocused of [false, true]) {
          await page.locator('#instruction').focus(); await page.locator('#instruction').fill('before after'); await selectText(page, 7); await selectObjects([short]);
          await page.locator('.reference-preview-confirm').focus(); await page.keyboard.press(editorFocused ? 'Space' : 'Enter'); await expect(page.locator('[data-reference-preview]')).toHaveCount(0); await saved();
          if (editorFocused) await selectText(page, 2);
          else { await page.locator('#whiteboard').focus(); await page.evaluate(() => window.getSelection()!.removeAllRanges()); }
          const beforeMetrics = await measurements(page); assert.equal(beforeMetrics.editor.fontSize, width <= 540 ? '16px' : '15px');
          await page.locator('.chatbox-reference .reference-label').click();
          const selection = await page.evaluate(() => {
            const selected = window.getSelection()!;
            return { active: document.activeElement?.id, anchorText: selected.anchorNode?.textContent, anchorOffset: selected.anchorOffset, focusText: selected.focusNode?.textContent, focusOffset: selected.focusOffset, collapsed: selected.isCollapsed, anchorInEditor: document.querySelector('#instruction')!.contains(selected.anchorNode), focusInEditor: document.querySelector('#instruction')!.contains(selected.focusNode) };
          });
          assert.deepEqual(selection, { active: 'instruction', anchorText: 'before ', anchorOffset: 7, focusText: 'after', focusOffset: 0, collapsed: false, anchorInEditor: true, focusInEditor: true });
          const afterMetrics = await measurements(page); assert.equal(afterMetrics.editor.fontSize, beforeMetrics.editor.fontSize); assert.deepEqual(afterMetrics.refs.map(reference => reference.elements.map(element => element.rect)), beforeMetrics.refs.map(reference => reference.elements.map(element => element.rect))); assert.equal(afterMetrics.editor.height, beforeMetrics.editor.height); assert.equal(afterMetrics.composerHeight, beforeMetrics.composerHeight);
          await page.keyboard.type('Z'); const replaced = await saved(); assert.equal(replaced.text, 'before Zafter'); assert.deepEqual(replaced.references.order, []);
          nativeClicks.push({ editorFocused, previewKeyboard: editorFocused ? 'Space' : 'Enter', selection, beforeMetrics, afterMetrics, textAfter: replaced.text, referencesAfter: replaced.references });
        }
        results.push({ nativePointerScenario: true, width, theme, nativeClicks });
      }
    }
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        for (const scenario of cases) {
          await page.locator('#instruction').focus(); await page.locator('#instruction').fill(scenario.text); await selectText(page, scenario.offset); await selectObjects(scenario.objects); await page.mouse.move(1, 1);
          const preview = await measurements(page); assertLineBoxes(preview);
          assert.equal(preview.editor.fontSize, width <= 540 ? '16px' : '15px');
          if (scenario.name === 'multiple-text' && (width === 1440 && theme === 'light' || width === 320 && theme === 'dark')) await page.locator('.composer').screenshot({ path: join(evidence, `${width}-${theme}-preview.png`) });
          for (const selector of ['.reference-content', '.reference-remove']) {
            await page.locator(selector).first().hover(); const hovered = await measurements(page); assert.deepEqual(hovered.refs.map(reference => reference.elements.map(element => element.rect)), preview.refs.map(reference => reference.elements.map(element => element.rect))); assert(hovered.refs.every(reference => reference.shadows.every(shadow => shadow === 'none')));
            await page.locator(selector).first().focus(); assert.equal(await page.locator(selector).first().evaluate(element => element === document.activeElement), true); const focused = await measurements(page); assert.deepEqual(focused.refs.map(reference => reference.elements.map(element => element.rect)), preview.refs.map(reference => reference.elements.map(element => element.rect))); assert.equal(focused.editor.fontSize, preview.editor.fontSize); assert(focused.refs.every(reference => reference.shadows.every(shadow => shadow === 'none')));
          }
          await page.mouse.move(1, 1); await page.locator('#whiteboard').focus();
          await page.locator('.reference-preview-confirm').first().click(); await page.mouse.move(1, 1); await expect(page.locator('[data-reference-preview]')).toHaveCount(0); const draft = await saved();
          const formal = await measurements(page); assertLineBoxes(formal);
          if (scenario.name === 'multiple-text' && (width === 1440 && theme === 'light' || width === 320 && theme === 'dark')) await page.locator('.composer').screenshot({ path: join(evidence, `${width}-${theme}-formal.png`) });
          assert.deepEqual(withoutColor(formal), withoutColor(preview));
          assert(preview.refs.every((reference, index) => reference.color !== formal.refs[index].color));
          assert.deepEqual(formal.refs.map(reference => reference.text), scenario.objects.map(object => running.service.asset(object.assetId).name));
          assert.deepEqual(draft.references.order?.map(reference => reference.textOffset), scenario.objects.map(() => scenario.offset));
          for (const selector of ['.reference-content', '.reference-remove']) {
            await page.locator(selector).first().hover(); const hovered = await measurements(page); assert.deepEqual(hovered.refs.map(reference => reference.elements.map(element => element.rect)), formal.refs.map(reference => reference.elements.map(element => element.rect))); assert(hovered.refs.every(reference => reference.shadows.every(shadow => shadow === 'none')));
            const focusTarget = page.locator(selector === '.reference-content' ? '#instruction' : selector).first(); await focusTarget.focus(); assert.equal(await focusTarget.evaluate(element => element === document.activeElement), true); const focused = await measurements(page); assert.deepEqual(focused.refs.map(reference => reference.elements.map(element => element.rect)), formal.refs.map(reference => reference.elements.map(element => element.rect))); assert.equal(focused.editor.fontSize, formal.editor.fontSize); assert(focused.refs.every(reference => reference.shadows.every(shadow => shadow === 'none')));
          }
          const deletions = [];
          while (await page.locator('.reference-remove').count()) { await page.locator('.reference-remove').last().click(); const remaining = await measurements(page); assertLineBoxes(remaining); deletions.push(remaining); }
          const removed = await saved(); assert.equal(removed.text, scenario.text); assert.deepEqual(removed.references.objectIds, []);
          if (formal.editor.height === 24) { assert(deletions.every(value => value.editor.height === 24 && value.composerHeight === formal.composerHeight)); }
          results.push({ width, theme, scenario: scenario.name, preview, formal, deletions });
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#instruction').focus(); await page.locator('#instruction').fill('😀left right'); await selectText(page, 7); await selectObjects([short]);
    const before = running.service.draft(session.id); assert.deepEqual(before.references.objectIds, []);
    await page.locator('.composer-more').focus(); await page.keyboard.press('Tab'); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(1);
    const confirmed = await saved(); assert(confirmed.revision > before.revision); assert.equal(confirmed.references.order?.[0].textOffset, 7);
    await page.keyboard.press('Tab'); assert.equal(await page.locator('.reference-remove').evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Shift+Tab'); assert.equal(await page.locator('#instruction').evaluate(element => element === document.activeElement), true);
    await selectText(page, 8); await page.keyboard.press('ArrowLeft'); await page.keyboard.type('X'); assert.equal((await saved()).references.order?.[0].textOffset, 8);
    await page.keyboard.press('Delete'); assert.deepEqual((await saved()).references.objectIds, []);
    await selectText(page, 7); await page.keyboard.type('@A.txt'); await page.keyboard.press('Enter'); await page.keyboard.type('@A.txt'); await page.keyboard.press('Enter');
    assert.deepEqual((await saved()).references.order?.map(entry => entry.id), [short.id, short.id]);
    await page.keyboard.press('Backspace'); assert.deepEqual((await saved()).references.order?.map(entry => entry.id), [short.id]);
    await selectText(page, 0); const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 });
    await page.locator('#instruction').dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true }); assert.equal(running.service.tasks(session.id).length, 0);
    await cdp.send('Input.insertText', { text: '你好' }); await cdp.detach();
    const composed = await saved(); assert.equal(composed.text, '你好😀left Xright'); assert.equal(composed.references.order?.[0].textOffset, 9);
    await page.reload(); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(1); assert.deepEqual((await saved()).references, composed.references);
    await selectText(page, 9, 11); await page.keyboard.press('Backspace'); const crossDeleted = await saved(); assert.deepEqual(crossDeleted.references.objectIds, []); assert.equal(crossDeleted.text, '你好😀left right');
    results.push({ editing: 'keyboard confirm, revision, UTF-16 offsets, arrows, Delete, duplicate reference, Backspace, native IME, refresh, cross selection', revision: composed.revision, tasks: running.service.tasks(session.id).length });
    assert.deepEqual(errors, []);
    await page.locator('.composer').screenshot({ path: join(evidence, 'final-composer.png') });
  } catch (error) { failure = error instanceof Error ? error.stack : String(error); await page.locator('.composer').screenshot({ path: join(evidence, 'failed-composer.png') }); throw error; }
  finally {
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', projectRoot: root, serviceUrl: running.url, headless: true, failures: failure ? [failure] : [], errors, results, limits: ['No Send or Done operations', 'Task references use the shared unchanged rendering path; fixture exercises object references', 'Actual content line-count reductions may shrink the editor by whole normal line heights'] }, null, 2));
    await running.close(); await rm(root, { recursive: true, force: true }); t.diagnostic(`Evidence: ${evidence}`);
  }
});
