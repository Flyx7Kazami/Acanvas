import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { decodeSelectedHtmlFiles, NativeSurfaceControls } from '../src/server/render-surface/native-controls.js';
import { HtmlInputProxy, htmlSurfacePoint, type HtmlPresentedInput } from '../src/web/html-surface/InputProxy.js';
import { launchRenderEngine } from '../src/server/render-surface/engine.js';

const frame = { surfaceId: 'surface', instanceId: 'instance', frameSeq: 8, inputSeq: 4, viewport: { width: 640, height: 360 } };
test('HTML input keeps displayed frame coordinates, order and the next accepted sequence', async () => {
  const sent: HtmlPresentedInput[] = []; let release!: () => void;
  const pause = new Promise<void>(resolve => { release = resolve; });
  const proxy = new HtmlInputProxy(async input => { sent.push(input); if (sent.length === 1) await pause; return { inputSeq: input.inputSeq }; });
  proxy.present(frame);
  const first = proxy.input({ type: 'pointer', action: 'click', x: 40, y: 25 });
  const second = proxy.input({ type: 'text', text: '世界' });
  await Promise.resolve(); proxy.present({ ...frame, frameSeq: 9 }); release(); await Promise.all([first, second]);
  assert.deepEqual(sent.map(input => [input.inputSeq, input.frameSeq]), [[5, 8], [6, 8]]);
  assert.deepEqual(htmlSurfacePoint({ clientX: 250, clientY: 140 }, { left: 90, top: 50, width: 320, height: 180 }, frame.viewport), { x: 320, y: 180 });
  assert.equal(htmlSurfacePoint({ clientX: 410, clientY: 140 }, { left: 90, top: 50, width: 320, height: 180 }, frame.viewport), undefined);
});
test('HTML queued resize and replaced instance inputs reject before dispatch', async () => {
  let calls = 0; const proxy = new HtmlInputProxy(async () => { calls++; }); proxy.present(frame);
  const changedSize = proxy.input({ type: 'text', text: 'a' }); proxy.present({ ...frame, viewport: { width: 800, height: 360 } });
  await assert.rejects(changedSize, /size has changed/); assert.equal(calls, 0);
  const replaced = proxy.input({ type: 'text', text: 'b' }); proxy.present({ ...frame, instanceId: 'next' });
  await assert.rejects(replaced, /surface has changed/); assert.equal(calls, 0);
  await proxy.input({ type: 'text', text: 'c' }); assert.equal(calls, 1);
});
test('HTML rejected input retries the next accepted sequence', async () => {
  const sequences: number[] = []; const proxy = new HtmlInputProxy(async input => { sequences.push(input.inputSeq); if (sequences.length === 1) throw new Error('temporary'); }); proxy.present(frame);
  await assert.rejects(proxy.input({ type: 'text', text: 'a' }), /temporary/); await proxy.input({ type: 'text', text: 'b' }); assert.deepEqual(sequences, [5, 5]);
});
test('HTML accepted clipboard failure advances the client sequence before reporting its error',async()=>{
  const seen:number[]=[],proxy=new HtmlInputProxy(async input=>{seen.push(input.inputSeq);return{inputSeq:input.inputSeq,...(input.type==='clipboard'?{clipboardError:'Clipboard unavailable'}:{})}});proxy.present(frame);await assert.rejects(proxy.clipboard({type:'clipboard',action:'copy'}),/Clipboard unavailable/);await proxy.input({type:'key',action:'press',key:'b'});assert.deepEqual(seen,[5,6]);
});
const file = { name: '選択.txt', mime: 'text/plain', bytesBase64: Buffer.from('Selected bytes 世界').toString('base64'), lastModified: 1_700_000_000_123 };
test('HTML selected files validate canonical bytes, names, times and resource size', () => {
  assert.equal(decodeSelectedHtmlFiles([file])[0].buffer.toString(), 'Selected bytes 世界');
  for (const name of ['/Users/example/secret', '../secret', 'a\\secret', '..', 'nul\0.txt']) assert.throws(() => decodeSelectedHtmlFiles([{ ...file, name }]), /file_name/);
  for (const bytesBase64 of ['!!!!', 'YQ=', 'YR==']) assert.throws(() => decodeSelectedHtmlFiles([{ ...file, bytesBase64 }]), /file_bytes/);
  assert.throws(() => decodeSelectedHtmlFiles([file], { maxFileBytes: 2 }), /file_bytes/);
  assert.throws(() => decodeSelectedHtmlFiles([{ ...file, lastModified: -1 }]), /file_time/);
});
test('HTML selected file boundary validates full 8 MiB with bounded linear parsing',()=>{
  const bytesBase64=Buffer.alloc(8_388_608,97).toString('base64');assert.equal(decodeSelectedHtmlFiles([{...file,name:'owned.bin',bytesBase64}])[0].buffer.length,8_388_608);
  assert.throws(()=>decodeSelectedHtmlFiles([{...file,bytesBase64:Buffer.alloc(8_388_609,97).toString('base64')}]),/file_bytes/);
  assert.throws(()=>decodeSelectedHtmlFiles([{...file,bytesBase64:bytesBase64.slice(0,-4)+'YR=='}]),/file_bytes/);
  const half=Buffer.alloc(4_194_304,97).toString('base64');assert.equal(decodeSelectedHtmlFiles([{...file,bytesBase64:half},{...file,name:'second.bin',bytesBase64:half}]).reduce((sum,file)=>sum+file.buffer.length,0),8_388_608);
  assert.throws(()=>decodeSelectedHtmlFiles([{...file,bytesBase64:half},{...file,name:'second.bin',bytesBase64:Buffer.alloc(4_194_305,97).toString('base64')}]),/file_bytes/);
});
test('HTML native file bridge stages selected bytes privately and retains them until close', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'acanvas-control-files-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: Array<{ method: string; params: any; sessionId?: string }> = [];
  const runtime = { documentEvaluate: async () => ({ multiple: true }), documentNode: async () => ({ objectId: 'node', sessionId: 'source-session' }), protocol: async (method: string, params: object = {}, sessionId?: string) => { calls.push({ method, params, sessionId }); return {}; } };
  const controls = new NativeSurfaceControls(runtime, { directory }); await controls.apply({ type: 'files', controlId: '#files', files: [file] });
  const command = calls.find(call => call.method === 'DOM.setFileInputFiles')!; assert.equal(command.sessionId, 'source-session');
  const selected = command.params.files[0]; assert.equal(await readFile(selected, 'utf8'), 'Selected bytes 世界'); assert.equal(Math.round((await stat(selected)).mtimeMs), file.lastModified);
  assert.equal((await stat(selected)).mode & 0o777, 0o600); assert.equal(calls.at(-1)?.method, 'Runtime.releaseObject');
  await controls.close(); await assert.rejects(readFile(selected), { code: 'ENOENT' });
});
test('HTML composition dispatches actual IME protocol operations and validates selections', async () => {
  const calls: Array<[string, object]> = [];
  const controls = new NativeSurfaceControls({ documentEvaluate: async () => ({}), protocol: async (method: string, params: object = {}) => { calls.push([method, params]); return {}; } });
  await controls.apply({ type: 'composition', action: 'update', text: 'に', selectionStart: 1, selectionEnd: 1 });
  await controls.apply({ type: 'composition', action: 'commit', text: '日本' });
  await controls.apply({ type: 'composition', action: 'cancel', text: '' });
  assert.deepEqual(calls, [['Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 }], ['Input.insertText', { text: '日本' }], ['Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }]]);
  await assert.rejects(controls.apply({ type: 'composition', action: 'update', text: 'に', selectionStart: 2 }), /composition_selection/);
});

