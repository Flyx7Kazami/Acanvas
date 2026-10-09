import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { startServer } from '../src/server/http.js';
async function fixture(t, narrow = false) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-reference-ui-')));
    const evidence = await realpath(await mkdtemp(join(tmpdir(), 'acanvas-reference-evidence-')));
    t.diagnostic(`Evidence: ${evidence}`);
    const running = await startServer({ root, port: 0, webRoot: resolve('dist/web'), browser: { headless: true } });
    const session = running.service.createSession('Reference occurrences');
    await running.browser.open(session.id);
    const page = running.browser.page(session.id);
    if (narrow)
        await page.setViewportSize({ width: 320, height: 700 });
    await expect(page.locator('#whiteboard')).toBeVisible();
    const bootstrap = await (await fetch(`${running.url}/api/bootstrap`)).json();
    const call = async (path, method = 'GET', body) => {
        const response = await fetch(`${running.url}${path}`, { method, headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const result = await response.json();
        assert(response.ok, JSON.stringify(result));
        return result;
    };
    const saved = async () => { await expect(page.locator('.composer')).toHaveAttribute('data-save-state', 'saved'); return running.service.draft(session.id); };
    const image = async (name = 'Repeated.png') => {
        const data = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 240; canvas.getContext('2d').fillRect(0, 0, 400, 240); return canvas.toDataURL('image/png').split(',')[1]; });
        const response = await fetch(`${running.url}/api/assets?name=${encodeURIComponent(name)}&mime=image/png`, { method: 'POST', headers: { Authorization: `Bearer ${bootstrap.token}` }, body: new Uint8Array(Buffer.from(data, 'base64')) });
        assert(response.ok);
        return response.json();
    };
    const object = async () => {
        const asset = await image();
        await call('/api/board/operations', 'POST', { sessionId: session.id, operations: [{ type: 'create', object: { assetId: asset.id, x: 40, y: 100, width: 180, height: 108 } }] });
        const value = running.service.objects().at(-1);
        await expect(page.locator(`[data-object-id="${value.id}"]`)).toBeVisible();
        return value;
    };
    t.after(async () => {
        if (!page.isClosed()) {
            await page.screenshot({ path: join(evidence, 'final-ui.png') });
            await writeFile(join(evidence, 'state.json'), JSON.stringify(running.service.state(session.id), null, 2));
        }
        await running.close();
        await rm(root, { recursive: true, force: true });
    });
    return { page, evidence, session, running, call, saved, object, state: () => running.service.state(session.id) };
}
async function select(page, start, end = start) {
    await page.locator('#instruction').evaluate((root, selection) => {
        root.focus();
        const point = (position) => {
            let cursor = 0;
            for (const node of Array.from(root.childNodes)) {
                const length = node.nodeType === Node.TEXT_NODE ? node.textContent?.length || 0 : 1;
                if (node.nodeType === Node.TEXT_NODE && position <= cursor + length)
                    return [node, position - cursor];
                if (position <= cursor)
                    return [root, Array.from(root.childNodes).indexOf(node)];
                cursor += length;
            }
            return [root, root.childNodes.length];
        };
        const range = document.createRange();
        range.setStart(...point(selection.start));
        range.setEnd(...point(selection.end));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
    }, { start, end });
}

test('independent cross-atom range deletion and native replacement preserve surviving repeat identities and UTF-16 offsets', async t => {
  const app=await fixture(t), {page}=app, object=await app.object();
  let d=await app.saved(); d=await app.call(`/api/sessions/${app.session.id}/draft`, 'PUT', {...d,text:'Source'});
  const prior=(await app.call(`/api/sessions/${app.session.id}/tasks`, 'POST',{draftId:d.id,expectedRevision:d.revision})).task;
  const initial={text:'A😀BCDE',references:{objectIds:[object.id],taskIds:[prior.id],order:[
    {kind:'object',id:object.id,textOffset:1},{kind:'object',id:object.id,textOffset:3},
    {kind:'task',id:prior.id,textOffset:3},{kind:'object',id:object.id,textOffset:5},{kind:'task',id:prior.id,textOffset:7}]}};
  await app.call(`/api/sessions/${app.session.id}/draft`,'PUT',{...app.state().draft,...initial});
  await page.reload(); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(5);
  await select(page,2,6); await page.keyboard.press('Backspace');
  let value=await app.saved();
  assert.equal(value.text,'ABCDE');
  assert.deepEqual(value.references.order,[{kind:'object',id:object.id,textOffset:1},{kind:'object',id:object.id,textOffset:3},{kind:'task',id:prior.id,textOffset:5}]);
  // Replace a range spanning B, C and the second occurrence with emoji-bearing text.
  await select(page,2,5); await page.keyboard.insertText('新😀\n');
  value=await app.saved();
  assert.equal(value.text,'A新😀\nDE');
  assert.deepEqual(value.references.order,[{kind:'object',id:object.id,textOffset:1},{kind:'task',id:prior.id,textOffset:7}]);
  assert.deepEqual(value.references.objectIds,[object.id]); assert.deepEqual(value.references.taskIds,[prior.id]);
  await page.reload(); await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(2);
  assert.deepEqual((await app.saved()).references,value.references);
});

