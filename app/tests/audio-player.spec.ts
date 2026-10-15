import { test as base, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function wav() {
  const rate = 44100, seconds = 24, data = Buffer.alloc(seconds * rate * 2), header = Buffer.alloc(44);
  for (let index = 0; index < seconds * rate; index++) { const time = index / rate, amplitude = time < 2 ? .08 : time < 4 ? .65 : time < 6 ? 0 : .25; data.writeInt16LE(Math.round(Math.sin(time * 440 * Math.PI * 2) * amplitude * 30000), index * 2); }
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const test = base.extend<{ playerUrl: string }>({
  playerUrl: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'acanvas-audio-player-')), workspace = resolve('.');
    const server = await createServer({ configFile: false, root, resolve: { alias: { react: resolve('node_modules/react'), 'react-dom': resolve('node_modules/react-dom') } }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, workspace] } } });
    await writeFile(join(root, 'tone.wav'), wav()); await writeFile(join(root, 'invalid.wav'), 'An invalid audio file.');
    await writeFile(join(root, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="UTF-8"/><title>Audio fixture</title></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
    await writeFile(join(root, 'fixture.tsx'), `import React, {StrictMode,useState} from 'react';import {createRoot} from 'react-dom/client';import '/@fs/${workspace}/app/src/web/styles.css';import {AudioCanvasPlayer} from '/@fs/${workspace}/app/src/web/AudioCanvasPlayer.tsx';
      const stats=window as any;stats.layoutWrites=0;stats.parentPointers=0;
      function Fixture(){const [mounted,setMounted]=useState(true),[width,setWidth]=useState(420),[src,setSrc]=useState(new URLSearchParams(location.search).has('cached')?'/api/assets/00000000-0000-4000-8000-000000000001/content':'/tone.wav');return <><style>{'body{margin:0;padding:30px;background:#e8e8e5;font-family:Arial}button{font:inherit} .frame{width:420px;position:relative}body[data-theme=dark]{background:#151515;--surface:#222;--soft:#333;--ink:#eee;--muted:#aaa;--edge:#444}'}</style><div className="frame" style={{width,height:88}} onPointerDown={()=>stats.parentPointers++}>{mounted&&<AudioCanvasPlayer src={src} title="Amplitude study.wav" onElement={element=>stats.audio=element} onError={error=>stats.lastError=String(error)}/>}</div>{mounted&&new URLSearchParams(location.search).has('duplicate')&&<div className="frame" style={{width,height:88}}><AudioCanvasPlayer src={src} title="Amplitude study.wav"/></div>}<button onClick={()=>setMounted(false)}>Unmount fixture</button><button onClick={()=>{setMounted(false);setTimeout(()=>setMounted(true),0)}}>Remount fixture</button><button onClick={()=>setWidth(280)}>Use minimum width</button><button onClick={()=>{document.documentElement.dataset.theme='dark'}}>Dark theme</button><button onClick={()=>setSrc('/invalid.wav')}>Load invalid audio</button></>};createRoot(document.getElementById('root')!).render(<StrictMode><Fixture/></StrictMode>);`);
    try { await server.listen(); await use(server.resolvedUrls!.local[0]); } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  },
});

