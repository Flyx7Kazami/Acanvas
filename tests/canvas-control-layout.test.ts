import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';

test('contextual controls synchronously follow selection and dynamic obstacles with one resize subscription', { skip: process.env.ACANVAS_CANVAS_LAYOUT_BROWSER_TESTS !== '1' }, async t => {
  const source = `
import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{useContextualControls}from${JSON.stringify(resolve('src/web/useCanvasLayout.ts'))};
function Fixture(){const canvas=useRef(null),actions=useRef(null),playback=useRef(null);const[state,set]=useState({selected:[{x:300,y:250,width:200,height:140}],view:{x:0,y:0,zoom:1,selectedObjectIds:[]},video:undefined,title:false,playback:false});
window.update=patch=>flushSync(()=>set(current=>({...current,...patch})));useContextualControls(canvas,actions,playback,state.selected,state.video,state.view);
return React.createElement(React.Fragment,null,React.createElement('header',{className:'project-identity'}),React.createElement('aside',{className:'canvas-actions'}),React.createElement('nav',{className:'canvas-toolbar'}),React.createElement('div',{ref:canvas,id:'board'},state.title&&React.createElement('div',{className:'group-frame-title'},'Group'),React.createElement('div',{ref:actions,id:'selection'},React.createElement('button',null,'Action')),state.playback&&React.createElement('div',{ref:playback,id:'playback'},React.createElement('button',null,'Play'))),React.createElement('section',{className:'creation-dock'},React.createElement('div',{className:'composer'})));}
flushSync(()=>createRoot(document.getElementById('root')).render(React.createElement(Fixture)));`;
  const bundle = await build({ configFile: false, logLevel: 'silent', plugins: [react(), { name: 'canvas-layout-fixture', resolveId: id => id === 'canvas-layout-entry' ? '\0canvas-layout-entry' : undefined, load: id => id === '\0canvas-layout-entry' ? source : undefined }], build: { write: false, minify: false, rollupOptions: { input: 'canvas-layout-entry', output: { inlineDynamicImports: true } } } });
  const result = Array.isArray(bundle) ? bundle[0] : bundle;
  assert('output' in result);
  const code = result.output.find(item => item.type === 'chunk');
  assert(code?.type === 'chunk');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<!doctype html><style>
body{margin:0}#board{position:absolute;inset:0;width:900px;height:650px}
.project-identity,.canvas-actions{position:absolute;top:10px;width:100px;height:32px}.project-identity{left:10px}.canvas-actions{right:10px}
.canvas-toolbar{position:absolute;left:10px;top:250px;width:32px;height:100px}.creation-dock{position:absolute;left:250px;top:500px;width:400px;height:70px}.composer{width:400px;height:70px}
#selection,#playback{position:absolute;box-sizing:border-box}#selection{width:120px;height:36px}#playback{height:42px}
.group-frame-title{position:absolute;left:300px;top:190px;width:220px;height:40px}
</style><div id="root"></div>`);
  await page.evaluate(() => {
    const facts = (window as any).observerFacts = { created: 0, elements: new Set<Element>() };
    const Original = window.ResizeObserver;
    window.ResizeObserver = class extends Original {
      constructor(callback: ResizeObserverCallback) { super(callback); facts.created++; }
      observe(element: Element, options?: ResizeObserverOptions) { facts.elements.add(element); super.observe(element, options); }
      unobserve(element: Element) { facts.elements.delete(element); super.unobserve(element); }
      disconnect() { facts.elements.clear(); super.disconnect(); }
    };
  });
  await page.addScriptTag({ content: code.code });
  const snapshot = () => page.evaluate(() => {
    const read = (id: string) => { const node = document.getElementById(id)!; return node ? { left: parseFloat(node.style.left), top: parseFloat(node.style.top), width: node.getBoundingClientRect().width, positioned: node.dataset.positioned, hidden: node.getAttribute('aria-hidden'), inert: node.inert } : null; };
    return { action: read('selection'), video: read('playback'), queue: document.querySelector<HTMLElement>('.creation-dock')!.style.getPropertyValue('--queue-context-limit'), created: (window as any).observerFacts.created, detached: [...(window as any).observerFacts.elements].filter((node: Element) => !node.isConnected).length };
  });
  const update = (patch: object) => page.evaluate(patch => (window as any).update(patch), patch);
  assert.deepEqual((await snapshot()).action, { left: 340, top: 206, width: 120, positioned: 'true', hidden: 'false', inert: false });
  assert.equal((await snapshot()).queue, '398px');
  for (let x = 1; x <= 30; x++) await update({ view: { x, y: 0, zoom: 1, selectedObjectIds: [] } });
  assert.equal((await snapshot()).created, 1);
  assert.equal((await snapshot()).action?.left, 370);
  await update({ title: true });
  const clearOfTitle = async () => page.evaluate(() => { const a = document.querySelector('#selection')!.getBoundingClientRect(), b = document.querySelector('.group-frame-title')!.getBoundingClientRect(); return a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom; });
  assert.equal(await clearOfTitle(), true);
  const beforeResize = (await snapshot()).action;
  await page.locator('.group-frame-title').evaluate(node => { const style = (node as HTMLElement).style; style.top = '100px'; style.height = '600px'; style.left = '0px'; style.width = '900px'; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.notDeepEqual((await snapshot()).action, beforeResize);
  assert.equal(await clearOfTitle(), true);
  await update({ title: false });
  assert.equal((await snapshot()).detached, 0);
  assert.equal((await snapshot()).action?.top, 206);
  await update({ view: { x: -1000, y: -1000, zoom: 1, selectedObjectIds: [] } });
  assert.equal((await snapshot()).action?.inert, true);
  assert.equal((await snapshot()).action?.hidden, 'true');
  assert.equal((await snapshot()).queue, '');
  await update({ view: { x: 0, y: 0, zoom: 1, selectedObjectIds: [] }, playback: true, video: { x: 300, y: 250, width: 200, height: 140 } });
  assert.equal((await snapshot()).video?.positioned, 'true');
  assert.equal((await snapshot()).video?.width, 184);
  assert.equal((await snapshot()).created, 1);
  await update({ selected: [] });
  assert.equal((await snapshot()).queue, '');
  assert.equal((await snapshot()).detached, 0);
  await update({ selected: [{ x: 300, y: 250, width: 200, height: 140 }], playback: false });
  assert.equal((await snapshot()).action?.positioned, 'true');
  assert.equal((await snapshot()).detached, 0);
  assert.deepEqual(errors, []);
});