test('independent delayed HTTP save, in-flight repeat deletion, appended Unicode and Send retain the latest full order', async t=>{
  const app=await fixture(t),{page}=app,object=await app.object();
  let d=await app.saved();d=await app.call(`/api/sessions/${app.session.id}/draft`,'PUT',{...d,text:'Earlier'});
  const prior=(await app.call(`/api/sessions/${app.session.id}/tasks`,'POST',{draftId:d.id,expectedRevision:d.revision})).task;
  const initial={text:'AB😀CD',references:{objectIds:[object.id],taskIds:[prior.id],order:[{kind:'object',id:object.id,textOffset:1},{kind:'object',id:object.id,textOffset:4},{kind:'object',id:object.id,textOffset:4},{kind:'task',id:prior.id,textOffset:6}]}};
  await app.call(`/api/sessions/${app.session.id}/draft`,'PUT',{...app.state().draft,...initial});await page.reload();await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(4);
  let release,heldResolve,first=true;
  const releasePromise=new Promise(resolve=>{release=resolve}),held=new Promise(resolve=>{heldResolve=resolve});
  const requests=[];
  await page.route('**/api/sessions/*/draft',async route=>{
    if(route.request().method()!=='PUT') return route.continue();
    requests.push(route.request().postDataJSON());
    if(first){first=false;heldResolve();await releasePromise;}
    await route.continue();
  });
  await select(page,0);await page.keyboard.insertText('前');await held;
  await page.locator('#instruction .chatbox-reference').nth(1).getByRole('button').click();
  await select(page,100);await page.keyboard.insertText('尾😀');
  await expect(page.locator('#instruction .chatbox-reference')).toHaveCount(3);
  await page.getByRole('button',{name:'Send request',exact:true}).click();release();
  await expect(page.locator('.queue-item')).toHaveCount(2);
  const task=app.state().tasks[1];
  assert.equal(task.snapshot.userRequest.text,'前AB😀CD尾😀');
  const expected=[{kind:'object',id:object.id,textOffset:2},{kind:'object',id:object.id,textOffset:5},{kind:'task',id:prior.id,textOffset:7}];
  assert.deepEqual(task.snapshot.requestReferences.order.map(({kind,id,textOffset})=>({kind,id,textOffset})),expected);
  assert.equal(requests[0].references.order.length,4);assert.equal(requests.at(-1).references.order.length,3);
  assert.equal(task.snapshot.referenceContent.objects.length,1);assert.equal(task.snapshot.referenceContent.assets.length,1);assert.deepEqual(task.snapshot.referenceContent.taskIds,[prior.id]);
  await page.reload();await expect(page.locator('.queue-item')).toHaveCount(2);assert.deepEqual(app.state().tasks[1].snapshot,task.snapshot);
  await writeFile(join(app.evidence,'delayed-save-requests.json'),JSON.stringify(requests,null,2));
});

test('independent computed theme Ink, equal neutral background/border and literal name across formal, preview and queue',async t=>{
  const app=await fixture(t,true),{page}=app,object=await app.object();
  const style=locator=>locator.evaluate(e=>{const s=getComputedStyle(e),root=getComputedStyle(document.documentElement);return {color:s.color,background:s.backgroundColor,border:s.borderTopColor,ink:root.getPropertyValue('--ink').trim(),muted:root.getPropertyValue('--muted').trim()};});
  const results={};
  for(const theme of ['light','dark']){
    if(theme==='dark')await page.getByRole('button',{name:'Switch to dark theme',exact:true}).click();
    await page.locator(`[data-object-id="${object.id}"]`).click({position:{x:90,y:54}});
    const preview=await style(page.locator('#instruction .chatbox-reference-preview'));
    await page.getByRole('button',{name:'Add selected Repeated.png to request',exact:true}).click();
    const formal=await style(page.locator('#instruction .chatbox-reference').first());
    const resolvedInk=await page.evaluate(()=>{const e=document.createElement('span');e.style.color='var(--ink)';document.body.append(e);const color=getComputedStyle(e).color;e.remove();return color;});
    assert.equal(formal.color,resolvedInk);assert.equal(formal.border,preview.border);assert.equal(formal.background,preview.background);assert.notEqual(formal.color,preview.color);
    assert.deepEqual(await page.locator('#instruction .chatbox-reference span[title]').allTextContents(),Array(theme==='light'?1:2).fill('Repeated.png'));
    results[theme]={preview,formal};
  }
  await app.saved();await page.getByRole('button',{name:'Send request',exact:true}).click();await expect(page.locator('.queue-item')).toHaveCount(1);
  await page.getByRole('button',{name:/View request 1:/}).click();const refs=page.locator('.task-inline-reference');await expect(refs).toHaveCount(2);
  assert.deepEqual(await refs.evaluateAll(es=>es.map(e=>e.lastElementChild.textContent)),['Repeated.png','Repeated.png']);
  results.queue=await style(refs.first());assert.equal(results.queue.color,results.dark.formal.color);assert.equal(results.queue.border,results.dark.formal.border);assert.equal(results.queue.background,results.dark.formal.background);
  await writeFile(join(app.evidence,'computed-styles.json'),JSON.stringify(results,null,2));
});