test('complete waveform is ready before playback and seeks across the whole track', async ({ page, playerUrl }, info) => {
  await page.goto(playerUrl);
  const range=page.getByRole('slider', {name:'Audio timeline'}), wave=page.locator('.audio-player-waveform canvas');
  await expect(wave).toHaveAttribute('data-ready','true');
  expect(await page.locator('audio').evaluate((m:HTMLAudioElement)=>m.paused)).toBe(true);
  const box=(await range.boundingBox())!;
  await page.mouse.click(box.x+box.width*.75,box.y+box.height/2);
  await expect.poll(()=>page.locator('audio').evaluate((m:HTMLAudioElement)=>m.currentTime)).toBeCloseTo(18,0);
  await range.press('Home');await expect(range).toHaveAttribute('aria-valuenow','0');
  await page.getByRole('button',{name:'Play audio',exact:true}).click();
  await expect.poll(()=>page.locator('audio').evaluate((m:HTMLAudioElement)=>m.currentTime)).toBeGreaterThan(.2);
  await page.mouse.move(box.x+box.width*.2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width*.5,box.y+box.height/2);await page.mouse.up();
  await expect(page.getByRole('button',{name:'Pause audio',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Pause audio',exact:true}).click();
  await expect(wave).toHaveAttribute('data-ready','true');
  const t=await page.locator('audio').evaluate((m:HTMLAudioElement)=>m.currentTime);await page.waitForTimeout(100);expect(await page.locator('audio').evaluate((m:HTMLAudioElement)=>m.currentTime)).toBe(t);
  expect(await page.evaluate(()=>(window as any).parentPointers)).toBe(0);
  await page.locator('.audio-canvas-player').screenshot({path:info.outputPath('layout-a-player.png')});
  await page.getByRole('button',{name:'Unmount fixture'}).click();await expect(page.locator('audio')).toHaveCount(0);
});

test('layout A keeps name cover and controls within minimum bounds', async ({page,playerUrl},info)=>{
  await page.goto(playerUrl);await page.getByRole('button',{name:'Use minimum width'}).click();
  const player=page.locator('.audio-canvas-player');await expect(player).toHaveCSS('border-radius','22px');
  await expect(player.locator('.audio-player-heading strong')).toHaveText('Amplitude study');
  await expect(player.getByRole('button')).toHaveCount(1);await expect(player.getByRole('slider')).toHaveCount(1);
  const fits=await player.evaluate(e=>{const r=e.getBoundingClientRect();return Array.from(e.querySelectorAll('.audio-player-cover,.audio-player-heading,button,.audio-player-waveform,.audio-player-clock')).every(c=>{const b=c.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom;});});expect(fits).toBe(true);
  await page.getByRole('button',{name:'Dark theme'}).click();await page.emulateMedia({reducedMotion:'reduce'});await player.screenshot({path:info.outputPath('layout-a-minimum.png')});
});

test('source errors retain download and disable playback', async ({page,playerUrl})=>{
 await page.goto(playerUrl);await page.getByRole('button',{name:'Load invalid audio'}).click();await expect(page.getByRole('link',{name:'Download',exact:true})).toHaveAttribute('href','/invalid.wav');await expect(page.getByRole('button',{name:'Play audio',exact:true})).toBeDisabled();
 await expect(page.locator('.audio-wave-status')).not.toHaveText('Loading waveform…');
});

test('oversize waveform reports its limit while native playback remains available', async ({ page, playerUrl }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (...args) => String(args[0]).endsWith('/tone.wav')
      ? Promise.resolve(new Response(new Uint8Array(), { status: 200, headers: { 'content-length': String(32 * 1024 * 1024 + 1) } }))
      : original(...args);
  });
  await page.goto(playerUrl);
  await expect(page.locator('.audio-wave-status')).toHaveText('Waveform supports files up to 32 MB');
  await expect(page.getByRole('button', { name: 'Play audio', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Play audio', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause audio', exact: true })).toBeVisible();
});


test('selected layout A fills compact wide square and tall sizes in both themes', async ({ page, playerUrl }, info) => {
  await page.goto(playerUrl);
  const player = page.locator('.audio-canvas-player');
  await expect(player.locator('canvas')).toHaveAttribute('data-ready', 'true');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const [name, width, height, layout] of [['compact', 520, 88, 'compact'], ['wide', 620, 260, 'beside'], ['square', 420, 420, 'stack'], ['tall', 320, 480, 'stack']] as const) {
      await page.locator('.frame').evaluate((element, size) => { element.style.width = size[0] + 'px'; element.style.height = size[1] + 'px'; }, [width, height]);
      await expect(player).toHaveAttribute('data-layout', layout);
      await expect(player).toHaveCSS('background-color', theme === 'dark' ? 'rgb(41, 41, 41)' : 'rgb(231, 231, 231)');
      const measured = await player.evaluate(element => {
        const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
        const within = Array.from(element.querySelectorAll('.audio-player-cover,.audio-player-heading,.audio-player-play,.audio-player-waveform,.audio-player-clock')).every(child => { const b = child.getBoundingClientRect(); return b.left >= bounds.left && b.right <= bounds.right && b.top >= bounds.top && b.bottom <= bounds.bottom; });
        const cover = element.querySelector('.audio-player-cover')!, play = element.querySelector('.audio-player-play')!, wave = element.querySelector('.audio-player-waveform')!;
        return { width: bounds.width, height: bounds.height, radius: style.borderRadius, coverRadius: getComputedStyle(cover).borderRadius, coverWidth: cover.getBoundingClientRect().width, playWidth: play.getBoundingClientRect().width, waveHeight: wave.getBoundingClientRect().height, within };
      });
      expect(measured).toMatchObject({ width, height, radius: '22px', coverRadius: '12px', playWidth: 30, within: true });
      expect(measured.waveHeight).toBeLessThanOrEqual(64);
      if (name === 'compact') expect(measured).toMatchObject({ coverWidth: 64, waveHeight: 32 });
      await player.screenshot({ path: info.outputPath(`selected-a-${theme}-${name}.png`) });
    }
  }
});

