import { test as base, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function wav() {
  const rate = 44100, seconds = 8, data = Buffer.alloc(seconds * rate * 2), header = Buffer.alloc(44);
  for (let index = 0; index < seconds * rate; index++) { const time = index / rate, frequency = time < 2 ? 440 : time < 4 ? 0 : time < 6 ? 1760 : 0; data.writeInt16LE(frequency ? Math.round(Math.sin(time * frequency * Math.PI * 2) * 24000) : 0, index * 2); }
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const test = base.extend<{ playerUrl: string }>({
  playerUrl: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'acanvas-audio-player-')), workspace = resolve('.');
    const server = await createServer({ configFile: false, root, resolve: { alias: { react: resolve('node_modules/react'), 'react-dom': resolve('node_modules/react-dom') } }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, workspace] } } });
    await writeFile(join(root, 'tone.wav'), wav()); await writeFile(join(root, 'invalid.wav'), 'An invalid audio file.');
    await writeFile(join(root, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="UTF-8"/><title>Audio fixture</title></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
    await writeFile(join(root, 'fixture.tsx'), `import React, {StrictMode,useState} from 'react';import {createRoot} from 'react-dom/client';import {AudioCanvasPlayer} from '/@fs/${workspace}/src/web/AudioCanvasPlayer.tsx';
      const stats=window as any;stats.layoutWrites=0;stats.parentPointers=0;
      function Fixture(){const [expanded,setExpanded]=useState(false),[mounted,setMounted]=useState(true),[width,setWidth]=useState(420),[src,setSrc]=useState('/tone.wav');return <><style>{'body{margin:0;padding:30px;background:#e8e8e5;font-family:Arial}button{font:inherit} .frame{width:420px;position:relative}body[data-theme=dark]{background:#151515;--surface:#222;--soft:#333;--ink:#eee;--muted:#aaa;--edge:#444}'}</style><div className="frame" style={{width,height:expanded?220:130}} onPointerDown={()=>stats.parentPointers++}>{mounted&&<AudioCanvasPlayer src={src} title="Frequency study.wav" expanded={expanded} onExpandedChange={value=>{stats.layoutWrites++;setExpanded(value)}} onElement={element=>stats.audio=element} onError={error=>stats.lastError=String(error)}/>}</div><button onClick={()=>setMounted(false)}>Unmount fixture</button><button onClick={()=>setWidth(280)}>Use minimum width</button><button onClick={()=>{document.body.dataset.theme='dark'}}>Dark theme</button><button onClick={()=>setSrc('/invalid.wav')}>Load invalid audio</button></>};createRoot(document.getElementById('root')!).render(<StrictMode><Fixture/></StrictMode>);`);
    try { await server.listen(); await use(server.resolvedUrls!.local[0]); } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  },
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const stats = (window as any).audioStats = { contexts: 0, sources: 0, reads: 0, sourceConnections: 0, analyserConnections: 0, disconnects: 0, closes: 0, peakHz: 0, maximum: 0, pendingFrames: new Set<number>() };
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      constructor() { super(); stats.contexts++; }
      createMediaElementSource(media: HTMLMediaElement) { const source = super.createMediaElementSource(media); stats.sources++; const connect = source.connect.bind(source), disconnect = source.disconnect.bind(source); source.connect = ((...args: any[]) => { stats.sourceConnections++; return (connect as any)(...args); }) as any; source.disconnect = ((...args: any[]) => { stats.disconnects++; return (disconnect as any)(...args); }) as any; return source; }
      createAnalyser() { const analyser = super.createAnalyser(), read = analyser.getByteFrequencyData.bind(analyser), connect = analyser.connect.bind(analyser), disconnect = analyser.disconnect.bind(analyser); analyser.getByteFrequencyData = bins => { read(bins); stats.reads++; let peak = 0; for (let bin = 1; bin < bins.length; bin++) if (bins[bin] > bins[peak]) peak = bin; stats.maximum = bins[peak]; stats.peakHz = peak * this.sampleRate / analyser.fftSize; }; analyser.connect = ((...args: any[]) => { stats.analyserConnections++; return (connect as any)(...args); }) as any; analyser.disconnect = ((...args: any[]) => { stats.disconnects++; return (disconnect as any)(...args); }) as any; return analyser; }
      close() { stats.closes++; return super.close(); }
    } as typeof AudioContext;
    const request = requestAnimationFrame.bind(window), cancel = cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => { const id = request(time => { stats.pendingFrames.delete(id); callback(time); }); stats.pendingFrames.add(id); return id; };
    window.cancelAnimationFrame = id => { stats.pendingFrames.delete(id); cancel(id); };
  });
});

