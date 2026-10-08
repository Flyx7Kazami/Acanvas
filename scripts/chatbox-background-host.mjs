import assert from 'node:assert/strict';
import { writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

/** Test-host bridge injected into one Playwright-owned page. No production
 * webpage or Codex private IPC gains this capability. */
export async function runBackgroundCapture({ page, context, url, sessionId, call, token, directory }) {
  const serviceUrl = new URL(url).origin;
  const report = { route: 'trusted-test-host-background-same-Page', productHostIntegrated: false, tests: [], captures: [], transitions: [] };
  await page.evaluate(() => { const mark = document.querySelector('#laboratory-mark'); Object.assign(mark.style, { left: '120px', top: '100px', width: '1190px', height: '640px' }); });
  let hold, started, awaitedPhase = 'capture', scenario = 'normal', latestBinding, activeJob, lastJob;
  const finishStarted = (phase = 'capture') => { awaitedPhase = phase; return new Promise(accept => started = accept); };
  const release = () => { hold?.(); hold = undefined; };
  const api = async (path, method, body, raw = false, signal) => {
    const response = await fetch(`${serviceUrl}${path}`, { method, signal, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}), headers: { Authorization: `Bearer ${token}`, ...(raw ? { 'Content-Type': 'image/png' } : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.code || `http_${response.status}`);
    return result;
  };
  const state = () => call(`/api/state?sessionId=${sessionId}`);
  const capturePath = binding => `/api/sessions/${sessionId}/drafts/${binding.draftId}/annotations/${binding.annotationId}/captures/${binding.version}`;
  const phase = async (job, value) => {
    job.phase = value;
    job.timeline.push({ phase: value, at: new Date().toISOString() });
    if (awaitedPhase === value) { started?.(); started = undefined; }
    if (scenario === 'held' && value === 'capture' || scenario.endsWith('-after-prepare') && value === 'prepared' || scenario === 'cancel-during-upload' && value === 'uploading') await new Promise(accept => hold = accept);
    if (job.aborted) throw new Error(job.reason);
  };
  const invalidate = (job, reason) => {
    if (job.invalidation) return job.invalidation;
    job.aborted = true; job.reason = reason; job.controller.abort();
    job.invalidation = (async () => {
      let version;
      try { version = (await api(`${capturePath(job.binding)}/retry`, 'POST', {})).version; }
      catch (error) { if (!['capture_version_conflict', 'annotation_version_conflict', 'draft_conflict', 'annotation_missing'].includes(error.message)) throw error; version = (await state()).draft.annotations.find(value => value.id === job.binding.annotationId)?.captureState?.version; }
      report.transitions.push({ reason, phase: job.phase, previousVersion: job.binding.version, currentVersion: version, committedBeforeInvalidation: !!job.committed });
      if (JSON.stringify(latestBinding) === JSON.stringify(job.binding) && version) latestBinding = { ...job.binding, version };
      return { version };
    })();
    return job.invalidation;
  };
  const navigation = frame => {
    if (frame !== page.mainFrame() || !activeJob) return;
    const job = activeJob;
    void page.evaluate(() => window.backgroundLaboratory?.state.documentId).then(documentId => { if (documentId !== job.documentId) return invalidate(job, 'stale_navigation'); }).catch(() => invalidate(job, 'stale_navigation'));
  };
  page.on('framenavigated', navigation);
  await page.exposeBinding('laboratoryHostCancel', async (source, request) => {
    if (source.page !== page || source.frame !== page.mainFrame()) throw new Error('source_page_rejected');
    const job = activeJob;
    if (!job || job.documentId !== request.documentId || job.generation !== request.generation || JSON.stringify(job.binding) !== JSON.stringify(request.binding)) return {};
    return invalidate(job, request.reason || 'cancelled');
  });
  const freshAnnotation = async () => {
    const current = await state();
    const annotation = { id: crypto.randomUUID(), scope: 'region', objectIds: [], coordinateSpace: 'world', bounds: { x: 120, y: 100, width: 1190, height: 640 }, geometry: 'rect', text: 'Keep the visible composition and this marked connection.', captureState: { version: 1, status: 'incomplete' } };
    const draft = await call(`/api/sessions/${sessionId}/draft`, 'PUT', { ...current.draft, text: 'Review this marked composition.', annotations: [annotation] });
    latestBinding = { sessionId, draftId: draft.id, annotationId: annotation.id, version: 1 };
    return { draft, annotation: draft.annotations[0], binding: latestBinding };
  };
  const validate = async (request, job) => {
    if (job.aborted) throw new Error(job.reason);
    const currentUrl = page.isClosed() ? undefined : new URL(page.url()), expectedUrl = new URL(url);
    if (!currentUrl || currentUrl.origin !== expectedUrl.origin || currentUrl.pathname !== expectedUrl.pathname || currentUrl.searchParams.get('session') !== sessionId) throw new Error('stale_navigation');
    const current = await page.evaluate(() => window.backgroundLaboratory?.prepare());
    if (!current || current.documentId !== request.documentId || current.generation !== request.generation || current.status !== 'capturing') throw new Error('stale_generation');
    if (JSON.stringify(current.binding) !== JSON.stringify(request.binding)) throw new Error('stale_binding');
    if (JSON.stringify(current.viewport) !== JSON.stringify(request.viewport)) throw new Error('viewport_changed');
    const saved = await state(), annotation = saved.draft.annotations.find(value => value.id === request.binding.annotationId);
    if (saved.draft.id !== request.binding.draftId || annotation?.captureState?.version !== request.binding.version) throw new Error('annotation_version_conflict');
    return { current, saved, annotation };
  };
  await page.exposeBinding('laboratoryHostCapture', async (source, request) => {
    if (source.page !== page || source.frame !== page.mainFrame()) throw new Error('source_page_rejected');
    if (JSON.stringify(request.binding) !== JSON.stringify(latestBinding)) throw new Error('binding_rejected');
    const job = { binding: request.binding, documentId: request.documentId, generation: request.generation, phase: 'capture', timeline: [], controller: new AbortController(), aborted: false };
    activeJob = lastJob = job;
    try {
    await phase(job, 'capture');
    if (scenario === 'unavailable') throw new Error('capture_unavailable');
    const began = performance.now();
    let fresh = request, captured, verified;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const checked = await validate(fresh, job);
      const before = checked.current;
      const captureAt = performance.now();
      const data = (await page.screenshot({ fullPage: false })).toString('base64');
      const captureAndEncodeMs = performance.now() - captureAt;
      if (scenario === 'layout-always' || scenario === 'layout-once' && attempt === 1) await page.evaluate(() => document.querySelector('.markdown-content').scrollTop += 1);
      const after = await validate(fresh, job);
      if (before.layout !== after.current.layout) {
        if (attempt === 2 || performance.now() - began > 1500) throw new Error('layout_changed');
        fresh = after.current;
        continue;
      }
      captured = await cropSamePage(page, data, before);
      verified = await validate(fresh, job);
      if (verified.current.layout !== before.layout) {
        if (attempt === 2) throw new Error('layout_changed');
        fresh = verified.current;
        continue;
      }
      captured.captureAndEncodeMs = captureAndEncodeMs;
      captured.attempts = attempt;
      break;
    }
    if (!captured || !verified) throw new Error('capture_timeout');
    const png = Buffer.from(captured.base64, 'base64'); captured.bytes = png.length; delete captured.base64;
    assert.equal(png.readUInt32BE(16), captured.width); assert.equal(png.readUInt32BE(20), captured.height);
    const input = metadata(verified.saved, verified.annotation, fresh, captured);
    const path = capturePath(fresh.binding);
    const preparedAt = performance.now(), prepared = await api(path, 'POST', input, false, job.controller.signal), prepareMs = performance.now() - preparedAt;
    await phase(job, 'prepared');
    await validate(fresh, job);
    const uploadAt = performance.now();
    // The caller ignores the first upload's parsed result, then reconciles
    // through GET. Network response loss is covered by the service suite.
    let uploadBody = png;
    if (scenario === 'cancel-during-upload') {
      uploadBody = new ReadableStream({ async start(controller) {
        controller.enqueue(png.subarray(0, Math.floor(png.length / 2)));
        const temporaryDirectory = join(verified.saved.project.root, '.acanvas', 'tmp');
        let receivedBytes = 0;
        for (let attempt = 0; attempt < 100; attempt++) {
          const names = (await readdir(temporaryDirectory)).filter(name => name.startsWith(`${prepared.capture.id}.capture-upload`));
          for (const name of names) receivedBytes = Math.max(receivedBytes, (await stat(join(temporaryDirectory, name)).catch(() => ({ size: 0 }))).size);
          if (receivedBytes >= 30) break;
          await new Promise(accept => setTimeout(accept, 10));
        }
        assert(receivedBytes >= 30, 'Real partial upload reached the isolated service'); job.partialUploadBytes = receivedBytes;
        await phase(job, 'uploading');
        if (!job.aborted) { controller.enqueue(png.subarray(Math.floor(png.length / 2))); controller.close(); }
      } });
    } else await phase(job, 'uploading');
    await api(`${path}/content`, 'PUT', uploadBody, true, job.controller.signal); job.committed = true;
    await validate(fresh, job);
    const uploadMs = performance.now() - uploadAt, queryAt = performance.now();
    const result = await api(path, 'GET', undefined, false, job.controller.signal);
    const queryMs = performance.now() - queryAt, retryAt = performance.now();
    const retry = await api(`${path}/content`, 'PUT', png, true, job.controller.signal), retryMs = performance.now() - retryAt;
    assert.equal(result.status, 'committed'); assert.equal(retry.capture.screenshotAssetId, result.capture.screenshotAssetId); assert.equal(prepared.capture.screenshotAssetId, result.capture.screenshotAssetId);
    await validate(fresh, job);
    const bytesResponse = await fetch(`${serviceUrl}/api/assets/${result.capture.screenshotAssetId}/content?sessionId=${sessionId}`, { headers: { Authorization: `Bearer ${token}` } });
    assert(bytesResponse.ok); assert(png.equals(Buffer.from(await bytesResponse.arrayBuffer())));
    const filename = report.captures.length ? `background-capture-${report.captures.length}.png` : 'background-capture.png';
    await writeFile(join(directory, filename), png);
    await validate(fresh, job);
    const output = { status: 'complete', screenshotAssetId: result.capture.screenshotAssetId, captureId: result.capture.id, version: result.capture.version, filename, bytes: png.length, width: captured.width, height: captured.height, mapping: captured.mapping, attempts: captured.attempts, captureAndEncodeMs: captured.captureAndEncodeMs, imageDecodeMs: captured.imageDecodeMs, cropDrawMs: captured.cropDrawMs, cropEncodeMs: captured.cropEncodeMs, prepareMs, uploadMs, queryMs, retryMs, totalMs: performance.now() - began, committedIdentityPreserved: true, ignoredUploadResultReconciled: true };
    report.captures.push(output);
    return output;
    } catch (error) { const invalidated = await invalidate(job, error.message); return { status: 'incomplete', error: error.message, version: invalidated.version }; }
    finally { if (activeJob === job) activeJob = undefined; }
  });
  const install = async binding => {
    await page.evaluate(value => {
      const panel = document.querySelector('#capture-laboratory');
      panel.style.visibility = 'visible';
      document.querySelectorAll('[data-lab-editor]').forEach(element => element.style.visibility = 'visible');
      panel.innerHTML = '<strong>Capture laboratory</strong><p><button id="background-finish">Finish capture</button> <button id="background-cancel">Cancel capture</button></p><textarea id="background-comment" aria-label="Capture comment" rows="3" style="width:100%">Keep the visible composition and this marked connection.</textarea><output id="background-summary">Capture incomplete</output>';
      const documentId = crypto.randomUUID();
      const state = { documentId, binding: value, generation: 0, status: 'incomplete', error: '', attempts: 0 };
      const layout = () => JSON.stringify({ viewport: [innerWidth, innerHeight, devicePixelRatio], transform: document.querySelector('.canvas-world').style.transform, objects: [...document.querySelectorAll('.board-object')].map(element => [element.dataset.objectId, element.dataset.objectVersion, element.getBoundingClientRect().toJSON()]), markdown: document.querySelector('.markdown-content').scrollTop });
      const prepare = () => ({ documentId, generation: state.generation, status: state.status, binding: state.binding, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, transform: document.querySelector('.canvas-world').style.transform, rect: document.querySelector('#laboratory-mark').getBoundingClientRect().toJSON(), layout: layout(), objects: [...document.querySelectorAll('.board-object')].map(element => ({ id: element.dataset.objectId, kind: element.dataset.contentKind, rect: element.getBoundingClientRect().toJSON(), ...(element.querySelector('video,audio') ? { playbackTime: element.querySelector('video,audio').currentTime } : {}), ...(element.querySelector('.markdown-content') ? { scroll: { x: element.querySelector('.markdown-content').scrollLeft, y: element.querySelector('.markdown-content').scrollTop } } : {}) })) });
      const cancel = async () => {
        if (state.status !== 'capturing') return;
        const request = { documentId, generation: state.generation, binding: state.binding, reason: 'cancelled' };
        state.generation++; state.status = 'cancelling'; state.error = 'cancelled'; panel.style.visibility = 'visible'; document.querySelectorAll('[data-lab-editor]').forEach(element => element.style.visibility = 'visible');
        const invalidated = await window.laboratoryHostCancel(request);
        if (invalidated.version) state.binding = { ...state.binding, version: invalidated.version };
        state.status = 'incomplete'; panel.querySelector('output').textContent = 'Capture incomplete';
      };
      document.querySelector('#background-cancel').onclick = cancel;
      document.addEventListener('keydown', event => { if (event.key === 'Escape' && state.status === 'capturing') cancel(); });
      document.querySelector('#background-finish').onclick = async () => {
        const generation = ++state.generation;
        state.status = 'capturing'; state.error = ''; panel.style.visibility = 'hidden'; document.querySelectorAll('[data-lab-editor]').forEach(element => element.style.visibility = 'hidden');
        await new Promise(accept => requestAnimationFrame(() => requestAnimationFrame(accept)));
        try {
          let timer;
          const result = await Promise.race([window.laboratoryHostCapture(prepare()), new Promise((_, reject) => timer = setTimeout(() => reject(new Error('capture_timeout')), 2000))]).finally(() => clearTimeout(timer));
          if (state.generation !== generation) return;
          state.status = result.status; state.result = result;
          if (result.status === 'incomplete') { state.error = result.error; if (result.version) state.binding = { ...state.binding, version: result.version }; panel.querySelector('output').textContent = 'Capture incomplete · Retry'; }
          else panel.querySelector('output').textContent = `Capture saved · ${result.width} × ${result.height}`;
        } catch (error) {
          if (state.generation !== generation) return;
          const invalidated = await window.laboratoryHostCancel({ documentId, generation, binding: state.binding, reason: error.message });
          if (invalidated.version) state.binding = { ...state.binding, version: invalidated.version };
          state.status = 'incomplete'; state.error = error.message; panel.querySelector('output').textContent = 'Capture incomplete · Retry';
        }
        finally { if (state.generation === generation) { panel.style.visibility = 'visible'; document.querySelectorAll('[data-lab-editor]').forEach(element => element.style.visibility = 'visible'); } }
      };
      window.backgroundLaboratory = { state, prepare };
    }, binding);
  };
  const ui = () => page.evaluate(() => ({ ...window.backgroundLaboratory.state, text: document.querySelector('#background-comment').value }));
  const finish = async () => { await page.locator('#background-finish').click(); await page.waitForFunction(() => ['complete', 'incomplete'].includes(window.backgroundLaboratory.state.status)); return ui(); };
  let initial = await freshAnnotation();
  await install(initial.binding);
  const normal = await finish();
  assert.equal(normal.status, 'complete', JSON.stringify(normal));
  const committed = (await state()).draft;
  assert.equal(committed.annotations[0].captureState.status, 'complete');
  const { task } = await call(`/api/sessions/${sessionId}/tasks`, 'POST', { draftId: committed.id, expectedRevision: committed.revision });
  assert.equal(task.snapshot.annotations[0].capture.screenshotAssetId, normal.result.screenshotAssetId);
  assert.equal(task.snapshot.annotations[0].capture.scene.objects.length, 7);
  report.task = { id: task.id, sequence: task.sequence, annotationStatus: task.snapshot.annotations[0].captureState.status, screenshotAssetId: task.snapshot.annotations[0].capture.screenshotAssetId, sceneKinds: task.snapshot.annotations[0].capture.scene.assets.map(asset => asset.mime), sceneObjects: task.snapshot.annotations[0].capture.scene.objects.length };
  report.tests.push({ name: 'finish-to-background-capture-to-query-to-send', passed: true });
  for (const currentScenario of ['unavailable', 'resize', 'cancel', 'target-version', 'timeout', 'history', 'layout-once', 'layout-always', 'cancel-after-prepare', 'navigate-after-prepare', 'timeout-after-prepare', 'cancel-during-upload', 'navigate']) {
    initial = await freshAnnotation(); await install(initial.binding);
    scenario = ['resize', 'cancel', 'target-version', 'timeout', 'history', 'navigate'].includes(currentScenario) ? 'held' : currentScenario;
    let result;
    if (scenario === 'held' || currentScenario.endsWith('-after-prepare') || currentScenario === 'cancel-during-upload') {
      const began = finishStarted(currentScenario.endsWith('-after-prepare') ? 'prepared' : currentScenario === 'cancel-during-upload' ? 'uploading' : 'capture');
      await page.locator('#background-finish').click(); await began;
      if (currentScenario === 'resize') await page.setViewportSize({ width: 1280, height: 900 });
      if (currentScenario === 'history') await page.evaluate(() => history.replaceState(history.state, '', `${location.pathname}${location.search}#capture-history`));
      if (currentScenario.startsWith('cancel')) await page.keyboard.press('Escape');
      if (currentScenario === 'target-version') {
        const current = await state();
        const changed = await call(`/api/sessions/${sessionId}/draft`, 'PUT', { ...current.draft, annotations: current.draft.annotations.map(annotation => ({ ...annotation, bounds: { ...annotation.bounds, x: annotation.bounds.x + 10 } })) });
        await page.evaluate(binding => { window.backgroundLaboratory.state.binding = binding; window.backgroundLaboratory.state.generation++; window.backgroundLaboratory.state.status = 'incomplete'; }, { ...initial.binding, version: changed.annotations[0].captureState.version });
      }
      if (currentScenario.startsWith('navigate')) await page.reload();
      if (currentScenario.startsWith('timeout')) await page.waitForFunction(() => window.backgroundLaboratory.state.status === 'incomplete');
      release();
      if (lastJob?.invalidation) await lastJob.invalidation;
      if (currentScenario.startsWith('navigate')) {
        await page.waitForSelector('.board-object[data-content-kind="markdown"] h2');
        result = { status: 'incomplete', documentReplaced: await page.evaluate(() => !window.backgroundLaboratory), textPreserved: (await state()).draft.annotations[0].text === initial.annotation.text };
        // The next job owns a new document and a new experimental UI.
        await page.evaluate(() => {
          if (!document.querySelector('#laboratory-mark')) { const mark = document.createElement('div'); mark.id = 'laboratory-mark'; mark.style.cssText = 'position:absolute;left:120px;top:100px;width:1190px;height:640px;border:4px solid #ff6b00;z-index:900;pointer-events:none'; document.querySelector('.canvas-world').append(mark); }
          if (!document.querySelector('[data-lab-editor]')) { const editor = document.createElement('div'); editor.dataset.labEditor = 'true'; editor.style.cssText = 'position:fixed;left:430px;top:280px;width:300px;height:100px;background:#00ff00;z-index:999'; document.body.append(editor); }
        });
      } else {
        await page.waitForFunction(() => ['complete', 'incomplete'].includes(window.backgroundLaboratory.state.status));
        result = await ui();
      }
    } else result = await finish();
    const saved = (await state()).draft.annotations[0];
    const passed = currentScenario === 'layout-once' ? result.status === 'complete' && result.result.attempts === 2 : currentScenario === 'history' ? result.status === 'complete' && saved.captureState.status === 'complete' : result.status === 'incomplete' && saved.captureState.status === 'incomplete' && (result.text === initial.annotation.text || result.textPreserved === true);
    report.tests.push({ name: currentScenario, passed, uiStatus: result.status, persistedStatus: saved.captureState.status, error: result.error, generation: result.generation, version: saved.captureState.version, ...(lastJob.partialUploadBytes ? { actualPartialUploadBytes: lastJob.partialUploadBytes } : {}) });
    if (currentScenario === 'resize') await page.setViewportSize({ width: 1440, height: 1000 });
    scenario = 'normal';
  }
  await writeFile(join(directory, 'background-host-report.json'), JSON.stringify(report, null, 2) + '\n');
  assert(report.tests.every(test => test.passed), JSON.stringify(report.tests));
  page.off('framenavigated', navigation);
  return report;
}

async function cropSamePage(page, data, prepared) {
  return page.evaluate(async ({ source, prepared }) => {
    const decodeAt = performance.now(), image = new Image(); image.src = `data:image/png;base64,${source}`; await image.decode();
    const imageDecodeMs = performance.now() - decodeAt, sourceScaleX = image.naturalWidth / prepared.viewport.width, sourceScaleY = image.naturalHeight / prepared.viewport.height;
    if (Math.abs(sourceScaleX - sourceScaleY) > .01) throw new Error('surface_mapping_mismatch');
    const mark = prepared.rect, x = Math.max(0, Math.floor(mark.x - 32)), y = Math.max(0, Math.floor(mark.y - 32));
    const right = Math.min(prepared.viewport.width, Math.ceil(mark.right + 32)), bottom = Math.min(prepared.viewport.height, Math.ceil(mark.bottom + 32));
    const crop = { x, y, width: right - x, height: bottom - y }, scale = Math.min(1, 1024 / Math.max(crop.width * sourceScaleX, crop.height * sourceScaleY));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(crop.width * sourceScaleX * scale)); canvas.height = Math.max(1, Math.round(crop.height * sourceScaleY * scale));
    const drawAt = performance.now(); canvas.getContext('2d').drawImage(image, crop.x * sourceScaleX, crop.y * sourceScaleY, crop.width * sourceScaleX, crop.height * sourceScaleY, 0, 0, canvas.width, canvas.height);
    const cropDrawMs = performance.now() - drawAt, encodeAt = performance.now(), blob = await new Promise(accept => canvas.toBlob(accept, 'image/png')), cropEncodeMs = performance.now() - encodeAt;
    const context = canvas.getContext('2d'), sampleX = Math.round((mark.x - crop.x + 1) * canvas.width / crop.width), sampleY = Math.round((mark.y - crop.y + 1) * canvas.height / crop.height), markerPixel = [...context.getImageData(sampleX, sampleY, 1, 1).data];
    const editor = document.querySelector('[data-lab-editor]').getBoundingClientRect(), editorX = Math.round((editor.x + 10 - crop.x) * canvas.width / crop.width), editorY = Math.round((editor.y + 10 - crop.y) * canvas.height / crop.height), editorPixel = editorX >= 0 && editorY >= 0 && editorX < canvas.width && editorY < canvas.height ? [...context.getImageData(editorX, editorY, 1, 1).data] : null;
    if (markerPixel[0] !== 255 || markerPixel[1] !== 107 || markerPixel[2] !== 0) throw new Error('marker_pixels_missing');
    if (editorPixel?.[0] === 0 && editorPixel[1] === 255 && editorPixel[2] === 0) throw new Error('editor_pixels_visible');
    return { width: canvas.width, height: canvas.height, imageDecodeMs, cropDrawMs, cropEncodeMs, markerPixel, editorPixel, mapping: { crop, pixelWidth: canvas.width, pixelHeight: canvas.height, scaleX: canvas.width / crop.width, scaleY: canvas.height / crop.height }, base64: await new Promise(accept => { const reader = new FileReader(); reader.onload = () => accept(reader.result.split(',')[1]); reader.readAsDataURL(blob); }) };
  }, { source: data, prepared });
}