test('paused and playing theme changes repaint existing waveform without decoding or resetting audio', async ({ page, playerUrl }) => {
  await page.addInitScript(() => {
    const decode = OfflineAudioContext.prototype.decodeAudioData;
    (window as any).decodeCount = 0;
    OfflineAudioContext.prototype.decodeAudioData = function (...args: Parameters<typeof decode>) { (window as any).decodeCount++; return decode.apply(this, args); };
  });
  await page.goto(playerUrl);
  const player = page.locator('.audio-canvas-player'), range = player.getByRole('slider'), wave = player.locator('canvas');
  await expect(wave).toHaveAttribute('data-ready', 'true');
  await range.press('PageUp');
  const before = await page.evaluate(() => { (window as any).originalAudio = document.querySelector('audio'); return { time: (window as any).originalAudio.currentTime, decodes: (window as any).decodeCount }; });
  const pixels = () => wave.evaluate((canvas: HTMLCanvasElement) => [...new Set(Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data).filter((_, index) => index % 4 === 0))]);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await expect.poll(pixels).toContain(170);
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBe(before.time);
  await player.getByRole('button', { name: 'Play audio', exact: true }).click();
  await expect(player.getByRole('button', { name: 'Pause audio', exact: true })).toBeVisible();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await expect.poll(pixels).toContain(128);
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(before.time);
  expect(await page.evaluate(() => ({ same: document.querySelector('audio') === (window as any).originalAudio, decodes: (window as any).decodeCount }))).toEqual({ same: true, decodes: before.decodes });
});

test('remount reuses the complete waveform without fetching or decoding again', async ({ page, playerUrl }) => {
  await page.addInitScript(() => {
    (window as any).waveRequests = 0; (window as any).waveDecodes = 0;
    const fetchOriginal = window.fetch;
    window.fetch = (...args) => { if (String(args[0]).includes('/tone.wav')) (window as any).waveRequests++; return fetchOriginal(...args); };
    const decodeOriginal = OfflineAudioContext.prototype.decodeAudioData;
    OfflineAudioContext.prototype.decodeAudioData = function (...args: Parameters<typeof decodeOriginal>) { (window as any).waveDecodes++; return decodeOriginal.apply(this, args); };
  });
  await page.goto(playerUrl);
  await expect(page.locator('.audio-player-waveform canvas')).toHaveAttribute('data-ready', 'true');
  const before = await page.evaluate(() => ({ requests: (window as any).waveRequests, decodes: (window as any).waveDecodes }));
  expect(before).toEqual({ requests: 1, decodes: 1 });
  await page.getByRole('button', { name: 'Remount fixture' }).click();
  await expect(page.locator('.audio-player-waveform canvas')).toHaveAttribute('data-ready', 'true');
  expect(await page.evaluate(() => ({ requests: (window as any).waveRequests, decodes: (window as any).waveDecodes }))).toEqual(before);
  await page.getByRole('slider', { name: 'Audio timeline' }).press('End');
  expect(Number(await page.getByRole('slider', { name: 'Audio timeline' }).getAttribute('aria-valuenow'))).toBeGreaterThan(23);
});

test('two players of one source share one complete-file read and decode', async ({ page, playerUrl }) => {
  await page.addInitScript(() => {
    (window as any).waveRequests = 0; (window as any).waveDecodes = 0;
    const fetchOriginal = window.fetch;
    window.fetch = (...args) => { if (String(args[0]).includes('/tone.wav')) (window as any).waveRequests++; return fetchOriginal(...args); };
    const decodeOriginal = OfflineAudioContext.prototype.decodeAudioData;
    OfflineAudioContext.prototype.decodeAudioData = function (...args: Parameters<typeof decodeOriginal>) { (window as any).waveDecodes++; return decodeOriginal.apply(this, args); };
  });
  await page.goto(playerUrl + '?duplicate=1');
  await expect(page.locator('.audio-player-waveform canvas')).toHaveCount(2);
  await expect.poll(() => page.locator('.audio-player-waveform canvas[data-ready="true"]').count()).toBe(2);
  expect(await page.evaluate(() => ({ requests: (window as any).waveRequests, decodes: (window as any).waveDecodes }))).toEqual({ requests: 1, decodes: 1 });
});

