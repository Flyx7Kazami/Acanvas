import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gifFixture } from './fixtures/universal-media/gif-fixture.js';
const execute = promisify(execFile);

function tone(): Buffer {
  const rate = 44100, frames = rate * 8, data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++) data.writeInt16LE(Math.round(Math.sin(frame * 2 * Math.PI * 220 / rate) * 12000), 44 + frame * 2);
  return data;
}
async function numberedVideo(output: string) {
  for (let frame = 0; frame < 20; frame++) {
    const pixels = Buffer.alloc(160 * 120 * 3, 30);
    for (let bit = 0; bit < 5; bit++) for (let y = 10; y < 30; y++) for (let x = 10 + bit * 27; x < 30 + bit * 27; x++) { const offset = (y * 160 + x) * 3; pixels.fill(frame & 1 << bit ? 245 : 5, offset, offset + 3); }
    await writeFile(join(output, `frame${String(frame).padStart(3, '0')}.ppm`), Buffer.concat([Buffer.from('P6\n160 120\n255\n'), pixels]));
  }
  await execute('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-framerate', '10', '-i', join(output, 'frame%03d.ppm'), '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'baseline', '-crf', '18', '-pix_fmt', 'yuv420p', join(output, 'numbered.mp4')]);
  return readFile(join(output, 'numbered.mp4'));
}
const documentText = `# Layout and selection\n\nA paragraph with **bold**, *italic*, \`inline code\`, [a useful link](https://example.com), 中文 and an emoji 🌊.\n\n- First item\n  - Nested item with **format**\n- Second item\n\n> A quoted thought.\n\n| Name | Meaning |\n| --- | --- |\n| Frame | The displayed pixels |\n| Source | Saved evidence |\n\n![Reference](https://example.com/image.png)\n\n\`\`\`js\nconst frame = 17;\n\`\`\`\n\n${Array.from({ length: 25 }, (_, index) => `Paragraph ${index}: wrap text, preserve the viewport and keep selection available.\n`).join('\n')}`;

test('actual media textures preserve GIF frames, observed video timestamps, audible audio and Markdown layout across browsers', { skip: process.env.ACANVAS_MEDIA_TESTS !== '1', timeout: 180_000 }, async t => {
  const { createServer } = await import('vite'), { chromium, firefox, webkit } = await import('playwright-core');
  const output = await mkdtemp(join(tmpdir(), 'acanvas-media-run-')); await mkdir(output, { recursive: true });
  const video = await numberedVideo(output), sound = tone(), gif = Buffer.from(gifFixture({ repeat: 0 })), cover = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP438HwH4QZGNL+/wdhAFaqCdWXkbmzAAAAAElFTkSuQmCC', 'base64');
  const server = await createServer({ configFile: false, appType: 'mpa', root: `${process.cwd()}/app`, esbuild: { jsx: 'automatic' }, plugins: [{ name: 'controlled-media-fixtures', configureServer(server) { server.middlewares.use((request, response, next) => {
    const path = request.url?.split('?')[0], entry = path === '/lab/audio/content' ? { bytes: sound, type: 'audio/wav' } : path === '/lab/audio/artwork' ? { bytes: cover, type: 'image/png' } : path === '/lab/reference.gif' ? { bytes: gif, type: 'image/gif' } : path === '/lab/video.mp4' ? { bytes: video, type: 'video/mp4' } : path === '/lab/document.md' ? { bytes: Buffer.from(documentText), type: 'text/markdown' } : undefined;
    if (!entry) return next();
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/), start = range ? Number(range[1]) : 0, end = range && range[2] ? Math.min(entry.bytes.length - 1, Number(range[2])) : entry.bytes.length - 1;
    response.writeHead(range ? 206 : 200, { 'Content-Type': entry.type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${entry.bytes.length}` } : {}) }); response.end(request.method === 'HEAD' ? undefined : entry.bytes.subarray(start, end + 1));
  }); } }], optimizeDeps: { entries: ['tests/fixtures/universal-media/index.html'] }, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.runtime/**'] } }, logLevel: 'error' });
  await server.listen(); t.after(async () => { await server.close(); });
  const measurements: unknown[] = [], url = `${server.resolvedUrls!.local[0]}tests/fixtures/universal-media/index.html`;
  const engines = (process.env.ACANVAS_MEDIA_ENGINES ?? 'chromium,firefox').split(',');
  for (const engine of engines) {
    const browser = engine === 'chromium' ? await chromium.launch({ channel: 'chrome', headless: true }) : engine === 'firefox' ? await firefox.launch({ executablePath: process.env.ACANVAS_MEDIA_FIREFOX ?? '/private/tmp/acanvas-scene-browser-runtime/firefox-1490/firefox/Nightly.app/Contents/MacOS/firefox', headless: true }) : await webkit.launch({ executablePath: process.env.ACANVAS_MEDIA_WEBKIT, headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 800, height: 650 }, deviceScaleFactor: 2 }); await context.tracing.start({ snapshots: true, screenshots: true });
    const page = await context.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const call = <R>(method: string, ...args: unknown[]): Promise<R> => page.evaluate(({ method, args }) => (window as any).mediaLab[method](...args), { method, args });
    const decode = (image: number[]) => page.evaluate(async value => { const blob = new Blob([new Uint8Array(value)], { type: 'image/png' }), url = URL.createObjectURL(blob); try { const image = new Image(); image.src = url; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d')!.drawImage(image, 0, 0); return [...canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data]; } finally { URL.revokeObjectURL(url); } }, image);
    try {
      await page.goto(url); await page.waitForFunction(() => !!(window as any).mediaLab?.metadata()?.media, undefined, { timeout: 10000 }).catch(async cause => { throw new Error(`Media startup: ${JSON.stringify({ errors, body: await page.locator('body').innerText() })}`, { cause }); });
      await page.getByRole('button', { name: 'Play audio', exact: true }).waitFor(); await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.audio-player-play')!.disabled, undefined, { timeout: 10000 }).catch(async cause => { throw new Error(`Audio readiness: ${JSON.stringify(await page.evaluate(() => { const audio = document.querySelector('audio')!; return { src: audio.currentSrc, state: audio.readyState, duration: audio.duration, error: audio.error?.message, errors: document.querySelector('.audio-player-error')?.textContent }; }))}`, { cause }); });
      await call('armSound'); await page.getByRole('button', { name: 'Play audio', exact: true }).click();
      await page.waitForFunction(() => (window as any).mediaLab.metadata()?.media?.playbackTime > .25);
      await page.waitForFunction(() => { const probe = (window as any).soundProbe; if (!probe) return false; const samples = new Float32Array(2048); probe.analyser.getFloatTimeDomainData(samples); return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) > .01; }, undefined, { timeout: 10000 }).catch(async cause => { throw new Error(`Audio signal: ${JSON.stringify(await page.evaluate(() => ({ state: (window as any).soundProbe?.audio.state, contextTime: (window as any).soundProbe?.audio.currentTime, mediaTime: document.querySelector('audio')?.currentTime, paused: document.querySelector('audio')?.paused, muted: document.querySelector('audio')?.muted })))}`, { cause }); });
      const pcm = await call<number[]>('pcm'), rms = Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length); assert.ok(rms > .01);
      const audio: any = await call('capture'); assert.deepEqual(await decode(audio.png), audio.rgba); assert.equal(audio.metadata.media.timePrecision, 'playback-sampled');
      await writeFile(join(output, `${engine}-audio.png`), Buffer.from(audio.png));
      await page.getByRole('button', { name: 'Pause audio', exact: true }).click();
      await call('resize', 224, 280); await page.waitForFunction(() => (window as any).mediaLab.metadata()?.cssSize?.width === 224);
      const compact: any = await call('capture'); assert.equal(compact.metadata.cssSize.height, 280); assert.deepEqual(await decode(compact.png), compact.rgba);
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await page.waitForTimeout(50);
      const darkAudio: any = await call('capture'), corner = ((compact.height - 32) * compact.width + compact.width - 32) * 4; assert.notDeepEqual(darkAudio.rgba.slice(corner, corner + 3), compact.rgba.slice(corner, corner + 3));
      await call('set', 'markdown', 420, 280); await page.waitForFunction(() => (window as any).mediaLab.metadata()?.textRuns?.some((run: any) => run.text.includes('paragraph')));
      const markdown: any = await call('capture'); assert.deepEqual(await decode(markdown.png), markdown.rgba);
      const runCheck = await page.evaluate(() => { const body = document.querySelector('.markdown-body')!, metadata = (window as any).mediaLab.metadata(), text = body.textContent!; return metadata.textRuns.every((run: any) => text.slice(run.start, run.end) === run.text && run.bounds.width > 0 && run.bounds.height > 0); }); assert.equal(runCheck, true);
      await page.evaluate(() => { const text = document.querySelector('.markdown-body p')!.firstChild!, range = document.createRange(); range.setStart(text, 2); range.setEnd(text, 10); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); }); await page.waitForTimeout(60);
      const selected: any = await call('capture'); assert.notDeepEqual(selected.rgba, markdown.rgba);
      const quote = await page.evaluate(() => getSelection()!.toString()); assert.equal(quote, 'paragrap');
      await page.evaluate(() => { document.querySelector('.markdown-content')!.scrollTop = 220; }); await page.waitForFunction(() => (window as any).mediaLab.metadata()?.scroll?.y === 220);
      const scrolled: any = await call('capture'); assert.deepEqual(await decode(scrolled.png), scrolled.rgba); assert.notDeepEqual(scrolled.rgba, selected.rgba);
      await call('resize', 224, 280); await page.waitForFunction(() => (window as any).mediaLab.metadata()?.cssSize?.width === 224);
      const narrowMarkdown: any = await call('capture'); assert.equal(narrowMarkdown.width, 448); await writeFile(join(output, `${engine}-markdown.png`), Buffer.from(narrowMarkdown.png));
      await page.evaluate(() => { document.body.style.zoom = '1.25'; (document.querySelector('.tile') as HTMLElement).style.transform = 'scale(.8)'; });
      await page.evaluate(() => document.dispatchEvent(new Event('selectionchange'))); await page.waitForTimeout(80);
      const scaled: any = await call('capture'); assert.equal(scaled.metadata.cssSize.width, 224); assert.equal(scaled.metadata.bitmap.width, narrowMarkdown.metadata.bitmap.width);
      const scaleAligned = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>('.content-shell')!, body = document.querySelector('.markdown-body')!, area = root.getBoundingClientRect(), sx = area.width / root.clientWidth, sy = area.height / root.clientHeight;
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT), nodes: { node: Node; start: number; end: number }[] = []; let offset = 0, node: Node | null;
        while ((node = walker.nextNode())) { nodes.push({ node, start: offset, end: offset + (node.textContent?.length ?? 0) }); offset += node.textContent?.length ?? 0; }
        return (window as any).mediaLab.metadata().textRuns.every((run: any) => { const entry = nodes.find(value => value.start <= run.start && value.end >= run.end); if (!entry) return false; const range = document.createRange(); range.setStart(entry.node, run.start - entry.start); range.setEnd(entry.node, run.end - entry.start); const rect = range.getBoundingClientRect(), bounds = { x: (rect.x - area.x) / sx, y: (rect.y - area.y) / sy, width: rect.width / sx, height: rect.height / sy }; return ['x', 'y', 'width', 'height'].every(key => Math.abs(run.bounds[key] - bounds[key as keyof typeof bounds]) < 1.5); });
      }); assert.equal(scaleAligned, true);
      await page.evaluate(() => { document.body.style.zoom = ''; (document.querySelector('.tile') as HTMLElement).style.transform = ''; });
      await call('set', 'gif', 96, 96); await page.waitForFunction(() => (window as any).mediaLab.metadata()?.media?.frameIndex === 1);
      const frozenGIF: any = await call('capture'); assert.ok(frozenGIF.metadata.media.frameIndex > 0); assert.equal(frozenGIF.metadata.media.timePrecision, 'decoded-pts'); assert.deepEqual(await decode(frozenGIF.png), frozenGIF.rgba);
      const gifIndex = frozenGIF.metadata.media.frameIndex, first = (16 * frozenGIF.width + 16) * 4, final = (160 * frozenGIF.width + 160) * 4;
      const expectedFirst = gifIndex === 1 ? [20, 210, 70] : [240, 20, 40]; assert.deepEqual(frozenGIF.rgba.slice(first, first + 3), expectedFirst);
      if (gifIndex === 2) assert.deepEqual(frozenGIF.rgba.slice(final, final + 3), [30, 70, 235]);
      await page.waitForTimeout(550); const laterGIF: any = await call('capture'); assert.ok(laterGIF.metadata.media.playbackTime > frozenGIF.metadata.media.playbackTime); assert.deepEqual(await decode(frozenGIF.png), frozenGIF.rgba);
      await writeFile(join(output, `${engine}-gif.png`), Buffer.from(frozenGIF.png));
      await call('set', 'video', 320, 240); await page.waitForFunction(() => document.querySelector('video')!.readyState >= 2, undefined, { timeout: 10000 }).catch(async cause => { throw new Error(`Video readiness: ${JSON.stringify(await page.evaluate(() => { const video = document.querySelector('video')!; return { state: video.readyState, network: video.networkState, duration: video.duration, error: video.error?.message, src: video.currentSrc }; }))}`, { cause }); });
      await page.evaluate(() => { const video = document.querySelector('video')!; video.currentTime = .7; }); await page.waitForFunction(() => Math.abs((window as any).mediaLab.metadata()?.media?.presentedTime - .7) < .12, undefined, { timeout: 10000 }).catch(async cause => { throw new Error(`Video seek: ${JSON.stringify(await page.evaluate(() => { const video = document.querySelector('video')!; return { currentTime: video.currentTime, readyState: video.readyState, seeking: video.seeking, sourceTime: video.dataset.presentedTime, metadata: (window as any).mediaLab.metadata(), error: video.error?.message }; }))}`, { cause }); });
      const videoFrame: any = await call('capture'), timestamp = videoFrame.metadata.media.presentedTime, expected = Math.round(timestamp * 10); let actual = 0;
      for (let bit = 0; bit < 5; bit++) { const x = (20 + bit * 27) * 4, y = 20 * 4, offset = (y * videoFrame.width + x) * 4; if (videoFrame.rgba[offset] > 128) actual |= 1 << bit; }
      assert.equal(actual, expected); assert.deepEqual(await decode(videoFrame.png), videoFrame.rgba); assert.ok(['rvfc-observed', 'playback-sampled'].includes(videoFrame.metadata.media.timePrecision));
      await page.evaluate(() => document.querySelector('video')!.play()); await page.waitForFunction(() => (window as any).mediaLab.metadata()?.media?.presentedTime > 1.2);
      const playing: any = await call('capture'); assert.ok(playing.metadata.media.presentedTime > timestamp); assert.deepEqual(await decode(videoFrame.png), videoFrame.rgba); await writeFile(join(output, `${engine}-video.png`), Buffer.from(videoFrame.png));
      assert.deepEqual(errors, []);
      measurements.push({ engine, version: browser.version(), dpr: 2, audio: { rms, presentedTime: audio.metadata.media.presentedTime, narrow: compact.metadata.cssSize }, markdown: { sourceRunsMatchDOMOffsets: runCheck, quote, scroll: scrolled.metadata.scroll, narrowBitmap: [narrowMarkdown.width, narrowMarkdown.height], cssScaleLogicalRunsAligned: true }, gif: { savedFrameIndex: frozenGIF.metadata.media.frameIndex, savedTime: frozenGIF.metadata.media.playbackTime, laterTime: laterGIF.metadata.media.playbackTime, knownFramePixelMatched: true }, video: { savedTime: timestamp, timePrecision: videoFrame.metadata.media.timePrecision, knownFrameNumber: actual, expectedFrameNumber: expected, laterTime: playing.metadata.media.presentedTime }, pixelComparisons: 'PNG channels equal synchronously copied displayed Canvas channels', errors });
      if (process.env.ACANVAS_MEDIA_FACTS) await writeFile(resolve(process.env.ACANVAS_MEDIA_FACTS), JSON.stringify({ generatedAt: new Date().toISOString(), stage: 'P2 media producer implementation', result: 'partial', output, measurements }, null, 2));
    } finally { await context.tracing.stop({ path: join(output, `${engine}-trace.zip`) }); await context.close(); await browser.close(); }
  }
  const facts = { generatedAt: new Date().toISOString(), stage: 'P2 media producer implementation', node: process.version, result: 'passed', output, measurements, limits: { gif: '20 MiB compressed, four million pixels, 10000 compressed frame descriptors, current plus disposal restore RGBA, 16 decode steps per tick; zero delay becomes 20ms' }, pending: ['actual embedded browser integration acceptance', 'production Scene/App complete acceptance', 'native codec availability per browser'] };
  await writeFile(join(output, 'media-execution.json'), JSON.stringify(facts, null, 2));
  if (process.env.ACANVAS_MEDIA_FACTS) await writeFile(resolve(process.env.ACANVAS_MEDIA_FACTS), JSON.stringify(facts, null, 2));
});

test('video source binds immediate seeks, playback loops and source replacement to current decoder callbacks', { skip: process.env.ACANVAS_VIDEO_TESTS !== '1', timeout: 120_000 }, async t => {
  const { createServer } = await import('vite'), { chromium, firefox, webkit } = await import('playwright-core');
  const output = await mkdtemp(join(tmpdir(), 'acanvas-video-seek-run-')), bytes = await numberedVideo(output);
  const server = await createServer({ configFile: false, appType: 'mpa', root: `${process.cwd()}/app`, esbuild: { jsx: 'automatic' }, plugins: [{ name: 'numbered-video-fixture', configureServer(server) { server.middlewares.use((request, response, next) => {
    if (request.url?.split('?')[0] !== '/lab/video.mp4') return next(); const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/), start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(bytes.length - 1, Number(range[2])) : bytes.length - 1;
    response.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) }); response.end(bytes.subarray(start, end + 1));
  }); } }], optimizeDeps: { entries: ['tests/fixtures/universal-media/index.html'] }, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.runtime/**'] } }, logLevel: 'error' });
  await server.listen(); t.after(() => server.close());
  const engine = process.env.ACANVAS_VIDEO_ENGINE ?? 'webkit', browser = engine === 'chromium' ? await chromium.launch({ channel: 'chrome', headless: true }) : engine === 'firefox' ? await firefox.launch({ executablePath: '/private/tmp/acanvas-scene-browser-runtime/firefox-1490/firefox/Nightly.app/Contents/MacOS/firefox', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close()); const context = await browser.newContext({ viewport: { width: 800, height: 650 } }); await context.tracing.start({ snapshots: true, screenshots: true });
  const page = await context.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); const outcomes: unknown[] = [];
  const url = `${server.resolvedUrls!.local[0]}tests/fixtures/universal-media/index.html?kind=video`;
  const seek = async (time: number) => {
    await page.evaluate(value => { document.querySelector('video')!.currentTime = value; }, time);
    await page.waitForFunction(value => { const video = document.querySelector('video')!, media = (window as any).mediaLab?.metadata()?.media; return !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - value) < .001 && media && Math.abs(media.presentedTime - value) < .001; }, time, { timeout: 10000 });
    const result = await capture(); assert.equal(result.number, Math.round(time * 10)); assert.equal(result.metadata.media.presentedTime, time); return result;
  };
  const capture = async () => {
    const data: any = await page.evaluate(() => (window as any).mediaLab.capture()); let number = 0; const scale = data.width / 160;
    for (let bit = 0; bit < 5; bit++) { const offset = (Math.floor(20 * scale) * data.width + Math.floor((20 + bit * 27) * scale)) * 4; if (data.rgba[offset] > 128) number |= 1 << bit; }
    const decoded = await page.evaluate(async png => { const url = URL.createObjectURL(new Blob([new Uint8Array(png)], { type: 'image/png' })); try { const image = new Image(); image.src = url; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d')!.drawImage(image, 0, 0); return [...canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data]; } finally { URL.revokeObjectURL(url); } }, data.png);
    assert.deepEqual(decoded, data.rgba); return { number, metadata: data.metadata, png: data.png };
  };
  try {
    for (let iteration = 0; iteration < 5; iteration++) {
      await page.goto(`${url}&iteration=${iteration}`); await page.waitForFunction(() => document.querySelector('video')!.readyState >= 2);
      // This seek is the original failure trigger; no grace delay follows decoded readiness.
      const result = await seek(.7); outcomes.push({ iteration, stage: 'immediate ready seek', number: result.number, media: result.metadata.media });
    }
    for (const time of [.2, 1.5, .1, 1.1]) { const result = await seek(time); outcomes.push({ stage: 'forward/back seek', number: result.number, media: result.metadata.media }); }
    await page.evaluate(() => document.querySelector('video')!.play()); await page.waitForFunction(() => (window as any).mediaLab.metadata()?.media?.presentedTime > 1.2);
    const playing = await capture(); assert.equal(playing.metadata.media.timePrecision, 'rvfc-observed'); assert.equal(playing.number, Math.round(playing.metadata.media.presentedTime * 10));
    await page.evaluate(() => document.querySelector('video')!.pause()); await page.waitForFunction(() => document.querySelector('video')!.paused && (window as any).mediaLab.metadata()?.media?.timePrecision === 'playback-sampled');
    const paused = await capture(); assert.ok(Math.abs(paused.number / 10 - paused.metadata.media.presentedTime) < .11); outcomes.push({ stage: 'paused', number: paused.number, media: paused.metadata.media });
    await seek(1.9); await page.evaluate(() => { const video = document.querySelector('video')!; video.loop = true; void video.play(); });
    await page.waitForFunction(() => document.querySelector('video')!.currentTime < .4 && (window as any).mediaLab.metadata()?.media?.presentedTime < .4);
    const looped = await capture(); assert.ok(Math.abs(looped.number / 10 - looped.metadata.media.presentedTime) < .11); outcomes.push({ stage: 'native loop', number: looped.number, media: looped.metadata.media });
    await page.evaluate(() => { document.querySelector('video')!.pause(); (window as any).mediaLab.videoSource('/lab/video.mp4?replacement=1'); });
    await page.waitForFunction(() => document.querySelector('video')!.currentSrc.includes('replacement=1') && document.querySelector('video')!.readyState >= 2 && (window as any).mediaLab.metadata()?.media?.presentedTime === 0);
    const replaced = await seek(.3); outcomes.push({ stage: 'replaced source', number: replaced.number, media: replaced.metadata.media });
    // Retain an actual initial decoder callback, then deliver it after the new seek generation.
    await page.addInitScript(() => {
      const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
      (window as any).delayedInitialFrames = [];
      (window as any).delayedInitialTimes = []; let retained = false;
      HTMLVideoElement.prototype.requestVideoFrameCallback = function(callback) { return original.call(this, (now, metadata) => { if (!retained) { retained = true; (window as any).delayedInitialTimes.push(metadata.mediaTime); (window as any).delayedInitialFrames.push(() => callback(now, metadata)); } else callback(now, metadata); }); };
    });
    await page.goto(`${url}&late-callback=1`); await page.waitForFunction(() => document.querySelector('video')!.readyState >= 2); await page.evaluate(() => document.querySelector('video')!.play()); await page.waitForFunction(() => (window as any).delayedInitialFrames.length > 0);
    await page.evaluate(() => document.querySelector('video')!.pause());
    await seek(.7);
    const delivered = await page.evaluate(() => { const pending = (window as any).delayedInitialFrames.splice(0); pending.forEach((callback: () => void) => callback()); return { count: pending.length, times: (window as any).delayedInitialTimes, sourceTime: document.querySelector('video')!.dataset.presentedTime }; });
    assert.ok(delivered.count > 0); assert.equal(Number(delivered.sourceTime), .7);
    await page.evaluate(() => new Promise(requestAnimationFrame)); const retained = await capture(); assert.equal(retained.number, 7); assert.equal(retained.metadata.media.presentedTime, .7);
    outcomes.push({ stage: 'real initial RVFC delivered after seek', rejectedOldCallbacks: delivered.count, originalCallbackTimes: delivered.times, number: retained.number, media: retained.metadata.media });
    assert.deepEqual(errors, []); await writeFile(join(output, 'last-frame.png'), Buffer.from(replaced.png));
    const facts = { generatedAt: new Date().toISOString(), engine, browserVersion: browser.version(), result: 'passed', source: 'actual native video element and numbered H264 baseline frames', noReadinessGraceDelay: true, outcomes, output, errors };
    await writeFile(join(output, 'video-seek-execution.json'), JSON.stringify(facts, null, 2)); if (process.env.ACANVAS_VIDEO_FACTS) await writeFile(resolve(process.env.ACANVAS_VIDEO_FACTS), JSON.stringify(facts, null, 2));
  } finally { await context.tracing.stop({ path: join(output, 'trace.zip') }); await context.close(); await browser.close(); }
});
