import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Exercise the browser's actual visibility, mutation, intersection and resize observers.
test('HTML preview pool publishes changed slots and preserves synchronous lifecycle decisions', { timeout: 45_000 }, async t => {
  const { createServer } = await import('vite'), { chromium } = await import('playwright-core');
  const cacheDir = await mkdtemp(join(tmpdir(), 'acanvas-preview-pool-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const server = await createServer({
    configFile: false, appType: 'mpa', root: process.cwd(), cacheDir, esbuild: { jsx: 'automatic' }, logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.runtime/**'] } },
    plugins: [{ name: 'preview-pool-fixture', configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== '/pool-test.html') return next();
        response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><style>body{margin:0}.concealed{visibility:hidden}</style><div id="world"></div>');
      });
    } }],
  });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0] + 'pool-test.html');
  const facts = await page.evaluate(async () => {
    const { HtmlPreviewPool } = await import('/src/web/HtmlPreviewPool.tsx' as string);
    const pool = new HtmlPreviewPool(), root = document.querySelector('#world') as HTMLElement;
    const entries: { id: symbol; element: HTMLDivElement; remove(): void }[] = [];
    const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const add = (index: number) => {
      const element = document.createElement('div');
      element.style.cssText = `position:absolute;left:${20 + index % 10 * 100}px;top:${20 + Math.floor(index / 10) * 100}px;width:80px;height:80px`;
      root.append(element); const id = Symbol(String(index)), unregister = pool.register(id, element);
      const entry = { id, element, remove: () => { unregister(); element.remove(); } }; entries.push(entry); return entry;
    };
    const finishCaptures = () => {
      for (let turn = 0; turn < entries.length + 1; turn++) {
        const entry = entries.find(({ id }) => pool.read(id).slot === 'capturing');
        if (!entry) break;
        const value = pool.read(entry.id);
        pool.complete(entry.id, value.generation, { url: `image:${turn}`, width: value.width, height: value.height });
      }
    };
    const one = add(0), two = add(1); await settle(); finishCaptures(); await settle();
    let notifications = 0; const unsubscribe = pool.subscribe(() => notifications++);
    const before = [one, two].map(({ id }) => pool.read(id)), version = pool.snapshot();
    for (let frame = 0; frame < 20; frame++) { root.style.transform = `translate(${frame % 2}px,0) scale(${1 - frame % 2 * .001})`; await settle(); }
    const quiet = { notifications, sameVersion: version === pool.snapshot(), sameState: [one, two].every(({ id }, index) => Object.keys(before[index]).every(key => before[index][key] === pool.read(id)[key])) };
    const immediate: string[] = [];
    pool.request(one.id); immediate.push(pool.read(one.id).slot);
    pool.stop(one.id); immediate.push(pool.read(one.id).slot);
    pool.complete(one.id, pool.read(one.id).generation, { url: 'updated', width: 80, height: 80 }); immediate.push(pool.read(one.id).slot);
    const states: string[] = [];
    for (const attribute of ['inert', 'hidden', 'aria-hidden', 'class', 'style']) {
      const previous = one.element.getAttribute(attribute);
      one.element.setAttribute(attribute, attribute === 'aria-hidden' ? 'true' : attribute === 'class' ? 'concealed' : attribute === 'style' ? `${previous};visibility:hidden` : '');
      await settle(); states.push(pool.read(one.id).slot);
      if (previous === null) one.element.removeAttribute(attribute); else one.element.setAttribute(attribute, previous);
      await settle(); states.push(pool.read(one.id).slot);
    }
    root.style.transform = 'translate(-6000px,0)'; await settle(); states.push(pool.read(one.id).slot);
    root.style.transform = ''; await settle(); states.push(pool.read(one.id).slot);
    pool.preserve(one.id, true); pool.request(one.id);
    Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange'));
    const background = [pool.read(one.id).slot, pool.read(two.id).slot];
    Reflect.deleteProperty(document, 'hidden'); document.dispatchEvent(new Event('visibilitychange'));
    const foreground = [pool.read(one.id).slot, pool.read(two.id).slot];
    pool.preserve(one.id, false); pool.stop(one.id); pool.complete(one.id, pool.read(one.id).generation, { url: 'foreground', width: 80, height: 80 });
    one.element.style.width = '91.5px'; await new Promise(resolve => setTimeout(resolve, 260)); await settle();
    const resized = pool.read(one.id); const oldGeneration = resized.generation;
    pool.complete(one.id, oldGeneration - 1, { url: 'stale', width: 80, height: 80 });
    const rejectedStale = pool.read(one.id).image?.url !== 'stale'; finishCaptures();
    const afterResize = pool.read(one.id);
    const controllers = Array.from({ length: 5 }, () => new AbortController()), releases: (() => void)[] = [];
    for (let index = 0; index < 4; index++) releases.push(await pool.acquire(controllers[index].signal));
    const cancelled = pool.acquire(controllers[4].signal).then(() => false, (error: DOMException) => error.name === 'AbortError');
    controllers[4].abort(); const cancelledPermit = await cancelled;
    let admitted = false; const queued = pool.acquire(new AbortController().signal).then((release: () => void) => { admitted = true; releases.push(release); });
    await Promise.resolve(); const waiting = !admitted; releases.shift()!(); await queued;
    releases.forEach(release => { release(); release(); });
    for (let index = 2; index < 65; index++) add(index); await settle(); finishCaptures(); await settle();
    const cached = entries.filter(({ id }) => !!pool.read(id).image).length;
    const stopped = entries.filter(({ id }) => pool.read(id).slot === 'stopped').length;
    const beforeNoop = pool.snapshot(); root.style.transform = 'translate(1px,0)'; await settle();
    const stableAfterEviction = pool.snapshot() === beforeNoop;
    const beforeRemoval = pool.snapshot(); entries.at(-1)!.remove(); const removedPublished = pool.snapshot() > beforeRemoval;
    unsubscribe(); entries.slice(0, -1).forEach(entry => entry.remove());
    return { quiet, immediate, states, background, foreground, resized: { width: afterResize.width, generation: afterResize.generation, oldGeneration, slot: afterResize.slot }, rejectedStale, cancelledPermit, waiting, admitted, cached, stopped, stableAfterEviction, removedPublished, notifications };
  });
  assert.deepEqual(facts.quiet, { notifications: 0, sameVersion: true, sameState: true });
  assert.deepEqual(facts.immediate, ['live', 'freezing', 'frozen']);
  assert.deepEqual(facts.states, Array.from({ length: 6 }, () => ['hidden', 'frozen']).flat());
  assert.deepEqual(facts.background, ['live', 'hidden']); assert.deepEqual(facts.foreground, ['live', 'frozen']);
  assert.equal(facts.resized.width, 92); assert.ok(facts.resized.generation > 0); assert.equal(facts.resized.generation, facts.resized.oldGeneration); assert.equal(facts.resized.slot, 'frozen');
  assert.equal(facts.rejectedStale, true); assert.equal(facts.cancelledPermit, true); assert.equal(facts.waiting, true); assert.equal(facts.admitted, true);
  assert.equal(facts.cached, 64); assert.equal(facts.stopped, 1); assert.equal(facts.stableAfterEviction, true); assert.equal(facts.removedPublished, true); assert.ok(facts.notifications > 0);
  assert.deepEqual(errors, []);
  t.diagnostic(JSON.stringify(facts));
});