test('real audio clock and FFT follow tone, silence, seeking, pause, end and unmount', async ({ page, playerUrl }, info) => {
  await page.goto(playerUrl); const play = page.getByRole('button', { name: 'Play audio', exact: true }), range = page.getByRole('slider', { name: 'Audio timeline' });
  await expect(play).toBeEnabled(); expect(await page.evaluate(() => (window as any).audioStats.contexts)).toBe(0);
  await play.click(); await expect(page.getByRole('button', { name: 'Pause audio', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).audio.currentTime)).toBeGreaterThan(.3);
  await expect.poll(() => page.evaluate(() => (window as any).audioStats.peakHz)).toBeGreaterThan(400); expect(await page.evaluate(() => (window as any).audioStats.peakHz)).toBeLessThan(500);
  const tone = await page.evaluate(() => ({ peak: (window as any).audioStats.peakHz, levels: Array.from(document.querySelectorAll<HTMLElement>('.audio-frequency-bar')).map(bar => ({ start: bar.dataset.frequencyStart, end: bar.dataset.frequencyEnd, level: Number(bar.style.getPropertyValue('--level')) })) }));
  expect(tone.levels.some(band => band.level > .5 && Number(band.start) < 440 && Number(band.end) > 440)).toBeTruthy();
  await range.fill('2.8'); await expect.poll(() => page.evaluate(() => (window as any).audioStats.maximum)).toBeLessThan(5);
  const silence = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.audio-frequency-bar')).map(bar => Number(bar.style.getPropertyValue('--level')))); expect(Math.max(...silence)).toBeLessThan(.02);
  await range.fill('4.3'); await expect.poll(() => page.evaluate(() => (window as any).audioStats.peakHz)).toBeGreaterThan(1700); expect(await page.evaluate(() => (window as any).audioStats.peakHz)).toBeLessThan(1820);
  const highTone = await page.evaluate(() => ({ peak: (window as any).audioStats.peakHz, levels: Array.from(document.querySelectorAll<HTMLElement>('.audio-frequency-bar')).map(bar => Number(bar.style.getPropertyValue('--level'))) }));
  expect(highTone.levels).not.toEqual(tone.levels.map(band => band.level));
  await page.getByRole('button', { name: 'Pause audio', exact: true }).click(); const paused = await page.evaluate(() => ({ reads: (window as any).audioStats.reads, time: (window as any).audio.currentTime })); await page.waitForTimeout(180);
  expect(await page.evaluate(() => (window as any).audioStats.reads)).toBe(paused.reads); expect(await page.evaluate(() => (window as any).audioStats.pendingFrames.size)).toBe(0); expect(await page.evaluate(() => (window as any).audio.currentTime)).toBeCloseTo(paused.time, 3);
  await page.getByRole('button', { name: 'Restart audio', exact: true }).click(); expect(await page.evaluate(() => (window as any).audio.currentTime)).toBe(0); await play.click(); await expect(page.getByRole('button', { name: 'Pause audio', exact: true })).toBeVisible(); await range.fill('7.7'); await expect.poll(() => page.evaluate(() => (window as any).audio.ended)).toBeTruthy(); await expect(play).toBeVisible();
  const endedReads = await page.evaluate(() => (window as any).audioStats.reads); await page.waitForTimeout(100); expect(await page.evaluate(() => (window as any).audioStats.reads)).toBe(endedReads);
  await play.click(); await expect.poll(() => page.evaluate(() => (window as any).audio.currentTime)).toBeGreaterThan(.1);
  expect(await page.evaluate(() => ({ contexts: (window as any).audioStats.contexts, sources: (window as any).audioStats.sources, sourceConnections: (window as any).audioStats.sourceConnections, analyserConnections: (window as any).audioStats.analyserConnections }))).toEqual({ contexts: 1, sources: 1, sourceConnections: 1, analyserConnections: 1 });
  await page.getByRole('button', { name: 'Expand audio player' }).click(); await page.waitForTimeout(500); await page.locator('.audio-canvas-player').screenshot({ path: info.outputPath('audio-spectrum-playing.png') });
  await page.getByRole('button', { name: 'Unmount fixture' }).click(); await expect.poll(() => page.evaluate(() => (window as any).audioStats.closes)).toBe(1); expect(await page.evaluate(() => (window as any).audioStats.disconnects)).toBe(2); expect(await page.evaluate(() => (window as any).audioStats.pendingFrames.size)).toBe(0);
  await writeFile(info.outputPath('audio-fft.json'), JSON.stringify({ tone, silence, highTone, paused, lifecycle: await page.evaluate(() => { const { pendingFrames, ...stats } = (window as any).audioStats; return { ...stats, pendingFrames: pendingFrames.size }; }) }, null, 2));
});