const browserEnabled = process.env.ACANVAS_HTML_CONTROLS_BROWSER_TESTS === '1';
test('HTML controls preserve browser composition, native source editing, selection, file bytes and semantic values', { skip: !browserEnabled }, async t => {
  const bundle = await build({ configFile: false, logLevel: 'silent', plugins: [react(), { name: 'controls-fixture', resolveId: id => id === 'controls-entry' ? '\0controls-entry' : undefined, load: id => id === '\0controls-entry' ? `
import React from 'react';import{createRoot}from'react-dom/client';import{HtmlSurfaceControls}from${JSON.stringify(resolve('src/web/html-surface/Controls.tsx'))};
const w=window;w.actions=[];w.errors=[];
const c=(id,type,x,y,value='')=>({id,tag:type==='select'?'select':type==='contenteditable'?'div':type==='textarea'?'textarea':'input',type,role:type==='select'?'combobox':'textbox',label:id,disabled:false,readOnly:false,focused:false,value,bounds:{x,y,width:180,height:32}});
const controls=[c('#text','text',0,0),c('#edit','contenteditable',0,40),{...c('#select','select',0,80,'one'),options:[{value:'one',label:'One',disabled:false},{value:'two',label:'Two',disabled:false}]},c('#date','date',0,120,'2026-10-09'),c('#color','color',0,160,'#123456'),c('#file','file',0,200)];
w.render=(focused)=>createRoot(document.querySelector('#root')).render(React.createElement(HtmlSurfaceControls,{snapshot:{controls:controls.map(c=>({...c,focused:c.id===focused})),selection:'',scroll:{x:0,y:0},title:'Fixture',omittedControls:0,readingOrder:[{id:'heading',role:'heading',level:1,text:'Document heading',bounds:{x:0,y:0,width:180,height:20}},...controls.map(c=>({id:c.id,role:c.role,text:c.label,bounds:c.bounds}))]},surface:{instanceId:'fixture',inputSeq:0,viewport:{width:360,height:260}},frameSeq:1,onInput:async action=>{w.actions.push(action)},onError:error=>w.errors.push(String(error))}));w.render();
` : undefined }], build: { write: false, minify: false, rollupOptions: { input: 'controls-entry', output: { inlineDynamicImports: true } } } });
  const output = Array.isArray(bundle) ? bundle[0] : bundle; if (!('output' in output)) throw new Error('Expected a browser bundle');
  const code = output.output.find(item => item.type === 'chunk')!; if (code.type !== 'chunk') throw new Error('Expected browser JavaScript');
  const browser = await launchRenderEngine(); t.after(() => browser.close()); const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
  await page.setContent('<!doctype html><div id="root" style="position:absolute;left:80px;top:40px;width:360px;height:260px"></div>');
  await page.evaluate(() => { (window as any).nativeEvents = []; for (const type of ['keydown', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend', 'change']) document.addEventListener(type, event => (window as any).nativeEvents.push({ type: event.type, trusted: event.isTrusted }), true); });
  await page.addScriptTag({ content: code.code });
  await page.waitForSelector('[data-html-control="#text"]'); const text = page.locator('[data-html-control="#text"]'); await text.focus(); await page.keyboard.type('native');
  const actions = await page.evaluate(() => (window as any).actions); assert.equal(actions.filter((action: any) => action.type === 'key' && action.action === 'down' && action.character).map((action: any) => action.character).join(''), 'native'); assert.equal(actions.filter((action: any) => action.type === 'text').length, 0);
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
  const client = await page.context().newCDPSession(page); await client.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 }); await client.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 }); await client.send('Input.insertText', { text: '日本' });
  const composition = await page.evaluate(() => (window as any).actions.filter((action: any) => action.type === 'composition'));
  assert(composition.some((action: any) => action.action === 'update' && action.text === 'に')); assert.equal(composition.filter((action: any) => action.action === 'commit' && action.text === '日本').length, 1); assert.equal(await text.inputValue(), '日本');
  const clientEvents = await page.evaluate(() => (window as any).nativeEvents);
  for (const type of ['compositionstart', 'compositionupdate']) assert(clientEvents.some((event: any) => event.type === type && event.trusted), `Native client ${type}: ${JSON.stringify(clientEvents)}`);
  assert(clientEvents.some((event: any) => event.type === 'compositionend' && !event.trusted), 'Chromium CDP commits composition with an untrusted compositionend event.');
  await page.keyboard.press('Tab'); assert((await page.evaluate(() => (window as any).actions)).some((action: any) => action.type === 'key' && action.action === 'press' && action.key === 'Tab'));
  await page.locator('[data-html-control="#select"]').selectOption('two'); await page.locator('[data-html-control="#date"]').fill('2027-01-02');
  await page.locator('[data-html-control="#file"]').setInputFiles({ name: 'chosen.txt', mimeType: 'text/plain', buffer: Buffer.from('client chosen 世界') });
  await page.waitForFunction(() => (window as any).actions.some((action: any) => action.type === 'files'));
  const final = await page.evaluate(() => ({ actions: (window as any).actions, errors: (window as any).errors }));
  assert.deepEqual(final.errors, []); assert(final.actions.some((action: any) => action.type === 'control' && action.controlId === '#select' && action.value === 'two')); assert(final.actions.some((action: any) => action.type === 'control' && action.controlId === '#date' && action.value === '2027-01-02'));
  const sentFile = final.actions.find((action: any) => action.type === 'files').files[0]; assert.equal(sentFile.name, 'chosen.txt'); assert.equal(Buffer.from(sentFile.bytesBase64, 'base64').toString(), 'client chosen 世界'); assert(!('path' in sentFile));
  const order = await page.locator('[data-html-semantics]').ariaSnapshot(); assert(order.indexOf('Document heading') < order.indexOf('textbox "#text"')); assert(order.includes('combobox "#select"'));
  const directory = await mkdtemp(join(tmpdir(), 'acanvas-source-control-browser-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePage = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await sourcePage.setContent(`<style>body{margin:0}iframe{width:640px;height:360px;border:0}</style><iframe sandbox="allow-scripts"></iframe>`);
  await sourcePage.evaluate(() => { document.querySelector('iframe')!.srcdoc = `<style>body{margin:0;font:18px sans-serif}input,select,div{display:block;margin:10px}</style><input id="text"><div id="edit" contenteditable="true">Editable</div><select id="select"><option value="one">One</option><option disabled>Disabled</option><option value="two">Two</option></select><input id="date" type="date"><input id="color" type="color"><input id="files" type="file"><script>window.events=[];for(const type of ['beforeinput','input','change','compositionstart','compositionupdate','compositionend'])document.addEventListener(type,event=>events.push({type:event.type,trusted:event.isTrusted,id:event.target.id,data:event.data}),true)</script>`; });
  await sourcePage.waitForTimeout(30);
  const sourceFrame = sourcePage.frames().find(source => source.parentFrame())!; await sourceFrame.waitForSelector('#text');
  const rootClient = await sourcePage.context().newCDPSession(sourcePage), sourceClient = await sourcePage.context().newCDPSession(sourceFrame), tree = await sourceClient.send('Page.getFrameTree');
  const isolated = await sourceClient.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'acanvas-control-test' });
  const runtime = {
    // This ordinary Chromium fixture measures the browser's focused-widget CDP composition route.
    protocol: async (method: string, params: any = {}) => (method.startsWith('Input.') ? rootClient : sourceClient).send(method as any, params),
    documentEvaluate: async (expression: string) => { const result = await sourceClient.send('Runtime.evaluate', { expression, contextId: isolated.executionContextId, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; },
    documentNode: async (selector: string) => { const result = await sourceClient.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})`, contextId: isolated.executionContextId }); return { objectId: result.result.objectId! }; },
  };
  const native = new NativeSurfaceControls(runtime, { directory }); t.after(() => native.close());
  await native.apply({ type: 'focus', controlId: '#text' }); await runtime.protocol('Input.insertText', { text: 'native text' });
  await native.apply({ type: 'text-selection', controlId: '#text', start: 0, end: 6 }); await runtime.protocol('Input.insertText', { text: 'Trusted' }); assert.equal(await sourceFrame.locator('#text').inputValue(), 'Trusted text');
  await native.apply({ type: 'focus', controlId: '#edit' }); await native.apply({ type: 'text-selection', controlId: '#edit', start: 0, end: 8 });
  await native.apply({ type: 'composition', action: 'update', text: 'に', selectionStart: 1, selectionEnd: 1 }); await native.apply({ type: 'composition', action: 'update', text: '日本', selectionStart: 2, selectionEnd: 2 }); await native.apply({ type: 'composition', action: 'commit', text: '日本' }); assert.equal(await sourceFrame.locator('#edit').textContent(), '日本');
  await native.apply({ type: 'control', controlId: '#select', value: 'two' }).catch(async error => { throw new Error(`${error}: ${JSON.stringify(await sourceFrame.evaluate(() => ({ events: (window as any).events, value: (document.querySelector('#select') as HTMLSelectElement).value })))}`); }); assert.equal(await sourceFrame.locator('#select').inputValue(), 'two');
  await native.apply({ type: 'control', controlId: '#date', value: '2027-01-02' }); await native.apply({ type: 'control', controlId: '#color', value: '#abcdef' });
  assert.equal(await sourceFrame.locator('#date').inputValue(), '2027-01-02'); assert.equal(await sourceFrame.locator('#color').inputValue(), '#abcdef');
  await native.apply({ type: 'files', controlId: '#files', files: [file] }); assert.equal(await sourceFrame.locator('#files').evaluate(async element => (element as HTMLInputElement).files![0].text()), 'Selected bytes 世界');
  const sourceEvents = await sourceFrame.evaluate(() => (window as any).events);
  for (const type of ['compositionstart', 'compositionupdate']) assert(sourceEvents.some((event: any) => event.id === 'edit' && event.type === type && event.trusted), `Native source ${type}`);
  assert(sourceEvents.some((event: any) => event.id === 'edit' && event.type === 'compositionend' && !event.trusted), 'Source CDP compositionend trust is recorded separately from beforeinput/input.');
  assert(sourceEvents.some((event: any) => event.id === 'select' && event.type === 'change' && !event.trusted));
  assert(sourceEvents.some((event: any) => event.id === 'files' && event.type === 'change' && event.trusted));
  assert(sourceEvents.some((event: any) => event.id === 'date' && event.type === 'change' && !event.trusted)); assert(sourceEvents.some((event: any) => event.id === 'color' && event.type === 'change' && !event.trusted));
  assert.equal(await sourceFrame.evaluate(() => self.origin), 'null');
  const sourcePng = await sourcePage.screenshot(); assert(sourcePng.length > 1000);
  const evidence = process.env.ACANVAS_HTML_CONTROLS_EVIDENCE;
  if (evidence) {
    await mkdir(resolve(evidence, '..'), { recursive: true });
    await writeFile(evidence, JSON.stringify({ measuredAt: new Date().toISOString(), status: 'ordinary-browser-controls-passed', engine: await browser.version(), source: { sandbox: 'allow-scripts', origin: 'null', world: 'isolated', permissionsExpanded: false }, proxy: { ordinaryText: 'native', compositionValue: '日本', compositionCommitCount: 1, compositionStartTrusted: true, compositionUpdateTrusted: true, compositionEndTrusted: false, semanticReadingOrder: true, sourceTabAction: true, chosenFileBytes: 'client chosen 世界', chosenFilePathAccepted: false }, sourceValues: { text: 'Trusted text', contenteditable: '日本', select: 'two', date: '2027-01-02', color: '#abcdef', file: 'Selected bytes 世界' }, sourceEvents: { textInputTrusted: sourceEvents.filter((event: any) => event.id === 'text' && event.type === 'input').every((event: any) => event.trusted), compositionStartTrusted: true, compositionUpdateTrusted: true, compositionEndTrusted: false, fileChangeTrusted: true, selectChangeTrusted: false, dateChangeTrusted: false, colorChangeTrusted: false }, protocols: { compositionCommit: 'Input.insertText', ordinaryBrowserAdapter: 'Input.insertText', fileInput: 'DOM.setFileInputFiles', valueEvents: 'input/change with isTrusted false' }, sourcePngBytes: sourcePng.length, limitations: ['CEF public ImeCommitText route requires its separate native integration test.', 'Actual OS IME candidate UI and native CEF popup widgets are separate acceptance.', 'Source frame/current-view scope enforcement belongs to ProjectHtmlSurfaces and SceneHtmlSurface integration.', 'Mac headless select keyboard trials kept the original value; the value channel provides select changes.', 'No CEF runtime or user service was launched by this test.'] }, null, 2) + '\n');
    await writeFile(evidence.replace(/\.json$/u, '') + '-source.png', sourcePng);
  }
});
