import { cp, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { business, canonical, capture, distManifest, ownWorkspace, protectedWrite, sha256, summary } from './snapshot.mjs';
import { permittedRestart, preservedBusiness, reconcileOpened, requireRuntimeCleared, requireStablePosts } from './restart-contract.mjs';

const execFileAsync = promisify(execFile);
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  if (!process.argv[index]?.startsWith('--') || !process.argv[index + 1]) throw new Error('Use explicit --name VALUE options.');
  options.set(process.argv[index].slice(2), process.argv[index + 1]);
}
for (const key of options.keys()) if (!['project', 'candidate', 'build-sha256', 'evidence', 'execute-approved', 'stopped-task-json'].includes(key)) throw new Error('Unknown deployment option.');
const required = key => { if (!options.get(key)) throw new Error(`--${key} is required.`); return options.get(key); };
const project = await realpath(required('project'));
const candidate = await realpath(required('candidate'));
const approvedBuildSha256 = required('build-sha256');
if (!/^[a-f0-9]{64}$/.test(approvedBuildSha256)) throw new Error('Select the exact approved build manifest hash.');
const evidence = resolve(required('evidence'));
const evidenceRoot = join(project, 'docs/evidence/codex-runtime-delivery/deployment');
if (!evidence.startsWith(`${evidenceRoot}/`)) throw new Error('Deployment summaries must stay in the designated evidence directory.');
await mkdir(evidence, { recursive: false });
const workspace = await ownWorkspace(project);
let configuredAuthorization = null;
if (options.has('stopped-task-json')) {
  const path = options.get('stopped-task-json');
  if (!isAbsolute(path)) throw new Error('Use an absolute protected stopped-task authorization file.');
  const info = await lstat(path), parentInfo = await lstat(dirname(path));
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || !parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.mode & 0o077) throw new Error('Stopped-task authorization must use an owned protected file/directory.');
  const owner = JSON.parse(await readFile(join(dirname(path), 'deployment-owner.json'), 'utf8'));
  if (owner.kind !== 'acanvas-formal-deployment' || owner.project !== project) throw new Error('The stopped-task authorization directory belongs to another project.');
  configuredAuthorization = JSON.parse(await readFile(path, 'utf8'));
}
const candidateOwner = JSON.parse(await readFile(join(candidate, 'candidate-owner.json'), 'utf8'));
if (candidateOwner.kind !== 'acanvas-host-delivery-candidate' || candidateOwner.output !== candidate || candidateOwner.source !== project) throw new Error('Use the owned validation candidate for this project.');
const builtManifest = JSON.parse(await readFile(join(candidate, 'build-manifest.json'), 'utf8'));
if (builtManifest.owner !== candidateOwner.owner) throw new Error('The candidate build ownership differs from its validation record.');
const candidateDist = join(candidate, 'dist');
const selectedDist = await distManifest(candidateDist);
const recordedDist = builtManifest.files.map(({ path, ...entry }) => {
  if (!path.startsWith('dist/')) throw new Error('The validation manifest contains an unexpected build path.');
  return { path: path.slice(5), ...entry };
});
if (canonical(recordedDist) !== canonical(selectedDist) || sha256(selectedDist) !== approvedBuildSha256) throw new Error('The candidate bytes differ from the exact approved build.');
const currentDist = join(project, 'dist');
const { readRuntime } = await import(pathToFileURL(join(currentDist, 'src/server/runtime.js')).href);
const before = await capture(project, currentDist, { port: 4317, projectId: 'c3e8d1a5-3b11-4bb8-b63f-b3f4d25e48fd' });
await protectedWrite(join(workspace, 'before.json'), before);
const beforeSummary = summary(before);
const authorization = permittedRestart(before, configuredAuthorization);
const saveEvidence = async (name, value) => writeFile(join(evidence, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
await saveEvidence('before-summary.json', beforeSummary);
const quiescent = Object.values(beforeSummary.quiescence).every(value => value === 0);
const plan = { createdAt: new Date().toISOString(), executeApproved: options.get('execute-approved') === 'GO', candidateBuildSha256: approvedBuildSha256, candidateDistFiles: selectedDist.length, quiescent, stoppedTaskException: authorization ? { identitySha256: sha256(authorization), basis: 'The user explicitly confirmed the original execution stopped and authorized restart, as relayed by the parent agent.', expectedTransition: 'Only the identified task/run become interrupted with the normal restart reason/time and its session consumer becomes null; all other public business fields and bytes remain exact.' } : null, originalDistSha256: sha256(before.dist), backup: 'Original served dist retained in an owned protected deployment directory; no original runtime data is copied.', actions: ['Fresh public API and all asset byte hashes; require zero activity, or only the explicitly authorized exact stopped-task identity; always require zero edits.', 'Normal project stop using the served CLI; explicitly verify readRuntime is empty.', 'Move the original dist into owned rollback storage, copy the exact validated candidate dist, and verify its manifest.', 'Normal project open with an explicit existing session, original port/network/preview configuration, and cleaned automatic binding environment.', 'Restore only previously owned managed browser sessions; do not open ordinary user pages or attach host runtimes.', 'Compare every original public business field and asset byte hash twice, allowing only the explicit stopped-task normal restart transition; verify the frozen build manifest, static HTTP resources, service health, and host status for every existing session.', 'On failure, reconcile fresh runtime identity, normally stop only the known current service, and restore/reopen the owned original dist only after runtime is empty; retain all evidence.'] };
await saveEvidence('plan.json', plan);
if (options.get('execute-approved') !== 'GO') {
  console.log(JSON.stringify({ workspace, evidence, status: 'prepared-only', plan, before: beforeSummary }));
  process.exit(0);
}
if (!quiescent && !authorization) throw new Error('Formal deployment blocked: an unauthorized active consumer, running task/run, or edit exists. The service was not stopped.');
if (!before.sessions.length) throw new Error('Formal deployment needs an explicit original session; the service was not stopped.');
if (before.browser.running && !before.browser.pages.length) throw new Error('The original managed browser has no restorable session page; inspect it before stopping.');
const localPreviews = before.network.loopbackPreviewOrigins.filter(origin => {
  const url = new URL(origin);
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
});
if (localPreviews.length !== 1) throw new Error('The original loopback preview port is ambiguous; the service was not stopped.');
const previewPort = Number(new URL(localPreviews[0]).port);
if (!Number.isSafeInteger(previewPort) || previewPort <= 0) throw new Error('The original preview port is invalid; the service was not stopped.');
const runtimeNode = join(project, '.runtime/node_modules/node/bin/node');
const env = { ...process.env, PATH: `${join(project, '.runtime/node_modules/node/bin')}:${process.env.PATH ?? ''}` };
delete env.CODEX_THREAD_ID;
for (const key of Object.keys(env)) if (key.startsWith('ACANVAS_')) delete env[key];
const cli = async (args, label) => {
  try {
    const result = await execFileAsync(runtimeNode, [join(project, 'dist/src/cli.js'), ...args, '--project', project], { cwd: project, env, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  } catch { throw new Error(`The normal CLI ${label} failed; inspect only public status and retained deployment evidence.`); }
};
const openArgs = ['project', 'open', '--session', before.sessions[0].id, '--port', String(new URL(before.network.url).port), '--bind', before.network.bind, '--preview-port', String(previewPort), ...(before.network.allowedHosts.length ? ['--allow-host', before.network.allowedHosts.join(',')] : []), ...(before.network.previewOrigins.length ? ['--preview-host', before.network.previewOrigins.join(',')] : [])];
const originalDist = join(workspace, 'original-dist');
let stopped = false, stopAttempted = false, originalMoved = false, installed = false, success = false, openedIdentity = null, openResponseReconciled = false;
let restartNotBefore = null;
const phases = [];
const phase = async name => { phases.push({ phase: name, at: new Date().toISOString() }); await protectedWrite(join(workspace, `phase-${phases.length}.json`), phases[phases.length - 1]); };
try {
  // Repeat a complete snapshot directly before the first mutation.
  const immediatelyBefore = await capture(project, currentDist, { port: 4317, projectId: before.bootstrap.project.id, instanceId: before.bootstrap.service.instanceId, pid: before.bootstrap.service.pid });
  const immediatelyAuthorized = permittedRestart(immediatelyBefore, configuredAuthorization);
  if (canonical(business(immediatelyBefore)) !== canonical(business(before)) || canonical(immediatelyAuthorized) !== canonical(authorization) || canonical(immediatelyBefore.network) !== canonical(before.network) || canonical(immediatelyBefore.browser) !== canonical(before.browser)) throw new Error('The formal baseline changed before stopping; the service was not stopped.');
  await protectedWrite(join(workspace, 'immediately-before.json'), immediatelyBefore);
  restartNotBefore = new Date().toISOString();
  stopAttempted = true;
  const stop = await cli(['project', 'stop'], 'stop');
  if (stop.status !== 'stopped') throw new Error('Normal project stop did not confirm completion.');
  requireRuntimeCleared(await readRuntime(project));
  stopped = true;
  await phase('normal-stop-completed');
  if (canonical(await distManifest(currentDist)) !== canonical(before.dist)) throw new Error('The old served dist changed before installation.');
  requireRuntimeCleared(await readRuntime(project));
  await rename(currentDist, originalDist);
  originalMoved = true;
  await phase('old-dist-retained');
  await cp(candidateDist, currentDist, { recursive: true, force: false, errorOnExist: true, dereference: false });
  installed = true;
  if (canonical(await distManifest(currentDist)) !== canonical(selectedDist)) throw new Error('Installed dist does not match the validated candidate.');
  await phase('exact-candidate-installed');
  let opened;
  try { opened = await cli(openArgs, 'open'); }
  catch {
    const recovered = await capture(project, currentDist, { port: 4317, projectId: before.bootstrap.project.id });
    opened = reconcileOpened(before, recovered, selectedDist, authorization, restartNotBefore, join(project, 'dist/src/server/main.js'));
    await protectedWrite(join(workspace, 'open-response-reconciliation.json'), recovered);
    openResponseReconciled = true;
  }
  openedIdentity = opened.service;
  stopped = false;
  if (opened.project.id !== before.bootstrap.project.id || opened.sessionId !== before.sessions[0].id || opened.service.instanceId === before.bootstrap.service.instanceId) throw new Error('Reopened service or session identity is invalid.');
  await protectedWrite(join(workspace, 'opened.json'), opened);
  for (const page of before.browser.pages) await cli(['browser', 'open', '--session', page.sessionId], 'browser open');
  await phase('original-context-reopened');
  const hostStatuses = [];
  for (const session of before.sessions) {
    const result = await cli(['host', 'status', '--session', session.id], 'host status');
    if (result.projectId !== before.bootstrap.project.id || result.sessionId !== session.id || result.attachment !== null || result.summary.mode !== 'queue' || result.summary.connection !== 'none') throw new Error('An original session has an unexpected runtime attachment.');
    hostStatuses.push(result);
  }
  await protectedWrite(join(workspace, 'host-statuses.json'), hostStatuses);
  let firstPostSnapshot = null;
  const compare = async (name) => {
    const after = await capture(project, currentDist, { port: 4317, projectId: before.bootstrap.project.id, instanceId: opened.service.instanceId, pid: opened.service.pid });
    await protectedWrite(join(workspace, `${name}.json`), after);
    const result = summary(after);
    await saveEvidence(`${name}-summary.json`, result);
    if (canonical(after.dist) !== canonical(selectedDist)) throw new Error('The served dist changed from the frozen validated candidate during post-deployment verification.');
    if (!preservedBusiness(before, after, authorization, restartNotBefore)) throw new Error('Original public business fields or asset bytes changed outside the explicit authorized restart transition.');
    if (firstPostSnapshot) requireStablePosts(firstPostSnapshot, after);
    else firstPostSnapshot = after;
    if (canonical(after.network) !== canonical(before.network)) throw new Error('The original network or preview configuration changed.');
    const logicalPages = value => value.pages.map(page => ({ sessionId: page.sessionId, url: page.url })).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    if (after.browser.running !== before.browser.running || canonical(logicalPages(after.browser)) !== canonical(logicalPages(before.browser))) throw new Error('The original owned browser contexts changed.');
    if (!Object.values(result.quiescence).every(value => value === 0)) throw new Error('A consumer, task, run or edit became active during deployment verification.');
    return result;
  };
  const afterOne = await compare('after-1');
  const afterTwo = await compare('after-2');
  await phase('two-comparisons-passed');
  const result = { status: 'updated', candidateBuildSha256: approvedBuildSha256, deployedDistSha256: afterTwo.dist.sha256, actualHttpResourcesSha256: afterTwo.httpResources.sha256, projectId: afterTwo.projectId, serviceBefore: beforeSummary.service, serviceAfter: afterTwo.service, openResponseReconciled, originalBusinessFieldsPreservedTwice: true, authorizedStoppedTaskTransitionVerifiedTwice: !!authorization, stoppedTaskException: plan.stoppedTaskException, allOriginalAssetBytesEqualTwice: true, originalNetworkAndPreviewEqualTwice: true, originalOwnedBrowserContextsEqualTwice: true, hostStatusesRead: hostStatuses.length, hostAttachments: 0, scopeCountUnchanged: afterTwo.sessions === beforeSummary.sessions, queuedTasksUnchanged: afterTwo.taskStatuses.queued === beforeSummary.taskStatuses.queued, before: beforeSummary, after: [afterOne, afterTwo], phases };
  await saveEvidence('result.json', result);
  success = true;
  console.log(JSON.stringify({ workspace, evidence, result }));
} catch (failure) {
  let rollback = 'not-needed';
  if (originalMoved) {
    try {
      // A failed open may already have launched a service, so never rely solely on
      // the launcher result to decide whether it is safe to replace served files.
      const liveRuntime = await readRuntime(project);
      if (liveRuntime) {
        if (!openedIdentity || liveRuntime.instanceId !== openedIdentity.instanceId || liveRuntime.pid !== openedIdentity.pid) throw new Error('An unconfirmed runtime appeared during deployment; retain the dist for review.');
        let stop;
        try { stop = await cli(['project', 'stop'], 'rollback stop'); }
        catch (error) { if (await readRuntime(project)) throw error; }
        if (stop && stop.status !== 'stopped') throw new Error('Rollback stop did not confirm completion.');
      }
      requireRuntimeCleared(await readRuntime(project));
      stopped = true;
      // Preserve a partial or failed new installation; never remove unidentified files.
      try { await lstat(currentDist); requireRuntimeCleared(await readRuntime(project)); await rename(currentDist, join(workspace, 'failed-candidate-dist')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      requireRuntimeCleared(await readRuntime(project));
      await rename(originalDist, currentDist);
      originalMoved = false;
      if (canonical(await distManifest(currentDist)) !== canonical(before.dist)) throw new Error('The restored original dist differs from its retained manifest.');
      await cli(openArgs, 'rollback open'); stopped = false;
      for (const page of before.browser.pages) await cli(['browser', 'open', '--session', page.sessionId], 'rollback browser open');
      const restored = await capture(project, currentDist, { port: 4317, projectId: before.bootstrap.project.id });
      if (canonical(restored.dist) !== canonical(before.dist)) throw new Error('The restored served dist changed from the retained original manifest.');
      await protectedWrite(join(workspace, 'rollback.json'), restored);
      await saveEvidence('rollback-summary.json', summary(restored));
      rollback = preservedBusiness(before, restored, authorization, restartNotBefore) ? 'original-dist-and-business-restored' : 'original-dist-restored-business-requires-review';
    } catch { rollback = 'failed-requires-public-status-review'; }
  } else if (stopAttempted) {
    try {
      const liveRuntime = await readRuntime(project);
      if (liveRuntime) rollback = liveRuntime.instanceId === before.bootstrap.service.instanceId && liveRuntime.pid === before.bootstrap.service.pid ? 'original-service-still-running' : 'another-runtime-retained-no-dist-change';
      else { await cli(openArgs, 'original reopen'); stopped = false; rollback = 'original-service-reopened-after-stop-reconciliation'; }
    } catch { rollback = 'original-service-reconciliation-failed'; }
  }
  const result = { status: 'blocked-or-rolled-back', message: failure instanceof Error ? failure.message : 'Deployment failed.', rollback, originalMoved, installed, stopped, phases };
  await saveEvidence('result.json', result);
  console.log(JSON.stringify({ workspace, evidence, result }));
  process.exitCode = 1;
} finally {
  if (!success) await protectedWrite(join(workspace, 'retained-for-review.json'), { originalMoved, installed, stopped, at: new Date().toISOString() });
}
