import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnnotationInput, BoardOperation, BoardState, Draft, SessionView } from '../shared/types';
import { referenceOrder } from '../shared/task-message';
import { annotationTarget } from './annotation-scene';
import { BoardApi, RequestError } from './api';

type SavingDraft = { value: Draft; editRevision: number; expectedRevision: number };
type LocalDraft = { value: Draft; serverAnnotations: AnnotationInput[]; editRevision: number; savedEditRevision: number; confirmedRevision: number; epoch: number; failed?: boolean; conflict?: Draft; inflight?: SavingDraft; lastAttempt?: SavingDraft };
export type SaveState = 'saved' | 'saving' | 'unsaved' | 'failed';
const comparableReferences = (references: Draft['references']) => ({ objectIds: references.objectIds, taskIds: references.taskIds, order: referenceOrder(references).map(reference => ({ kind: reference.kind, id: reference.id, ...(reference.textOffset === undefined ? {} : { textOffset: reference.textOffset }) })) });
const draftContent = (value: Draft) => JSON.stringify({ text: value.text, attachments: value.attachments, annotations: value.annotations, references: comparableReferences(value.references) });
const freshDraft = (value: Draft, epoch = 0): LocalDraft => ({ value, serverAnnotations: value.annotations, editRevision: 0, savedEditRevision: 0, confirmedRevision: value.revision, epoch });
const sameTarget = (a: AnnotationInput, b: AnnotationInput) => JSON.stringify(annotationTarget(a)) === JSON.stringify(annotationTarget(b));
const draftIntent = (value: Draft) => JSON.stringify({ id: value.id, sessionId: value.sessionId, editingTaskId: value.editingTaskId, text: value.text, attachments: value.attachments, references: comparableReferences(value.references), annotations: value.annotations.map(({ captureState, capture, ...annotation }) => annotation) });
const displayAnnotation = (local: AnnotationInput, server?: AnnotationInput): AnnotationInput => {
  if (!server?.captureState) return local;
  return sameTarget(local, server) ? { ...local, captureState: server.captureState, capture: server.capture } : { ...local, captureState: { version: server.captureState.version, status: 'incomplete' }, capture: undefined };
};