test('player morph uses actual bounds and native controls keep canvas gestures separate', async ({ page, playerUrl }, info) => {
  await page.goto(playerUrl); const player = page.locator('.audio-canvas-player'), range = page.getByRole('slider', { name: 'Audio timeline' }); await expect(page.getByRole('button', { name: 'Play audio' })).toBeEnabled();
  expect((await player.boundingBox())!.height).toBe(130); await expect(player.locator('.audio-player-clock')).toHaveCSS('opacity', '1'); await expect(player.locator('.audio-player-clock')).toHaveText('0:000:08'); await player.screenshot({ path: info.outputPath('audio-compact.png') });
  await range.focus(); await range.press('End'); expect(await page.evaluate(() => (window as any).audio.currentTime)).toBe(8); await range.press('Home'); await range.press('ArrowRight'); expect(await page.evaluate(() => (window as any).audio.currentTime)).toBeCloseTo(.1, 3);
  const rail = (await range.boundingBox())!; await page.mouse.move(rail.x + rail.width * .25, rail.y + rail.height / 2); await page.mouse.down(); await page.mouse.move(rail.x + rail.width * .65, rail.y + rail.height / 2, { steps: 3 }); await page.mouse.up(); expect(await page.evaluate(() => (window as any).audio.currentTime)).toBeGreaterThan(4.5); expect(await page.evaluate(() => (window as any).parentPointers)).toBe(0);
  await page.getByRole('button', { name: 'Expand audio player' }).click(); await expect(player).toHaveAttribute('data-expanded', 'true'); expect((await player.boundingBox())!.height).toBe(220); await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Use minimum width' }).click(); await page.getByRole('button', { name: 'Dark theme' }).click();
  const checks = await player.evaluate(element => { const bounds = element.getBoundingClientRect(); return Array.from(element.querySelectorAll('button,input,.audio-player-spectrum,.audio-player-clock')).map(control => { const box = control.getBoundingClientRect(); return { inside: box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom, width: box.width, height: box.height }; }); }); expect(checks.every(check => check.inside)).toBeTruthy(); await player.screenshot({ path: info.outputPath('audio-expanded-dark-280.png') });
  expect(await page.evaluate(() => (window as any).layoutWrites)).toBe(1); expect(await page.evaluate(() => (window as any).audioStats.contexts)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.getByRole('button', { name: 'Collapse audio player' }).click(); expect(await player.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s'); expect((await player.boundingBox())!.height).toBe(130);
  await expect(player.locator('.audio-player-clock')).toHaveCSS('opacity', '1'); await expect(player.locator('.audio-player-clock')).toHaveText('0:050:08'); expect(await player.locator('.audio-player-clock').evaluate(element => { const clock = element.getBoundingClientRect(), player = element.closest('.audio-canvas-player')!.getBoundingClientRect(); return clock.top >= player.top && clock.bottom <= player.bottom; })).toBeTruthy(); await player.screenshot({ path: info.outputPath('audio-compact-dark-280.png') });
  await player.locator('.audio-player-art').click(); expect(await page.evaluate(() => (window as any).parentPointers)).toBe(1);
});

test('undecodable audio preserves a usable original file download', async ({ page, playerUrl }) => {
  await page.goto(playerUrl); await page.getByRole('button', { name: 'Load invalid audio' }).click(); await expect(page.getByRole('status')).toHaveText('Audio could not be played.Download'); await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/invalid.wav'); await expect(page.getByRole('button', { name: 'Play audio' })).toBeDisabled(); expect(await page.evaluate(() => (window as any).audioStats.contexts)).toBe(0);
});
