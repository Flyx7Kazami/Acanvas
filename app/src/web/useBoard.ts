import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnnotationInput, BoardObject, BoardOperation, BoardVersionChanges, BoardState, Draft, SessionView } from '../shared/types';
import { referenceOrder } from '../shared/task-message';
import { annotationTarget } from './annotation-scene';
import { CanvasCamera, sameViewContext, viewContext, type ViewContext } from './canvas-camera';
import { BoardApi, RequestError } from './api';
import { ownExpectedVersion, rememberVersionChanges, type OwnVersions } from './board-versions';
import type { ContentEditorRegistration, ContentSaveResult } from './content-editing';

type SavingDraft = { value: Draft; editRevision: number; expectedRevision: number };
type LocalDraft = { value: Draft; serverAnnotations: AnnotationInput[]; editRevision: number; savedEditRevision: number; confirmedRevision: number; epoch: number; failed?: boolean; conflict?: Draft; inflight?: SavingDraft; lastAttempt?: SavingDraft };
type ContentBoardOperation = Extract<BoardOperation, { type: 'content' }>;
export type HistoryAction = 'undo' | 'redo';
export type SaveState = 'saved' | 'saving' | 'unsaved' | 'failed';
const comparableReferences = (references: Draft['references']) => ({ objectIds: references.objectIds, groupIds: references.groupIds || [], taskIds: references.taskIds, order: referenceOrder(references).map(reference => ({ kind: reference.kind, id: reference.id, ...(reference.textOffset === undefined ? {} : { textOffset: reference.textOffset }) })) });
const draftContent = (value: Draft) => JSON.stringify({ text: value.text, attachments: value.attachments, annotations: value.annotations, references: comparableReferences(value.references) });
const freshDraft = (value: Draft, epoch = 0): LocalDraft => ({ value, serverAnnotations: value.annotations, editRevision: 0, savedEditRevision: 0, confirmedRevision: value.revision, epoch });
const sameTarget = (a: AnnotationInput, b: AnnotationInput) => JSON.stringify(annotationTarget(a)) === JSON.stringify(annotationTarget(b));
const draftIntent = (value: Draft) => JSON.stringify({ id: value.id, sessionId: value.sessionId, editingTaskId: value.editingTaskId, text: value.text, attachments: value.attachments, references: comparableReferences(value.references), annotations: value.annotations.map(({ captureState, capture, ...annotation }) => annotation) });
const displayAnnotation = (local: AnnotationInput, server?: AnnotationInput): AnnotationInput => {
  if (!server?.captureState) return local;
  return sameTarget(local, server) ? { ...local, sceneSource: server.sceneSource, captureState: server.captureState, capture: server.capture } : { ...local, sceneSource: undefined, captureState: { version: server.captureState.version, status: 'incomplete' }, capture: undefined };
};
/** Capture versions and records come from the service; local target edits retain their own intent. */
const annotationForSave = (annotation: AnnotationInput, server?: AnnotationInput): AnnotationInput => server?.captureState ? { ...annotation, captureState: server.captureState, capture: server.capture } : annotation;

