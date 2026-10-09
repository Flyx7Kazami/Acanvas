import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const directory = new URL('.', import.meta.url).pathname;
const names = ['baseline-r1', 'baseline-loading-r2', 'candidate-r1', 'candidate-loading-r2'];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, epsilon = 0.01) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon;
const quantiles = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? { count: sorted.length, p50: sorted[Math.floor((sorted.length - 1) * .5)], p95: sorted[Math.ceil((sorted.length - 1) * .95)], max: sorted.at(-1) } : { count: 0 };
};
const matches = (expected, actual) => ['x', 'y', 'zoom'].every(key => near(expected.camera[key], actual.camera[key])) && (!expected.objectId || actual.objects.some(object => object.id === expected.objectId && near(object.x, expected.x) && near(object.y, expected.y)));
const documents = {};
const audits = {};

for (const name of names) {
  const document = JSON.parse(gunzipSync(await readFile(join(directory, `final-${name}.json.gz`))));
  documents[name] = document;
  const failures = [];
  const check = (condition, kind, detail) => { if (!condition) failures.push({ kind, detail }); };
  const detail = document.detail;
  const inputs = new Map(detail.inputs.map(input => [input.id, input]));
  const covered = new Set();
  const commits = new Map(detail.commits.map(commit => [`${commit.phase}:${commit.frameSeq}:${commit.at}`, commit]));
  const commitsByPhase = new Map(document.phases.map(phase => [phase.name, detail.commits.filter(commit => commit.phase === phase.name)]));
  const html = document.objects.filter(object => object.kind === 'html');
  const nativeAtCommit = new Map();
  const latest = new Map();
  let publication = 0;
  for (const commit of detail.commits) {
    while (publication < detail.publishes.length && detail.publishes[publication].at <= commit.at) {
      const item = detail.publishes[publication++]; latest.set(item.objectId, item);
    }
    nativeAtCommit.set(commit, html.every(object => {
      const surface = commit.surfaces.find(item => item.objectId === object.id)?.surface;
      return !!surface && surface.frameSeq >= 1 && equal(surface, latest.get(object.id)?.surface);
    }));
  }
  for (const pair of detail.pairs) {
    const input = inputs.get(pair.inputId);
    check(!!input && pair.phase === input.phase && pair.inputAt === input.at && equal(pair.expected, input.expected), 'pair-input', pair.inputId);
    check(!covered.has(pair.inputId), 'duplicate-covered-input', pair.inputId); covered.add(pair.inputId);
    check(pair.commitAt >= pair.inputAt && matches(pair.expected, pair.actual), 'pair-native-expected-geometry', pair.inputId);
    const commit = commits.get(`${pair.phase}:${pair.frameSeq}:${pair.commitAt}`);
    check(!!commit && equal(pair.actual, { camera: commit.camera, objects: commit.objects, surfaces: commit.surfaces, media: commit.media }), 'pair-successful-frame', pair.inputId);
    check(!!commit && nativeAtCommit.get(commit), 'pair-three-current-native-surfaces', pair.inputId);
    const earliest = commitsByPhase.get(pair.phase)?.find(item => item.at >= pair.inputAt && matches(pair.expected, item));
    check(earliest?.frameSeq === pair.frameSeq && earliest?.at === pair.commitAt, 'pair-first-matching-commit', pair.inputId);
  }
  for (const item of detail.superseded) {
    const input = inputs.get(item.id);
    check(!!input && input.at === item.at && input.phase === item.phase && equal(input.expected, item.expected), 'superseded-input', item.id);
    check(!covered.has(item.id), 'duplicate-covered-input', item.id); covered.add(item.id);
    const commit = commits.get(`${item.phase}:${item.frameSeq}:${item.supersededAt}`);
    const later = detail.pairs.some(pair => pair.phase === item.phase && pair.frameSeq === item.frameSeq && pair.commitAt === item.supersededAt && pair.inputAt >= item.at);
    check(!!commit && item.supersededAt >= item.at && later && !matches(item.expected, commit), 'superseded-by-later-matching-input', item.id);
  }
  check(inputs.size === detail.inputs.length && covered.size === inputs.size && [...inputs.keys()].every(id => covered.has(id)), 'complete-unique-input-coverage', { inputs: inputs.size, covered: covered.size });
  const phases = [];
  for (const phase of document.phases.filter(phase => phase.inputs > 0)) {
    const events = detail.inputs.filter(input => input.phase === phase.name);
    const pairs = detail.pairs.filter(pair => pair.phase === phase.name);
    const superseded = detail.superseded.filter(item => item.phase === phase.name);
    const recomputed = quantiles(pairs.map(pair => pair.commitAt - pair.inputAt));
    const terminal = events.at(-1);
    check(events.length === phase.inputs && pairs.length === phase.latency.count && superseded.length === phase.superseded && pairs.length + superseded.length === events.length && phase.pending === 0, 'phase-coverage', phase.name);
    check(equal(recomputed, phase.latency) && equal(pairs.map(pair => pair.commitAt - pair.inputAt), phase.committed), 'phase-quantiles', phase.name);
    check(pairs.length > 0 && !!terminal && pairs.some(pair => pair.inputId === terminal.id), 'terminal-input-matched', phase.name);
    check(events.every(input => input.at >= phase.bounds.begin && input.at <= phase.bounds.end) && pairs.every(pair => pair.commitAt <= phase.bounds.end), 'phase-bounds', phase.name);
    check(html.every(object => phase.publishCounts.find(item => item.id === object.id)?.count > 0), 'phase-html-active', phase.name);
    phases.push({ name: phase.name, physicalMedia: phase.activePhysicalMedia, inputs: events.length, matched: pairs.length, superseded: superseded.length, pending: phase.pending, terminalInputId: terminal?.id, terminalMatched: !!terminal && pairs.some(pair => pair.inputId === terminal.id), latency: recomputed, elapsed: phase.elapsed });
  }
  const playback = [];
  const video = document.objects.find(object => object.kind === 'video');
  for (const phase of document.phases.filter(phase => phase.name.includes('-playing-'))) {
    const active = phase.mediaState.filter(media => !media.paused);
    check(active.length === 1, 'single-playback', phase.name);
    const rms = phase.audioRms.map(summary => {
      const samples = detail.audioSamples.filter(sample => sample.phase === phase.name && sample.objectId === summary.objectId);
      const values = samples.map(sample => sample.rms);
      const actual = { objectId: summary.objectId, samples: values.length, nonzero: values.filter(value => value > .0001).length, max: values.length ? Math.max(...values) : 0 };
      check(equal(actual, summary), 'raw-audio-rms', phase.name + ':' + summary.objectId);
      return actual;
    });
    const callbacks = detail.videoFrames.filter(frame => frame.phase === phase.name);
    check(callbacks.length === phase.videoObserved, 'raw-video-callback-count', phase.name);
    check(equal(callbacks.length ? [callbacks[0].mediaTime, callbacks.at(-1).mediaTime] : [], phase.videoPTS), 'raw-video-pts', phase.name);
    const publications = detail.publishes.filter(item => item.phase === phase.name && item.objectId === video.id);
    const observed = publications.filter(item => item.media?.timePrecision === 'rvfc-observed');
    check(publications.every(item => item.bitmap.width === 1920 && item.bitmap.height === 1080), 'video-source-dimensions', phase.name);
    check(observed.every(item => callbacks.some(frame => frame.at <= item.at && near(frame.mediaTime, item.media.presentedTime, .000001))), 'published-native-video-pts', phase.name);
    if (phase.name.startsWith('audio')) check(rms.filter(item => item.nonzero > 0).length === 1 && rms.find(item => item.objectId === active[0]?.objectId)?.nonzero > 0, 'active-audio-real-signal', phase.name);
    else check(active[0]?.objectId === video.id && callbacks.length > 0, 'active-video-real-frames', phase.name);
    const before = phase.mediaBefore.find(item => item.objectId === video.id), after = phase.mediaState.find(item => item.objectId === video.id);
    playback.push({ name: phase.name, activePhysicalMedia: phase.activePhysicalMedia, rms, rvfcCallbacks: callbacks.length, rvfcPublications: observed.length, sourceBitmap: publications[0]?.bitmap, decodedFrames: after.videoFrames - before.videoFrames, boundedSeconds: (phase.bounds.end - phase.bounds.begin) / 1000, decodedFPS: (after.videoFrames - before.videoFrames) / ((phase.bounds.end - phase.bounds.begin) / 1000), pts: phase.videoPTS });
  }
  const loading = {};
  for (const key of ['cold', 'warm', 'cacheWarm']) {
    const stage = document[key], images = document.objects.filter(object => object.kind === 'image');
    const first = images.map(object => stage.publishes.find(item => item.objectId === object.id));
    const authoritative = html.map(object => stage.publishes.find(item => item.objectId === object.id && item.surface?.frameSeq >= 1));
    loading[key] = {
      firstImagePublishedAt: Math.min(...first.map(item => item.at)),
      allImagesPublishedAt: Math.max(...first.map(item => item.at)),
      allImagesVisibleCommitAt: stage.commits.find(commit => images.every(object => commit.contentIds.includes(object.id)))?.at,
      firstImageConstructorWorkMs: first.sort((a, b) => a.at - b.at)[0].work.milliseconds,
      allImageConstructorWorkMs: first.reduce((sum, item) => sum + item.work.milliseconds, 0),
      htmlPreparingPublishAt: html.map(object => stage.publishes.find(item => item.objectId === object.id)?.at),
      htmlAuthoritativePublishAt: authoritative.map(item => item.at),
      allAuthoritativeHTMLVisibleCommitAt: stage.commits.find(commit => html.every(object => commit.surfaces.find(item => item.objectId === object.id)?.surface?.frameSeq >= 1))?.at,
      waveforms: stage.waveforms,
      audioPlayable: stage.audioPlayable,
      assetHTTPPolicy: 'private,no-store; the third navigation clears only the session waveform envelope',
    };
  }
  audits[name] = { status: failures.length ? 'FAIL' : 'PASS', archive: `final-${name}.json.gz`, buildRoot: document.buildRoot, fixtures: document.fixtures, browser: document.browser, dpr: document.dpr, objectBounds: document.objects.map(object => ({ id: object.id, kind: object.kind, x: object.x, y: object.y, width: object.width, height: object.height })), counts: { inputPhases: phases.length, inputs: detail.inputs.length, matched: detail.pairs.length, superseded: detail.superseded.length, covered: covered.size }, phases, playback, loading, errors: document.errors, failures };
  console.log(JSON.stringify({ name, status: audits[name].status, counts: audits[name].counts, failures: failures.slice(0, 8) }));
}

