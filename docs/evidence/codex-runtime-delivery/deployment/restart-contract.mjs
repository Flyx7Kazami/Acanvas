import { business, canonical, summary } from './snapshot.mjs';

export const restartReason = 'The local service restarted. Review saved progress and external jobs before resuming.';
const findTask = (snapshot, id) => snapshot.states.flatMap(state => state.tasks).find(task => task.id === id);
export function requireRuntimeCleared(runtime) {
  if (runtime !== undefined && runtime !== null) throw new Error('A runtime instance remains or replaced the stopped service; retain the served dist and inspect public status.');
}
export function permittedRestart(snapshot, authorization) {
  const q = summary(snapshot).quiescence;
  if (Object.values(q).every(value => value === 0)) return null;
  if (!authorization || authorization.version !== 1 || authorization.userConfirmedExecutionStopped !== true || authorization.userAuthorizedRestart !== true || authorization.source !== 'parent-confirmed-user-message') throw new Error('A non-quiescent restart requires explicit user confirmation and an exact stopped-task identity.');
  if (authorization.projectRoot !== snapshot.bootstrap.project.root || authorization.projectId !== snapshot.bootstrap.project.id || authorization.instanceId !== snapshot.bootstrap.service.instanceId || authorization.pid !== snapshot.bootstrap.service.pid) throw new Error('Stopped-task authorization belongs to another formal project or service instance.');
  if (q.activeConsumers !== 1 || q.runningTasks !== 1 || q.runningRuns !== 1 || q.editingTasks || q.editingDrafts) throw new Error('Only the single confirmed stopped execution may remain active.');
  const session = snapshot.sessions.find(value => value.id === authorization.sessionId);
  const task = findTask(snapshot, authorization.taskId);
  const run = task?.runs.find(value => value.id === authorization.runId);
  if (!session || session.consumerId !== authorization.consumerId || !task || task.sessionId !== session.id || task.sequence !== authorization.sequence || task.status !== 'running' || task.currentRunId !== authorization.runId || task.receipt !== null || !run || run.taskId !== task.id || run.consumerId !== authorization.consumerId || run.status !== 'running') throw new Error('The public session/task/run/consumer identity differs from the confirmed stopped execution.');
  return { ...authorization };
}
export function preservedBusiness(before, after, authorization, restartNotBefore) {
  if (!authorization) return canonical(business(before)) === canonical(business(after));
  const originalTask = findTask(before, authorization.taskId), originalRun = originalTask.runs.find(run => run.id === authorization.runId);
  const afterTask = findTask(after, authorization.taskId), afterRun = afterTask?.runs.find(run => run.id === authorization.runId);
  const isRestartTime = value => Number.isFinite(Date.parse(value)) && Date.parse(value) >= Date.parse(restartNotBefore) && Date.parse(value) <= Date.parse(after.capturedAt);
  if (!afterTask || afterTask.status !== 'interrupted' || afterTask.reason !== restartReason || !afterRun || afterRun.status !== 'interrupted' || afterTask.updatedAt !== afterRun.updatedAt || !isRestartTime(afterTask.updatedAt) || !isRestartTime(afterRun.updatedAt)) return false;
  const normalized = structuredClone(business(after));
  const normalizeSession = session => {
    if (session.id !== authorization.sessionId) return;
    if (session.consumerId !== null) throw new Error('The confirmed stopped execution did not release its session consumer on normal restart.');
    session.consumerId = authorization.consumerId;
  };
  normalized.sessions.forEach(normalizeSession);
  for (const state of normalized.states) {
    state.sessions.forEach(normalizeSession); normalizeSession(state.session);
    for (const task of state.tasks) if (task.id === authorization.taskId) {
      task.status = originalTask.status; task.reason = originalTask.reason; task.updatedAt = originalTask.updatedAt;
      const run = task.runs.find(value => value.id === authorization.runId);
      run.status = originalRun.status; run.updatedAt = originalRun.updatedAt;
    }
  }
  return canonical(business(before)) === canonical(normalized);
}
export function reconcileOpened(before, after, selectedDist, authorization, restartNotBefore, installedMain) {
  if (after.bootstrap.service.instanceId === before.bootstrap.service.instanceId || after.bootstrap.project.id !== before.bootstrap.project.id || !after.processArgs.includes(installedMain) || !after.processArgs.includes(`--project ${before.bootstrap.project.root}`) || canonical(after.dist) !== canonical(selectedDist) || canonical(after.network) !== canonical(before.network) || !Object.values(summary(after).quiescence).every(value => value === 0) || !preservedBusiness(before, after, authorization, restartNotBefore)) throw new Error('The uncertain open did not match this installed service entry, frozen build, original context and expected business state; retain the runtime for review.');
  return { project: after.bootstrap.project, service: after.bootstrap.service, capabilities: after.bootstrap.capabilities, sessionId: before.sessions[0].id };
}
export function requireStablePosts(first, second) {
  if (canonical(business(first)) !== canonical(business(second))) throw new Error('Original public business fields changed between the two post-deployment snapshots.');
}