export function useBoard() {
  const api = useMemo(() => new BoardApi(), []);
  const [state, setState] = useState<BoardState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftConflict, setDraftConflict] = useState<Draft | null>(null);
  const [contextView, setContextView] = useState<ViewContext>({ selectedObjectIds: [] });
  const camera = useMemo(() => new CanvasCamera({ x: 0, y: 0, zoom: 1, selectedObjectIds: [] }), []);
  useEffect(() => () => camera.dispose(), [camera]);
  const [failure, setFailure] = useState({ message: '', revision: 0 });
  const error = failure.message;
  const setError = useCallback((message: string) => setFailure(current => ({ message, revision: current.revision + (message ? 1 : 0) })), []);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [serviceInstance, setServiceInstance] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [switching, setSwitching] = useState(false);
  const [sending, setSending] = useState(false);
  const [historyBusy, setHistoryBusy] = useState<HistoryAction | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [projectChanged, setProjectChanged] = useState(false);
  const [contentDirty, setContentDirtyState] = useState(false);
  const [contentComposing, setContentComposingState] = useState(false);
  const streamRef = useRef<AbortController | null>(null);
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
  const mutationQueues = useRef(new Map<string, Promise<void>>());
  const mutationPending = useRef(new Map<string, number>());
  const objectsBySession = useRef(new Map<string, BoardObject[]>());
  const ownGroupVersions = useRef(new Map<string, OwnVersions>());
  const ownObjectVersions = useRef(new Map<string, OwnVersions>());
  const contentEditors = useRef(new Map<string, ContentEditorRegistration>());
  const contentDirtyByEditor = useRef(new Map<string, boolean>());
  const loadSequence = useRef(0);
  const historyBusyRef = useRef<HistoryAction | null>(null);
  const showError = useCallback((cause: unknown) => {
    if (cause instanceof RequestError && cause.code === 'project_changed') {
      setProjectChanged(true); streamRef.current?.abort(); window.clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = 0;
    }
    setError(cause instanceof Error ? cause.message : 'The action could not be completed. Try again.');
  }, []);

  const reflectDraft = useCallback((value: LocalDraft) => {
    setDraft(value.value);
    setDraftConflict(value.conflict || null);
    setSaveState(value.conflict || value.failed ? 'failed' : value.editRevision === value.savedEditRevision ? 'saved' : value.inflight ? 'saving' : 'unsaved');
  }, []);

  const contentKey = (sessionId: string, objectId: string) => `${sessionId}:${objectId}`;
  const contentDirtyForSession = (sessionId: string) => [...contentDirtyByEditor.current].some(([key, dirty]) => dirty && key.startsWith(`${sessionId}:`));
  const contentComposingForSession = (sessionId: string) => [...contentEditors.current].some(([key, editor]) => key.startsWith(`${sessionId}:`) && editor.isComposing());

  const adopt = useCallback((next: BoardState) => {
    objectsBySession.current.set(next.session.id, next.objects);
    const ownVersions = ownObjectVersions.current.get(next.session.id);
    if (ownVersions) {
      for (const [objectId, version] of ownVersions) {
        const object = next.objects.find(value => value.id === objectId);
        if (!object || object.version !== version.current) ownVersions.delete(objectId);
      }
      if (!ownVersions.size) ownObjectVersions.current.delete(next.session.id);
    }
    const groupVersions = ownGroupVersions.current.get(next.session.id);
    if (groupVersions) for (const [id, version] of groupVersions) { if (next.groups.find(group => group.id === id)?.version !== version.current) groupVersions.delete(id); }
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
    if (viewSessionRef.current !== next.session.id) camera.reset(nextView, next.session.id);
    else camera.update(nextView);
    sessionRef.current = next.session.id;
    viewSessionRef.current = next.session.id;
    sessionStorage.setItem(`acanvas-context:${next.project.id}`, next.session.id);
    setState(next);
    setContentDirtyState(contentDirtyForSession(next.session.id));
    setContentComposingState(contentComposingForSession(next.session.id));
    reflectDraft(local);
    setContextView(viewContext(nextView));
    setMutationBusy((mutationPending.current.get(next.session.id) || 0) > 0);
    const url = new URL(window.location.href); url.searchParams.set('session', next.session.id); window.history.replaceState(null, '', url);
  }, [reflectDraft]);

  const refresh = useCallback(async () => {
    const sessionId = sessionRef.current, sequence = ++loadSequence.current;
    const next = await api.state(sessionId || undefined);
    if (sequence === loadSequence.current && (!sessionId || sessionId === sessionRef.current)) adopt(next);
    return next;
  }, [api, adopt]);

  const enqueueMutation = useCallback(<T,>(sessionId: string, mutation: () => Promise<T>) => {
    const previous = mutationQueues.current.get(sessionId) || Promise.resolve();
    mutationPending.current.set(sessionId, (mutationPending.current.get(sessionId) || 0) + 1);
    if (sessionRef.current === sessionId) setMutationBusy(true);
    const request = previous.catch(() => undefined).then(mutation);
    const settled = request.then(value => {
      const remaining = Math.max(0, (mutationPending.current.get(sessionId) || 1) - 1);
      if (remaining) mutationPending.current.set(sessionId, remaining); else mutationPending.current.delete(sessionId);
      if (sessionRef.current === sessionId) setMutationBusy(remaining > 0);
      return value;
    }, cause => {
      const remaining = Math.max(0, (mutationPending.current.get(sessionId) || 1) - 1);
      if (remaining) mutationPending.current.set(sessionId, remaining); else mutationPending.current.delete(sessionId);
      if (sessionRef.current === sessionId) setMutationBusy(remaining > 0);
      throw cause;
    });
    mutationQueues.current.set(sessionId, settled.then(() => undefined, () => undefined));
    return settled;
  }, []);

  const registerContentEditor = useCallback((registration: ContentEditorRegistration) => {
    const key = contentKey(registration.sessionId, registration.objectId);
    contentEditors.current.set(key, registration);
    contentDirtyByEditor.current.set(key, false);
    return () => {
      if (contentEditors.current.get(key) === registration) contentEditors.current.delete(key);
      contentDirtyByEditor.current.delete(key);
      if (registration.sessionId === sessionRef.current) {
        setContentDirtyState(contentDirtyForSession(registration.sessionId));
        setContentComposingState(contentComposingForSession(registration.sessionId));
      }
    };
  }, []);

  const setContentDirty = useCallback((sessionId: string, objectId: string, dirty: boolean) => {
    const key = contentKey(sessionId, objectId);
    contentDirtyByEditor.current.set(key, dirty);
    if (sessionRef.current === sessionId) setContentDirtyState(contentDirtyForSession(sessionId));
  }, []);

  const setContentComposing = useCallback((sessionId: string, objectId: string, composing: boolean) => {
    if (sessionRef.current === sessionId) setContentComposingState(contentComposingForSession(sessionId) || composing);
  }, []);

  const flushContent = useCallback(async (sessionId = sessionRef.current) => {
    const editors = [...contentEditors.current.entries()]
      .filter(([key]) => key.startsWith(`${sessionId}:`))
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [, editor] of editors) await editor.flush();
    if (sessionId === sessionRef.current) setContentDirtyState(contentDirtyForSession(sessionId));
  }, []);

  const markOwnVersions = useCallback((sessionId: string, changes: BoardVersionChanges) => {
    const objects = ownObjectVersions.current.get(sessionId) || new Map();
    const groups = ownGroupVersions.current.get(sessionId) || new Map();
    rememberVersionChanges(objects, changes.objects); rememberVersionChanges(groups, changes.groups);
    ownObjectVersions.current.set(sessionId, objects); ownGroupVersions.current.set(sessionId, groups);
  }, []);

  const rebaseOwnVersions = useCallback((sessionId: string, operations: BoardOperation[]) => {
    const versions = ownObjectVersions.current.get(sessionId);
    const groupVersions = ownGroupVersions.current.get(sessionId);
    return operations.map(operation => {
      if (operation.type === 'group.create') return { ...operation, expectedVersions: Object.fromEntries(Object.entries(operation.expectedVersions).map(([id, version]) => [id, ownExpectedVersion(versions, id, version)])) };
      if (operation.type === 'group.update' || operation.type === 'group.ungroup') return { ...operation, expectedVersion: ownExpectedVersion(groupVersions, operation.groupId, operation.expectedVersion) };
      if (operation.type !== 'update' && operation.type !== 'delete' && operation.type !== 'content') return operation;
      return { ...operation, expectedVersion: ownExpectedVersion(versions, operation.objectId, operation.expectedVersion) };
    });
  }, []);

  useEffect(() => {
    let alive = true, events: AbortController | undefined, reconnectingRequest: Promise<unknown> | undefined, timer = 0;
    const changed = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { if (alive) void refresh().catch(showError); }, 60); };
    const reconnect = () => {
      if (!alive || api.projectChanged || reconnectTimerRef.current) return;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = 0;
        if (!alive || api.projectChanged) return;
      reconnectingRequest = api.bootstrap().then(bootstrap => { if (alive) { setServiceInstance(bootstrap.service.instanceId); return refresh(); } }).then(() => { if (alive) connectEvents(); }).catch(cause => { if (alive) { if (cause instanceof RequestError && cause.code === 'project_changed') showError(cause); else reconnect(); } }).finally(() => { reconnectingRequest = undefined; });
      }, 800);
    };
    const connectEvents = () => {
      if (!alive || api.projectChanged) return;
      events?.abort(); events = new AbortController(); streamRef.current = events;
      const current = events;
      void api.watchEvents(current.signal, () => { if (alive && !current.signal.aborted) { setConnection('connected'); void refresh().catch(showError); } }, changed).catch(() => {
        if (!alive || current.signal.aborted) return;
        setConnection('reconnecting'); current.abort();
        if (!reconnectingRequest) reconnect();
      });
    };
    (async () => {
      const bootstrap = await api.bootstrap();
      if (!alive) return;
      setServiceInstance(bootstrap.service.instanceId);
      if (!sessionRef.current) {
        const remembered = sessionStorage.getItem(`acanvas-context:${bootstrap.project.id}`);
        const sessionId = remembered || (await api.createSession('Creative tasks')).id;
        if (!alive) return; sessionRef.current = sessionId;
      }
      const next = await api.state(sessionRef.current); if (!alive) return;
      adopt(next); connectEvents();
    })().catch(cause => { if (alive) showError(cause); });
    return () => { alive = false; events?.abort(); window.clearTimeout(timer); window.clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = 0; };
  }, [api, adopt, refresh, showError]);

  const save = useCallback((snapshot: LocalDraft) => {
    const sessionId = snapshot.value.sessionId, draftId = snapshot.value.id;
    const pending = (draftQueues.current.get(sessionId) || Promise.resolve()).then(async () => {
      const current = drafts.current.get(sessionId);
      if (!current || current.value.id !== draftId || current.epoch !== snapshot.epoch || snapshot.editRevision <= current.savedEditRevision) return;
      if (current.conflict) throw new RequestError('Your draft was updated elsewhere. Compare both versions to continue.', 409, 'draft_revision_conflict');
      const saving = { value: { ...snapshot.value, revision: current.confirmedRevision, annotations: snapshot.value.annotations.map(annotation => {
        const server = current.serverAnnotations.find(value => value.id === annotation.id);
        return annotationForSave(annotation, server);
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

  /** Service capture saves share the draft queue and merge local edits made after Done. */
  const saveCapturedDraft = useCallback((candidate: Draft): Promise<Draft> => {
    const sessionId = candidate.sessionId, draftId = candidate.id;
    window.clearTimeout(draftTimers.current.get(sessionId));
    const pending = (draftQueues.current.get(sessionId) || Promise.resolve()).catch(() => undefined).then(async () => {
      const current = drafts.current.get(sessionId);
      if (!current || current.value.id !== draftId || current.conflict) throw new RequestError('Load the current annotation draft.', 409, 'draft_conflict');
      const captured = candidate.annotations.find(value => value.sceneSource && !current.value.annotations.some(local => local.id === value.id && local.sceneSource?.id === value.sceneSource?.id));
      if (!captured) throw new RequestError('Read the copied annotation source.', 409, 'scene_source_conflict');
      const local = current.value.annotations.find(value => value.id === captured.id);
      if (!local || !sameTarget(local, captured)) throw new RequestError('The annotation target changed.', 409, 'capture_version_conflict');
      const saving = { value: { ...current.value, revision: current.confirmedRevision, annotations: current.value.annotations.map(value => annotationForSave(value.id === captured.id ? { ...value, sceneSource: captured.sceneSource, captureState: value.captureState ?? captured.captureState } : value, current.serverAnnotations.find(server => server.id === value.id))) }, editRevision: current.editRevision, expectedRevision: current.confirmedRevision };
      current.inflight = saving; current.lastAttempt = saving;
      try {
        const saved = await api.saveDraft(saving.value), latest = drafts.current.get(sessionId);
        if (latest?.value.id === draftId && saved.revision >= latest.confirmedRevision) {
          latest.confirmedRevision = saved.revision; latest.serverAnnotations = saved.annotations; latest.savedEditRevision = Math.max(latest.savedEditRevision, saving.editRevision); latest.failed = false;
          latest.value = latest.editRevision === saving.editRevision ? saved : { ...latest.value, revision: saved.revision, annotations: latest.value.annotations.map(value => displayAnnotation(value, saved.annotations.find(annotation => annotation.id === value.id))) };
          if (sessionRef.current === sessionId) reflectDraft(latest);
        }
        return saved;
      } finally { const latest = drafts.current.get(sessionId); if (latest?.inflight === saving) { latest.inflight = undefined; if (sessionRef.current === sessionId) reflectDraft(latest); } }
    });
    draftQueues.current.set(sessionId, pending.then(() => undefined, () => undefined)); return pending;
  }, [api, reflectDraft]);

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

  const queueView = useCallback((next: SessionView, ownerSessionId: string, persist: boolean | 'immediate') => {
    if (api.projectChanged || switchingRef.current || ownerSessionId !== sessionRef.current || ownerSessionId !== viewSessionRef.current) return;
    window.clearTimeout(viewTimers.current.get(ownerSessionId));
    if (!persist) return;
    const saveView = () => {
      const previous = viewQueues.current.get(ownerSessionId) || Promise.resolve();
      const request = previous.catch(() => undefined).then(() => api.view(ownerSessionId, next));
      viewQueues.current.set(ownerSessionId, request); void request.catch(showError);
    };
    if (persist === 'immediate') saveView();
    else viewTimers.current.set(ownerSessionId, window.setTimeout(saveView, 250));
  }, [api, showError]);
  const persistView = useCallback((next: SessionView, ownerSessionId: string) => queueView(next, ownerSessionId, 'immediate'), [queueView]);
  const updateView = useCallback((next: SessionView, ownerSessionId = viewSessionRef.current, persist: boolean | 'immediate' = true) => {
    if (api.projectChanged || switchingRef.current || ownerSessionId !== sessionRef.current || ownerSessionId !== viewSessionRef.current) return;
    views.current.set(ownerSessionId, next); camera.update(next);
    setContextView(current => sameViewContext(current, next) ? current : viewContext(next));
    queueView(next, ownerSessionId, persist);
  }, [api, camera, queueView]);

  const switchSession = useCallback(async (sessionId: string) => {
    if (sessionId === sessionRef.current || switchingRef.current) return;
    const previous = sessionRef.current;
    try {
      await flushContent(previous);
      await flushDraft(previous);
    } catch (cause) {
      showError(cause);
      return;
    }
    if (camera.getFrame().moving) updateView(camera.flush(), previous, 'immediate');
    sessionRef.current = sessionId; switchingRef.current = true; setSwitching(true);
    const sequence = ++loadSequence.current;
    try { const next = await api.state(sessionId); if (sequence === loadSequence.current && sessionId === sessionRef.current) adopt(next); }
    catch (cause) { if (sessionRef.current === sessionId) { sessionRef.current = previous; showError(cause); } }
    finally { switchingRef.current = false; setSwitching(false); }
  }, [api, adopt, camera, updateView, flushContent, flushDraft, showError]);

  const createSession = useCallback(async (name: string) => { const session = await api.createSession(name); await switchSession(session.id); }, [api, switchSession]);
  const send = useCallback(async () => {
    const current = drafts.current.get(sessionRef.current)?.value;
    if (!current || switchingRef.current) return;
    setSending(true); setError('');
    try {
      await flushContent(current.sessionId);
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
  }, [api, flushContent, flushDraft, refresh, showError, reflectDraft, adopt]);

  const editTask = useCallback(async (taskId: string, cancel = false) => {
    const current = drafts.current.get(sessionRef.current)?.value;
    if (!current || switchingRef.current) return;
    setSending(true); setError('');
    try {
      await flushContent(current.sessionId);
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
  }, [api, flushContent, flushDraft, refresh, reflectDraft, showError, adopt]);

  const saveContent = useCallback(async (objectId: string, text: string, expectedVersion?: number, sessionId = sessionRef.current): Promise<ContentSaveResult> => {
    return enqueueMutation(sessionId, async () => {
      try {
        const object = objectsBySession.current.get(sessionId)?.find(value => value.id === objectId);
        if (!object) throw new RequestError('A referenced file was removed from the canvas.', 409, 'object_missing');
        const version = ownExpectedVersion(ownObjectVersions.current.get(sessionId), objectId, expectedVersion ?? object.version);
        const operation: ContentBoardOperation = { type: 'content', objectId, expectedVersion: version, text };
        const response = await api.operations(sessionId, [operation]);
        const updated = response.objects.find(value => value.id === objectId);
        if (!updated) throw new RequestError('The edited file is no longer on the canvas.', 409, 'object_missing');
        markOwnVersions(sessionId, response.versionChanges);
        if (sessionRef.current === sessionId) await refresh();
        return { objectId, assetId: updated.assetId, version: updated.version };
      } catch (cause) {
        if (sessionRef.current === sessionId) await refresh().catch(() => undefined);
        showError(cause); throw cause;
      }
    });
  }, [api, enqueueMutation, markOwnVersions, refresh, showError]);

  const operations = useCallback(async (operations: BoardOperation[], sessionId = sessionRef.current) => {
    await flushContent(sessionId);
    return enqueueMutation(sessionId, async () => {
      try {
        const response = await api.operations(sessionId, rebaseOwnVersions(sessionId, operations));
        markOwnVersions(sessionId, response.versionChanges);
        if (sessionRef.current === sessionId) await refresh();
        return response;
      } catch (cause) {
        if (sessionRef.current === sessionId) await refresh().catch(() => undefined);
        showError(cause); throw cause;
      }
    });
  }, [api, enqueueMutation, flushContent, markOwnVersions, rebaseOwnVersions, refresh, showError]);

  const historyAction = useCallback(async (action: HistoryAction, sessionId = sessionRef.current) => {
    if (!sessionId || switchingRef.current || api.projectChanged || historyBusyRef.current || contentComposingForSession(sessionId)) return;
    const available = action === 'undo' ? state?.history.canUndo : state?.history.canRedo;
    const queuedMutation = (mutationPending.current.get(sessionId) || 0) > 0;
    const dirtyEditor = contentDirtyForSession(sessionId) || [...contentEditors.current.entries()].some(([key, editor]) => key.startsWith(`${sessionId}:`) && editor.isDirty());
    if (!available && !queuedMutation && !dirtyEditor) return;
    historyBusyRef.current = action; setHistoryBusy(action);
    try {
      await flushContent(sessionId);
      const currentHistory = await api.history(sessionId).catch(() => undefined);
      if (!queuedMutation && currentHistory && !(action === 'undo' ? currentHistory.canUndo : currentHistory.canRedo)) return;
      await enqueueMutation(sessionId, async () => {
        try {
          const response = action === 'undo' ? await api.undo(sessionId) : await api.redo(sessionId);
          markOwnVersions(sessionId, response.versionChanges);
          if (sessionRef.current === sessionId) await refresh();
        } catch (cause) {
          if (sessionRef.current === sessionId) await refresh().catch(() => undefined);
          showError(cause); throw cause;
        }
      });
    } finally {
      if (historyBusyRef.current === action) { historyBusyRef.current = null; setHistoryBusy(null); }
    }
  }, [api, enqueueMutation, flushContent, markOwnVersions, refresh, showError, state]);
  const undo = useCallback((sessionId?: string) => historyAction('undo', sessionId), [historyAction]);
  const redo = useCallback((sessionId?: string) => historyAction('redo', sessionId), [historyAction]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      const draftDirty = [...drafts.current.values()].some(value => value.editRevision !== value.savedEditRevision);
      const editorDirty = contentDirtyForSession(sessionRef.current) || [...contentEditors.current.entries()].some(([key, editor]) => key.startsWith(`${sessionRef.current}:`) && editor.isDirty());
      if (!draftDirty && !editorDirty) return;
      void flushContent(sessionRef.current).catch(() => undefined);
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [flushContent]);
  return { api, state, draft, draftConflict, viewContext: contextView, camera, error, errorRevision: failure.revision, connection, serviceInstance, saveState, switching, sending, historyBusy, mutationBusy, contentDirty, contentComposing, projectChanged, setError, showError, refresh, changeDraft, changeDraftFor, getDraftFor, acceptSavedDraft, saveCapturedDraft, updateView, persistView, switchSession, createSession, send, editTask, operations, saveContent, registerContentEditor, setContentDirty, setContentComposing, undo, redo, flushDraft, flushContent, resolveDraftConflict };
}
