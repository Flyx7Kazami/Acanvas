import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskStatus } from '../shared/types';

const queueStatuses: readonly TaskStatus[] = ['queued', 'editing', 'running', 'blocked', 'interrupted'];
const queueStatusSet = new Set<TaskStatus>(queueStatuses);
const doneExitDuration = 1400;

type ExitingTask = { task: Task; fromStatus: TaskStatus };
export type QueueTask = { task: Task; exiting: boolean; fromStatus?: TaskStatus };

type UseTaskQueueOptions = {
  onBeforeRemove?: () => void;
};

const isQueueStatus = (status: TaskStatus) => queueStatusSet.has(status);
const completedTransitions = (tasks: Task[], previousTasks: Map<string, Task> | undefined) => {
  const transitioned = new Map<string, ExitingTask>();
  if (!previousTasks) return transitioned;
  for (const task of tasks) {
    const previous = previousTasks.get(task.id);
    if (task.status === 'completed' && previous && isQueueStatus(previous.status)) {
      transitioned.set(task.id, { task: { ...previous, status: 'completed', updatedAt: task.updatedAt, receipt: null }, fromStatus: previous.status });
    }
  }
  return transitioned;
};

/**
 * Keeps a task that was already visible in the queue around for its completion
 * animation. A completed task received on the first load or after switching
 * sessions never enters this temporary display state.
 */
export function useTaskQueue(tasks: Task[], sessionId: string | undefined, options: UseTaskQueueOptions = {}) {
  const currentSession = sessionId || '';
  const sessionRef = useRef('');
  const previousTasksRef = useRef<Map<string, Task> | undefined>(undefined);
  const timersRef = useRef(new Map<string, number>());
  const [exitingTasks, setExitingTasks] = useState<Map<string, ExitingTask>>(() => new Map());
  const [layoutRevision, setLayoutRevision] = useState(0);

  const transitionedTasks = sessionRef.current === currentSession && !matchMedia('(prefers-reduced-motion: reduce)').matches
    ? completedTransitions(tasks, previousTasksRef.current)
    : new Map<string, ExitingTask>();

  const clearTimer = (taskId: string) => {
    const timer = timersRef.current.get(taskId);
    if (timer !== undefined) window.clearTimeout(timer);
    timersRef.current.delete(taskId);
  };

  useLayoutEffect(() => {
    const sessionChanged = sessionRef.current !== currentSession;
    if (sessionChanged) {
      for (const taskId of timersRef.current.keys()) clearTimer(taskId);
      sessionRef.current = currentSession;
      previousTasksRef.current = new Map(tasks.map(task => [task.id, task]));
      setExitingTasks(current => current.size ? new Map() : current);
      return;
    }

    const previousTasks = previousTasksRef.current;
    const transitions = completedTransitions(tasks, previousTasks);
    previousTasksRef.current = new Map(tasks.map(task => [task.id, task]));
    if (!previousTasks || !transitions.size || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    for (const [taskId, task] of transitions) {
      if (timersRef.current.has(taskId)) continue;
      setExitingTasks(current => current.has(taskId) ? current : new Map(current).set(taskId, task));
      timersRef.current.set(taskId, window.setTimeout(() => {
        timersRef.current.delete(taskId);
        options.onBeforeRemove?.();
        setExitingTasks(current => {
          if (!current.has(taskId)) return current;
          const next = new Map(current);
          next.delete(taskId);
          return next;
        });
        setLayoutRevision(current => current + 1);
      }, doneExitDuration));
    }
  }, [currentSession, options, tasks]);

  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const clearExits = () => {
      if (!reduced.matches) return;
      for (const taskId of timersRef.current.keys()) clearTimer(taskId);
      setExitingTasks(current => current.size ? new Map() : current);
    };
    reduced.addEventListener('change', clearExits);
    clearExits();
    return () => {
      reduced.removeEventListener('change', clearExits);
      for (const taskId of timersRef.current.keys()) clearTimer(taskId);
    };
  }, [currentSession]);

  const queueItems = useMemo(() => {
    const exits = sessionRef.current === currentSession ? new Map(exitingTasks) : new Map<string, ExitingTask>();
    for (const [taskId, task] of transitionedTasks) if (!exits.has(taskId)) exits.set(taskId, task);
    return tasks
      .filter(task => isQueueStatus(task.status) || exits.has(task.id))
      .map(task => {
        const exitTask = exits.get(task.id);
        return exitTask && !isQueueStatus(task.status) ? { task: exitTask.task, exiting: true, fromStatus: exitTask.fromStatus } : { task, exiting: false };
      });
  }, [exitingTasks, tasks, transitionedTasks]);

  useEffect(() => () => {
    for (const taskId of timersRef.current.keys()) clearTimer(taskId);
  }, []);

  return { items: queueItems, layoutRevision };
}