function metadata(saved, annotation, prepared, captured) {
  const match = prepared.transform.match(/translate\(([-+\d.e]+)px,\s*([-+\d.e]+)px\) scale\(([-+\d.e]+)\)/i);
  assert(match, 'Rendered world transform');
  const x = Number(match[1]), y = Number(match[2]), zoom = Number(match[3]);
  const target = Object.fromEntries(['scope', 'objectId', 'objectIds', 'assetId', 'bounds', 'coordinateSpace', 'timeStart', 'timeEnd', 'snapshotAssetId', 'geometry', 'contentAnchor'].filter(key => annotation[key] !== undefined).map(key => [key, annotation[key]]));
  const crop = captured.mapping.crop;
  const objects = prepared.objects.filter(value => value.rect.right > crop.x && value.rect.left < crop.x + crop.width && value.rect.bottom > crop.y && value.rect.top < crop.y + crop.height).map((value, layer) => {
    const object = saved.objects.find(object => object.id === value.id); assert(object);
    return { object, renderedBounds: { x: (value.rect.x - x) / zoom, y: (value.rect.y - y) / zoom, width: value.rect.width / zoom, height: value.rect.height / zoom }, layer, ...(value.playbackTime === undefined ? {} : { media: { playbackTime: value.playbackTime } }), ...(value.scroll ? { scroll: value.scroll } : {}) };
  });
  return { capturedAt: new Date().toISOString(), target, worldBounds: annotation.bounds, viewport: { x, y, zoom, ...prepared.viewport }, mapping: captured.mapping, scene: { objects, assets: saved.assets.filter(asset => objects.some(value => value.object.assetId === asset.id)), omittedCount: 0 }, image: { mime: 'image/png', width: captured.width, height: captured.height, bytes: captured.bytes } };
}