test('refresh restores an immutable asset envelope without fetching or decoding the complete file', async ({ page, playerUrl }) => {
  await page.addInitScript(() => {
    (window as any).waveRequests = 0; (window as any).waveDecodes = 0;
    const fetchOriginal = window.fetch;
    window.fetch = (...args) => { if (String(args[0]).includes('/00000000-0000-4000-8000-000000000001/content')) (window as any).waveRequests++; return fetchOriginal(...args); };
    const decodeOriginal = OfflineAudioContext.prototype.decodeAudioData;
    OfflineAudioContext.prototype.decodeAudioData = function (...args: Parameters<typeof decodeOriginal>) { (window as any).waveDecodes++; return decodeOriginal.apply(this, args); };
  });
  const file = wav();
  await page.route('**/api/assets/00000000-0000-4000-8000-000000000001/content', route => {
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0, end = range && range[2] ? Number(range[2]) : file.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav', headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${file.length}` } : {}) }, body: file.subarray(start, end + 1) });
  });
  await page.goto(playerUrl + '?cached=1');
  await expect(page.locator('.audio-player-waveform canvas')).toHaveAttribute('data-ready', 'true');
  expect(await page.evaluate(() => ({ requests: (window as any).waveRequests, decodes: (window as any).waveDecodes }))).toEqual({ requests: 1, decodes: 1 });
  await page.reload();
  await expect(page.locator('.audio-player-waveform canvas')).toHaveAttribute('data-ready', 'true');
  expect(await page.evaluate(() => ({ requests: (window as any).waveRequests, decodes: (window as any).waveDecodes }))).toEqual({ requests: 0, decodes: 0 });
  const player = page.locator('.audio-canvas-player');
  await expect(player.getByRole('button', { name: 'Play audio', exact: true })).toBeEnabled();
  await player.getByRole('slider', { name: 'Audio timeline' }).press('End');
  await expect.poll(async () => Number(await player.getByRole('slider', { name: 'Audio timeline' }).getAttribute('aria-valuenow'))).toBeGreaterThan(23);
  await page.evaluate(() => sessionStorage.setItem('acanvas-waveform-v1:' + new URL('/api/assets/00000000-0000-4000-8000-000000000001/content', location.href).href, 'invalid'));
  await page.reload();
  await expect(page.locator('.audio-player-waveform canvas')).toHaveAttribute('data-ready', 'true');
  expect(await page.evaluate(() => ({ requests: (window as any).waveRequests, decodes: (window as any).waveDecodes }))).toEqual({ requests: 1, decodes: 1 });
});

test('playhead stays visible at the exact progress position through playback, pause, theme and seeking', async ({ page, playerUrl }, info) => {
  await page.goto(playerUrl);
  const player = page.locator('.audio-canvas-player'), wave = player.locator('.audio-player-waveform canvas'), range = player.getByRole('slider');
  await expect(wave).toHaveAttribute('data-ready', 'true');
  const inspect = () => wave.evaluate((canvas: HTMLCanvasElement) => {
    const { width, height } = canvas, pixels = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
    const top = Array.from({ length: width }, (_, x) => pixels[x * 4 + 3] > 0 ? x : -1).filter(x => x >= 0);
    const progress = Number(canvas.dataset.progress), cursor = top.reduce((sum, x) => sum + x, 0) / top.length;
    const colors = (start: number, end: number) => {
      const found = new Set<number>();
      for (let x = start; x < end; x++) { const index = (Math.floor(height / 2) * width + x) * 4; if (pixels[index + 3] === 255) found.add(pixels[index]); }
      return [...found];
    };
    return { progress, cursor, expected: progress * width, colorsBefore: colors(0, Math.floor(width * .45)), colorsAfter: colors(Math.ceil(width * .55), width), topColors: top.map(x => pixels[x * 4]), width };
  });
  await page.locator('audio').evaluate((audio: HTMLAudioElement) => { audio.currentTime = 8; });
  await expect.poll(async () => (await inspect()).progress).toBeGreaterThan(.33);
  const light = await inspect();
  expect(Math.abs(light.cursor - light.expected)).toBeLessThan(2);
  expect(light.topColors).toContain(32);
  expect(light.colorsBefore).toContain(32);
  expect(light.colorsAfter).toContain(128);
  await player.screenshot({ path: info.outputPath('light-mid-progress.png') });

  await player.getByRole('button', { name: 'Play audio', exact: true }).click();
  await expect.poll(async () => (await inspect()).progress).toBeGreaterThan(light.progress + .02);
  const playing = await inspect();
  expect(Math.abs(playing.cursor - playing.expected)).toBeLessThan(2);
  await player.getByRole('button', { name: 'Pause audio', exact: true }).click();
  await expect(player.getByRole('button', { name: 'Play audio', exact: true })).toBeVisible();
  await page.waitForTimeout(120);
  const paused = await inspect();
  await page.waitForTimeout(120);
  expect(Math.abs((await inspect()).progress - paused.progress)).toBeLessThan(.001);

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await expect.poll(async () => (await inspect()).topColors).toContain(245);
  const dark = await inspect();
  expect(Math.abs(dark.cursor - dark.expected)).toBeLessThan(2);
  expect(dark.colorsBefore).toContain(245);
  expect(dark.colorsAfter).toContain(170);
  const box = (await range.boundingBox())!;
  await page.mouse.click(box.x + box.width * .75, box.y + box.height / 2);
  await expect.poll(async () => (await inspect()).progress).toBeGreaterThan(.74);
  expect(Math.abs((await inspect()).cursor - (await inspect()).expected)).toBeLessThan(2);
  await player.screenshot({ path: info.outputPath('dark-seek-progress.png') });
});


