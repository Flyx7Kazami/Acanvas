import { readRuntime } from '../../../../dist/src/server/runtime.js';

const project = '/Users/yingbowu/Documents/Projects/acanvas';
const runtime = await readRuntime(project);
if (!runtime || runtime.project.id !== 'c3e8d1a5-3b11-4bb8-b63f-b3f4d25e48fd' || runtime.url !== 'http://127.0.0.1:4317') throw new Error('The original formal service identity is unavailable.');
const response = await fetch(new URL('/api/bootstrap', runtime.url), { signal: AbortSignal.timeout(5000) });
if (!response.ok) throw new Error('Formal bootstrap read failed.');
const bootstrap = await response.json();
if (bootstrap.project.root !== project || bootstrap.project.id !== runtime.project.id || bootstrap.service.pid !== runtime.pid || bootstrap.service.instanceId !== runtime.instanceId) throw new Error('Formal runtime identity changed.');
const read = async path => {
  const result = await fetch(new URL(path, runtime.url), { headers: { Authorization: `Bearer ${bootstrap.token}` }, signal: AbortSignal.timeout(10000) });
  if (!result.ok) throw new Error('Formal public status read failed.');
  return result.json();
};
const sessions = await read('/api/sessions'), states = [];
for (const session of sessions) states.push(await read(`/api/state?sessionId=${encodeURIComponent(session.id)}`));
const tasks = states.flatMap(state => state.tasks), runningTasks = tasks.filter(task => task.status === 'running'), runningRuns = tasks.flatMap(task => task.runs).filter(run => run.status === 'running');
const time = Date.now();
const recent = values => values.map(value => value.updatedAt).sort().at(-1) ?? null;
const taskUpdatedAt = recent(runningTasks), runUpdatedAt = recent(runningRuns);
console.log(JSON.stringify({ capturedAt: new Date(time).toISOString(), service: bootstrap.service, sessions: sessions.length, tasks: tasks.length, queued: tasks.filter(task => task.status === 'queued').length, cancelled: tasks.filter(task => task.status === 'cancelled').length, activeConsumers: sessions.filter(session => session.consumerId !== null).length, runningTasks: runningTasks.length, runningRuns: runningRuns.length, editingTasks: tasks.filter(task => task.status === 'editing').length, editingDrafts: states.filter(state => !!state.draft.editingTaskId).length, mostRecentRunningTaskUpdatedAt: taskUpdatedAt, runningTaskAgeSeconds: taskUpdatedAt ? Math.round((time - Date.parse(taskUpdatedAt)) / 1000) : null, mostRecentRunningRunUpdatedAt: runUpdatedAt, runningRunAgeSeconds: runUpdatedAt ? Math.round((time - Date.parse(runUpdatedAt)) / 1000) : null }));