const baseline = audits['baseline-r1'], candidate = audits['candidate-r1'];
const comparisons = candidate.phases.map(phase => {
  const original = baseline.phases.find(item => item.name === phase.name);
  return { phase: phase.name, physicalMedia: phase.physicalMedia, baselineP95: original.latency.p95, candidateP95: phase.latency.p95, baselineMatched: original.matched, candidateMatched: phase.matched, baselineSuperseded: original.superseded, candidateSuperseded: phase.superseded, baselineElapsed: original.elapsed, candidateElapsed: phase.elapsed };
});
const report = {
  status: Object.values(audits).every(audit => audit.status === 'PASS') ? 'PASS' : 'FAIL',
  methodology: 'Raw gzip documents were independently unpacked. Each native input was uniquely covered by the first successful matching camera/object commit or a later committed input that superseded it. Every matched pair was checked against its actual frameSeq/time/geometry/media/surface records and all three latest native surface publications. Quantile definition is floor((n-1)*.5) and ceil((n-1)*.95). Loading-only repeats intentionally contain zero gesture inputs and are not playback/input trials.',
  equivalentSetup: { sameObjectIdsKindsBounds: equal(baseline.objectBounds, candidate.objectBounds), sameFixtures: baseline.fixtures === candidate.fixtures, sameBrowser: baseline.browser === candidate.browser, sameDPR: baseline.dpr === candidate.dpr },
  audits,
  comparisons,
  limits: [
    'Latency ends at successful main-thread visible Canvas commit, before OS compositor output.',
    'One full 21-input-phase run per version contains two pan/drag/zoom repetitions for each physical medium. Separate process repeats cover loading only.',
    'Audio and video follow the product singlePlayback rule; no simultaneous audio-plus-video playback claim.',
    'Historical CPU versus GPU pixels differ in ordinary antialiasing and image filtering; same-GPU uncached pixel equivalence and original-CPU-helper equivalence were independently checked separately.',
    'Actual user audio/video codec, duration and decoded dimensions were not read. Synthetic full-file audio is 256/320s, video is 1920x1080/30fps/12s. MP4 padding matches file bytes rather than decoder work or actual Range transfer equivalence.',
    'Native HTML warm/cache-cleared startup tail variation remains visible in loading records; a general all-loading improvement is not claimed.',
    'F2 native programmatic root smooth-scroll semantic/pixel pairing remains a documented limitation outside these non-scroll performance phases.',
  ],
};
await writeFile(join(directory, 'reviewer-final-raw-audit.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, equivalentSetup: report.equivalentSetup, p95Comparisons: comparisons.map(item => ({ phase: item.phase, baseline: item.baselineP95, candidate: item.candidateP95 })) }));