test('player typography grows with its layout dimensions and follows canvas zoom once', async ({ page, playerUrl }) => {
  await page.goto(playerUrl);
  const frame = page.locator('.frame'), player = page.locator('.audio-canvas-player'), title = player.locator('.audio-player-heading strong');
  await frame.evaluate(element => { element.style.width = '520px'; element.style.height = '88px'; });
  await expect(title).toHaveCSS('font-size', '14px');
  await frame.evaluate(element => { element.style.width = '420px'; element.style.height = '420px'; });
  await expect(player).toHaveAttribute('data-layout', 'stack');
  const before = await title.evaluate(element => ({ font: parseFloat(getComputedStyle(element).fontSize), height: element.getBoundingClientRect().height }));
  expect(before.font).toBeGreaterThan(20);
  await frame.evaluate(element => { element.style.transformOrigin = 'top left'; element.style.transform = 'scale(.5)'; });
  const after = await title.evaluate(element => ({ font: parseFloat(getComputedStyle(element).fontSize), height: element.getBoundingClientRect().height }));
  expect(after.font).toBe(before.font); expect(after.height).toBeCloseTo(before.height / 2, 2);
});

test('mouse and touch scrubbing stay visually neutral while keyboard focus remains visible', async ({ page, browser, playerUrl }) => {
  await page.goto(playerUrl);
  const range = page.getByRole('slider', { name: 'Audio timeline' });
  await expect(page.locator('.audio-player-waveform canvas')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Play audio', exact: true }).focus();
  await page.keyboard.press('Tab'); await expect(range).toBeFocused(); await expect(range).toHaveCSS('outline-style', 'solid');
  const box = (await range.boundingBox())!;
  await page.mouse.click(box.x + box.width * .3, box.y + box.height / 2);
  await expect(range).toHaveCSS('outline-style', 'none'); await expect(range).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.mouse.move(box.x + box.width * .3, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width * .6, box.y + box.height / 2); await page.mouse.up();
  await expect(range).toHaveCSS('outline-style', 'none');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await range.press('Home'); await expect(range).toHaveCSS('outline-style', 'solid'); await expect(range).toHaveAttribute('aria-valuenow', '0');
  const touchContext = await browser.newContext({ hasTouch: true, viewport: { width: 800, height: 600 } });
  try {
    const touchPage = await touchContext.newPage(); await touchPage.goto(playerUrl); await expect(touchPage.locator('.audio-player-waveform canvas')).toHaveAttribute('data-ready', 'true');
    const slider = touchPage.getByRole('slider', { name: 'Audio timeline' }), r = (await slider.boundingBox())!;
    await touchPage.touchscreen.tap(r.x + r.width * .5, r.y + r.height / 2);
    await expect(slider).toHaveCSS('outline-style', 'none'); await expect(slider).toHaveCSS('-webkit-tap-highlight-color', 'rgba(0, 0, 0, 0)');
    expect(await touchPage.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeCloseTo(12, 0);
  } finally { await touchContext.close(); }
});