export function useBoard() {
  const api = useMemo(() => new BoardApi(), []);
  const [state, setState] = useState<BoardState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftConflict, setDraftConflict] = useState<Draft | null>(null);
  const [view, setView] = useState<SessionView>({ x: 0, y: 0, zoom: 1, selectedObjectIds: [] });
  const [failure, setFailure] = useState({ message: '', revision: 0 });
  const error = failure.message;
  const setError = useCallback((message: string) => setFailure(current => ({ message, revision: current.revision + (message ? 1 : 0) })), []);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [switching, setSwitching] = useState(false);
  const [sending, setSending] = useState(false);
  const [projectChanged, setProjectChanged] = useState(false);
  const streamRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef(0);
  const sessionRef = useRef(new URLSearchParams(window.location.search).get('session') || '');
  const viewSessionRef = useRef('');
  const switchingRef = useRef(false);
  const drafts = useRef(new Map<string, LocalDraft>());
  const views = useRef(new Map<string, SessionView>());
  const draftTimers = useRef(new Map<string, number>());
  const draftQueues = useRef(new Map<string, Promise<void>>());
  const viewTimers = useRef(new Map<string, number>());
  const viewQueues = useRef(new Map<string, Promise<unknown>>());
  const loadSequence = useRef(0);
  const showError = useCallback((cause: unknown) => {
    if (cause instanceof RequestError && cause.code === 'project_changed') {
      setProjectChanged(true); streamRef.current?.close(); window.clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = 0;
    }
    setError(cause instanceof Error ? cause.message : 'The action could not be completed. Try again.');
  }, []);

  const reflectDraft = useCallback((value: LocalDraft) => {
    setDraft(value.value);
    setDraftConflict(value.conflict || null);
    setSaveState(value.conflict || value.failed ? 'failed' : value.editRevision === value.savedEditRevision ? 'saved' : value.inflight ? 'saving' : 'unsaved');
  }, []);

  const adopt = useCallback((next: BoardState) => {
    let local = drafts.current.get(next.session.id);
    const remote = next.draft;
    if (!local) local = freshDraft(remote);
    else if (local.value.id !== remote.id) {
      if (local.editRevision !== local.savedEditRevision) local.conflict = remote;
      else local = freshDraft(remote, local.epoch + 1);
    } else if (remote.revision > local.confirmedRevision) {
      const inflight = local.inflight || local.lastAttempt;
      if (inflight && remote.revision >= inflight.expectedRevision + 1 && draftIntent(remote) === draftIntent(inflight.value)) {
        local.failed = false;
        local.confirmedRevision = remote.revision;
        local.value = local.editRevision === inflight.editRevision ? remote : { ...local.value, revision: remote.revision, annotations: local.value.annotations.map(annotation => displayAnnotation(annotation, remote.annotations.find(value => value.id === annotation.id))) };
        local.serverAnnotations = remote.annotations;
        local.savedEditRevision = Math.max(local.savedEditRevision, inflight.editRevision);
      } else if (draftContent(remote) === draftContent(local.value) && !local.conflict) {
        local.failed = false; local.confirmedRevision = remote.revision; local.value = remote; local.savedEditRevision = local.editRevision;
      } else if (local.editRevision === local.savedEditRevision && !local.conflict) local = freshDraft(remote, local.epoch + 1);
      else local.conflict = remote;
    }
    if (local.conflict) window.clearTimeout(draftTimers.current.get(next.session.id));
    drafts.current.set(next.session.id, local);
    const nextView = views.current.get(next.session.id) || next.session.view;
    views.current.set(next.session.id, nextView);
    sessionRef.current = next.session.id;
    viewSessionRef.current = next.session.id;
    sessionStorage.setItem(`acanvas-context:${next.project.id}`, next.session.id);
    setState(next);
    reflectDraft(local);
    setView(nextView);
    const url = new URL(window.location.href); url.searchParams.set('session', next.session.id); window.history.replaceState(null, '', url);
  }, [reflectDraft]);

  const refresh = useCallback(async () => {
    const sessionId = sessionRef.current, sequence = ++loadSequence.current;
    const next = await api.state(sessionId || undefined);
    if (sequence === loadSequence.current && (!sessionId || sessionId === sessionRef.current)) adopt(next);
    return next;
  }, [api, adopt]);

  useEffect(() => {
    let alive = true, events: EventSource | undefined, reconnectingRequest: Promise<unknown> | undefined, timer = 0;
    const changed = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { if (alive) void refresh().catch(showError); }, 60); };
    const reconnect = () => {
      if (!alive || api.projectChanged || reconnectTimerRef.current) return;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = 0;
        if (!alive || api.projectChanged) return;
        reconnectingRequest = api.bootstrap().then(() => alive ? refresh() : undefined).then(() => { if (alive) connectEvents(); }).catch(cause => { if (alive) { if (cause instanceof RequestError && cause.code === 'project_changed') showError(cause); else reconnect(); } }).finally(() => { reconnectingRequest = undefined; });
      }, 800);
    };
    const connectEvents = () => {
      if (!alive || api.projectChanged) return;
      events?.close(); events = new EventSource('/api/events'); streamRef.current = events;
      events.onopen = () => { if (alive) { setConnection('connected'); void refresh().catch(showError); } };
      events.onerror = () => {
        if (!alive) return;
        setConnection('reconnecting'); events?.close();
        if (!reconnectingRequest) reconnect();
      };
      events.onmessage = changed; events.addEventListener('change', changed); events.addEventListener('state', changed);
    };
    (async () => {
      const bootstrap = await api.bootstrap();
      if (!alive) return;
      if (!sessionRef.current) {
        const remembered = sessionStorage.getItem(`acanvas-context:${bootstrap.project.id}`);
        const sessionId = remembered || (await api.createSession('Creative tasks')).id;
        if (!alive) return; sessionRef.current = sessionId;
      }
      const next = await api.state(sessionRef.current); if (!alive) return;
      adopt(next); connectEvents();
    })().catch(cause => { if (alive) showError(cause); });
    return () => { alive = false; events?.close(); window.clearTimeout(timer); window.clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = 0; };
  }, [api, adopt, refresh, showError]);

  const save = useCallback((snapshot: LocalDraft) => {
    const sessionId = snapshot.value.sessionId, draftId = snapshot.value.id;
    const pending = (draftQueues.current.get(sessionId) || Promise.resolve()).then(async () => {
      const current = drafts.current.get(sessionId);
      if (!current || current.value.id !== draftId || current.epoch !== snapshot.epoch || snapshot.editRevision <= current.savedEditRevision) return;
      if (current.conflict) throw new RequestError('Your draft was updated elsewhere. Compare both versions to continue.', 409, 'draft_revision_conflict');
      const saving = { value: { ...snapshot.value, revision: current.confirmedRevision, annotations: snapshot.value.annotations.map(annotation => {
        const server = current.serverAnnotations.find(value => value.id === annotation.id);
        return server?.captureState ? { ...annotation, captureState: server.captureState, capture: server.capture } : annotation;
      }) }, editRevision: snapshot.editRevision, expectedRevision: current.confirmedRevision };
      current.inflight = saving; current.lastAttempt = saving; current.failed = false;
      if (sessionRef.current === sessionId) setSaveState('saving');
      try {
        const response = await api.saveDraft(saving.value);
        const latest = drafts.current.get(sessionId);
        if (latest?.value.id === draftId && latest.epoch === snapshot.epoch) {
          latest.failed = false;
          latest.confirmedRevision = Math.max(latest.confirmedRevision, response.revision);
          latest.value = latest.editRevision === snapshot.editRevision ? response : {
            ...latest.value, revision: latest.confirmedRevision,
            annotations: latest.value.annotations.map(annotation => {
              const saved = response.annotations.find(value => value.id === annotation.id);
              return displayAnnotation(annotation, saved);
            }),
          };
          latest.serverAnnotations = response.annotations;
          latest.savedEditRevision = Math.max(latest.savedEditRevision, snapshot.editRevision);
          if (sessionRef.current === sessionId) reflectDraft(latest);
        }
      } catch (cause) {
        const latest = drafts.current.get(sessionId);
        if (latest?.value.id === draftId && latest.epoch === snapshot.epoch) {
          if (!latest.conflict && latest.savedEditRevision >= snapshot.editRevision && latest.confirmedRevision > saving.expectedRevision) { latest.failed = false; if (sessionRef.current === sessionId) reflectDraft(latest); return; }
          const remote = await api.state(sessionId).catch(() => undefined);
          if (remote?.draft.id === draftId && remote.draft.revision >= saving.expectedRevision && draftIntent(remote.draft) === draftIntent(saving.value)) {
            latest.failed = false; latest.confirmedRevision = remote.draft.revision;
            latest.value = latest.editRevision === snapshot.editRevision ? remote.draft : { ...latest.value, revision: remote.draft.revision, annotations: latest.value.annotations.map(annotation => displayAnnotation(annotation, remote.draft.annotations.find(value => value.id === annotation.id))) };
            latest.serverAnnotations = remote.draft.annotations;
            latest.savedEditRevision = Math.max(latest.savedEditRevision, snapshot.editRevision);
            if (sessionRef.current === sessionId) reflectDraft(latest);
            return;
          }
          latest.failed = true;
          if (remote && (remote.draft.id !== draftId || remote.draft.revision > saving.expectedRevision)) { latest.conflict = remote.draft; window.clearTimeout(draftTimers.current.get(sessionId)); }
          if (sessionRef.current === sessionId) { reflectDraft(latest); setSaveState('failed'); showError(cause); }
        }
        throw cause;
      } finally {
        const latest = drafts.current.get(sessionId);
        if (latest?.inflight === saving) { latest.inflight = undefined; if (sessionRef.current === sessionId) reflectDraft(latest); }
      }
    });
    draftQueues.current.set(sessionId, pending.catch(() => undefined));
    return pending;
  }, [api, reflectDraft, showError]);

  const changeDraftFor = useCallback((sessionId: string, draftId: string, change: (value: Draft) => Draft) => {
    const current = drafts.current.get(sessionId);
    if (api.projectChanged || !current || current.value.id !== draftId) return false;
    const changed = change(current.value);
    const next: LocalDraft = { ...current, value: { ...changed, annotations: changed.annotations.map(annotation => displayAnnotation(annotation, current.serverAnnotations.find(value => value.id === annotation.id))) }, editRevision: current.editRevision + 1, failed: false };
    drafts.current.set(sessionId, next);
    if (sessionRef.current === sessionId) reflectDraft(next);
    window.clearTimeout(draftTimers.current.get(sessionId));
    if (!next.conflict) draftTimers.current.set(sessionId, window.setTimeout(() => { void save(next).catch(() => undefined); }, 350));
    return true;
  }, [save, reflectDraft, api]);

  const getDraftFor = useCallback((sessionId: string, draftId?: string) => {
    const current = drafts.current.get(sessionId)?.value;
    return current && (!draftId || current.id === draftId) ? current : undefined;
  }, []);

  const acceptSavedDraft = useCallback((saved: Draft) => {
    const local = drafts.current.get(saved.sessionId);
    if (!local || local.value.id !== saved.id || saved.revision < local.confirmedRevision) return false;
    if (local.conflict) return false;
    const next = local.editRevision !== local.savedEditRevision ? { ...local, confirmedRevision: saved.revision, serverAnnotations: saved.annotations, value: { ...local.value, revision: saved.revision, annotations: local.value.annotations.map(annotation => displayAnnotation(annotation, saved.annotations.find(value => value.id === annotation.id))) } } : freshDraft(saved, local.epoch + 1);
    drafts.current.set(saved.sessionId, next);
    if (sessionRef.current === saved.sessionId) reflectDraft(next);
    return true;
  }, [reflectDraft]);

  const changeDraft = useCallback((change: (value: Draft) => Draft) => {
    const current = drafts.current.get(sessionRef.current)?.value;
    if (current && !switchingRef.current) changeDraftFor(current.sessionId, current.id, change);
  }, [changeDraftFor]);

  const flushDraft = useCallback(async (sessionId = sessionRef.current) => {
    window.clearTimeout(draftTimers.current.get(sessionId));
    const current = drafts.current.get(sessionId);
    if (current?.conflict) throw new RequestError('Your draft was updated elsewhere. Compare both versions to continue.', 409, 'draft_revision_conflict');
    if (current && current.savedEditRevision !== current.editRevision) await save({ ...current });
    else await draftQueues.current.get(sessionId);
  }, [save]);

  const resolveDraftConflict = useCallback(async (choice: 'local' | 'remote') => {
    const sessionId = sessionRef.current, current = drafts.current.get(sessionId);
    if (!current?.conflict) return;
    const remote = current.conflict;
    window.clearTimeout(draftTimers.current.get(sessionId));
    const next = choice === 'remote' ? freshDraft(remote, current.epoch + 1) : { ...freshDraft({ ...current.value, id: remote.id, revision: remote.revision, editingTaskId: remote.editingTaskId }, current.epoch + 1), editRevision: 1 };
    drafts.current.set(sessionId, next); reflectDraft(next); setError('');
    if (choice === 'local') await save(next);
    await refresh();
  }, [save, refresh, reflectDraft]);

  const updateView = useCallback((next: SessionView, ownerSessionId = viewSessionRef.current, persist = true) => {
    if (api.projectChanged || switchingRef.current || ownerSessionId !== sessionRef.current || ownerSessionId !== viewSessionRef.current) return;
    views.current.set(ownerSessionId, next); setView(next);
    window.clearTimeout(viewTimers.current.get(ownerSessionId));
    if (!persist) return;
    viewTimers.current.set(ownerSessionId, window.setTimeout(() => {
      const previous = viewQueues.current.get(ownerSessionId) || Promise.resolve();
      const request = previous.catch(() => undefined).then(() => api.view(ownerSessionId, next));
      viewQueues.current.set(ownerSessionId, request); void request.catch(showError);
    }, 250));
  }, [api, showError]);

  const switchSession = useCallback(async (sessionId: string) => {
    if (sessionId === sessionRef.current || switchingRef.current) return;
    const previous = sessionRef.current; void flushDraft(previous).catch(() => undefined);
    sessionRef.current = sessionId; switchingRef.current = true; setSwitching(true);
    const sequence = ++loadSequence.current;
    try { const next = await api.state(sessionId); if (sequence === loadSequence.current && sessionId === sessionRef.current) adopt(next); }
    catch (cause) { if (sessionRef.current === sessionId) { sessionRef.current = previous; showError(cause); } }
    finally { switchingRef.current = false; setSwitching(false); }
  }, [api, adopt, flushDraft, showError]);

  const createSession = useCallback(async (name: string) => { const session = await api.createSession(name); await switchSession(session.id); }, [api, switchSession]);
  const send = useCallback(async () => {
    const current = drafts.current.get(sessionRef.current)?.value;
    if (!current || switchingRef.current) return;
    setSending(true); setError('');
    try {
      await flushDraft(current.sessionId);
      const latest = drafts.current.get(current.sessionId)!;
      const result = await api.send(current.sessionId, current.id, latest.confirmedRevision);
      const next = freshDraft(result.draft, latest.epoch + 1); drafts.current.set(current.sessionId, next);
      if (sessionRef.current === current.sessionId) reflectDraft(next);
      await refresh();
      return result.task;
    } catch (cause) {
      const committed = await api.state(current.sessionId).catch(() => undefined);
      if (committed?.tasks.some(task => (task.draftId === current.id || task.lastEditDraftId === current.id))) {
        const next = freshDraft(committed.draft, (drafts.current.get(current.sessionId)?.epoch || 0) + 1);
        drafts.current.set(current.sessionId, next);
        if (sessionRef.current === current.sessionId) { adopt(committed); setError(''); }
        return committed.tasks.find(task => (task.draftId === current.id || task.lastEditDraftId === current.id));
      } else showError(cause);
    }
    finally { setSending(false); }
  }, [api, flushDraft, refresh, showError, reflectDraft, adopt]);

  const editTask = useCallback(async (taskId: string, cancel = false) => {
    const current = drafts.current.get(sessionRef.current)?.value;
    if (!current || switchingRef.current) return;
    setSending(true); setError('');
    try {
      await flushDraft(current.sessionId);
      const latest = drafts.current.get(current.sessionId)!;
      const result = await api.editTask(current.sessionId, taskId, current.id, latest.confirmedRevision, cancel);
      const next = freshDraft(result.draft, latest.epoch + 1); drafts.current.set(current.sessionId, next);
      if (sessionRef.current === current.sessionId) reflectDraft(next);
      await refresh();
    } catch (cause) {
      const persisted = await api.state(current.sessionId).catch(() => undefined);
      const task = persisted?.tasks.find(task => task.id === taskId);
      const recovered = persisted && (cancel ? persisted.draft.id !== current.id && !persisted.draft.editingTaskId && task?.status === 'queued' && task.lastEditDraftId !== current.id : persisted.draft.editingTaskId === taskId && task?.status === 'editing');
      if (recovered) { const next = freshDraft(persisted.draft, (drafts.current.get(current.sessionId)?.epoch || 0) + 1); drafts.current.set(current.sessionId, next); if (sessionRef.current === current.sessionId) { adopt(persisted); setError(''); } }
      else { await refresh().catch(() => undefined); showError(cause); }
    }
    finally { setSending(false); }
  }, [api, flushDraft, refresh, reflectDraft, showError, adopt]);

  const operations = useCallback(async (operations: BoardOperation[], sessionId = sessionRef.current) => {
    try { await api.operations(sessionId, operations); await refresh(); }
    catch (cause) { await refresh().catch(() => undefined); showError(cause); throw cause; }
  }, [api, refresh, showError]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if ([...drafts.current.values()].some(value => value.editRevision !== value.savedEditRevision)) event.preventDefault(); };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, []);
  return { api, state, draft, draftConflict, view, error, errorRevision: failure.revision, connection, saveState, switching, sending, projectChanged, setError, showError, refresh, changeDraft, changeDraftFor, getDraftFor, acceptSavedDraft, updateView, switchSession, createSession, send, editTask, operations, flushDraft, resolveDraftConflict };
}
