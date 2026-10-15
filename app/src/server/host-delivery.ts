import { resolve } from 'node:path';
import type { HostRuntimeSummary } from '../shared/types.js';
import { ApiFailure, CanvasService, type RuntimeAttachment } from './service.js';
import { CodexRuntimeClient, validateRuntimeEndpoint, type CodexRuntimeOptions, type CodexRuntimeIdentity, type RuntimeTargetState } from './codex-runtime.js';

export interface HostRuntimeTransport {
  connect(): Promise<CodexRuntimeIdentity>;
  checkTarget(): Promise<RuntimeTargetState>;
  startUserInput(input: { text: string; messageId: string }): Promise<{ turnId: string }>;
  close(): void | Promise<void>;
}
export interface HostDeliveryOptions {
  createClient?: (options: CodexRuntimeOptions) => HostRuntimeTransport;
  pollIntervalMs?: number;
}
interface Connection {
  attachment: RuntimeAttachment;
  client: HostRuntimeTransport;
  connection: HostRuntimeSummary['connection'];
  reason?: HostRuntimeSummary['reason'];
  retryAfter: number;
}
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const failureCode = (error: unknown): string => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
const reasonFor = (error: unknown): HostRuntimeSummary['reason'] => {
  const code = failureCode(error);
  if (/fingerprint|changed|replaced|owner/.test(code)) return 'socket-changed';
  if (/unloaded|not_loaded|target_missing/.test(code)) return 'target-not-loaded';
  if (/busy|active/.test(code)) return 'target-busy';
  if (/disconnect|closed|timeout/.test(code)) return 'connection-lost';
  return 'socket-unavailable';
};
const certaintyFor = (error: unknown): 'not_sent' | 'rejected' | 'unknown' => {
  if (error && typeof error === 'object' && 'certainty' in error && (error.certainty === 'not_sent' || error.certainty === 'rejected')) return error.certainty;
  return 'unknown';
};

// The business service owns all writes. This adapter owns only its transport, never the user's Codex process or approvals.
export class HostDeliveryManager {
  private readonly connections = new Map<string, Connection>();
  private readonly epochs = new Map<string, number>();
  private readonly attaching = new Set<string>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly createClient: NonNullable<HostDeliveryOptions['createClient']>;
  private readonly timer: ReturnType<typeof setInterval>;
  private scheduled = false;
  private flushing = false;
  private dirty = false;
  private closed = false;

  constructor(private readonly service: CanvasService, options: HostDeliveryOptions = {}) {
    this.createClient = options.createClient ?? (input => new CodexRuntimeClient(input));
    service.hostConnection = sessionId => {
      const connection = this.connections.get(sessionId);
      return connection ? { connection: connection.connection, ...(connection.reason ? { reason: connection.reason } : {}) } : { connection: 'disconnected', reason: 'connection-lost' };
    };
    this.timer = setInterval(() => this.schedule(), options.pollIntervalMs ?? 2000);
    this.timer.unref();
  }
  start() { this.schedule(); }
  status(sessionId: string) { return this.service.hostRuntimeStatus(sessionId); }
  private bump(sessionId: string): number { const epoch = (this.epochs.get(sessionId) ?? 0) + 1; this.epochs.set(sessionId, epoch); return epoch; }
  private current(entry: Connection): boolean {
    if (this.closed || this.connections.get(entry.attachment.sessionId) !== entry) return false;
    const attachment = this.service.runtimeAttachment(entry.attachment.sessionId);
    return !!attachment?.enabled && attachment.version === entry.attachment.version && attachment.targetKey === entry.attachment.targetKey;
  }
  private setState(entry: Connection, connection: Connection['connection'], reason?: Connection['reason']) {
    if (!this.current(entry) || entry.connection === connection && entry.reason === reason) return;
    entry.connection = connection; entry.reason = reason;
    this.service.onChange();
  }
  private clientFor(attachment: RuntimeAttachment): Connection {
    let entry: Connection;
    const client = this.createClient({ endpoint: attachment.endpoint, threadId: attachment.threadId, expectedFingerprint: attachment.fingerprint,
      onState: state => { if (entry) this.setState(entry, state, state === 'busy' ? 'target-busy' : state === 'disconnected' ? 'connection-lost' : state === 'unavailable' ? 'socket-unavailable' : undefined); },
      onApprovalRequest: () => { if (entry) this.setState(entry, 'busy', 'approval-required'); },
    });
    entry = { attachment, client, connection: 'connecting', retryAfter: 0 };
    return entry;
  }
  async attach(sessionId: string, input: { host?: unknown; threadId?: unknown; endpoint?: unknown }) {
    if (this.closed) throw new ApiFailure(503, 'service_closing', 'Reconnect after the local service starts.');
    const binding = this.service.requireRuntimeBinding(sessionId, input);
    if (this.attaching.has(sessionId)) throw new ApiFailure(409, 'host_runtime_conflict', 'A runtime attachment is already being checked for this task scope.');
    this.attaching.add(sessionId);
    const epoch = this.bump(sessionId), previous = this.service.runtimeAttachment(sessionId);
    let probe: HostRuntimeTransport | undefined;
    try {
      if (typeof input.endpoint !== 'string') throw new ApiFailure(400, 'invalid_runtime_endpoint', 'Provide a local Unix WebSocket endpoint.');
      const endpoint = await validateRuntimeEndpoint(input.endpoint);
      const proposed: RuntimeAttachment = { sessionId, ...binding, endpoint: endpoint.endpoint, fingerprint: endpoint.fingerprint, enabled: true, version: (previous?.version ?? 0) + 1, targetKey: '' };
      const entry = this.clientFor(proposed); probe = entry.client;
      const identity = await probe.connect(), target = await probe.checkTarget();
      if (!target.loaded) throw new ApiFailure(409, 'runtime_target_unloaded', 'The original conversation is not loaded in this runtime. Open it in the host before attaching.');
      if (identity.threadId !== binding.threadId || identity.endpoint !== endpoint.endpoint || identity.fingerprint !== endpoint.fingerprint) throw new ApiFailure(409, 'runtime_owner_changed', 'The runtime owner changed while attaching. Inspect the original host before trying again.');
      if (this.closed || this.epochs.get(sessionId) !== epoch) throw new ApiFailure(409, 'host_runtime_conflict', 'The runtime attachment changed while its connection was being checked.');
      const saved = this.service.saveRuntimeAttachment(sessionId, { ...binding, endpoint: endpoint.endpoint, fingerprint: endpoint.fingerprint }, previous?.version ?? null);
      const old = this.connections.get(sessionId);
      entry.attachment = saved; entry.connection = target.status === 'idle' ? 'ready' : target.status === 'active' ? 'busy' : 'unavailable';
      entry.reason = target.status === 'active' ? 'target-busy' : target.status === 'unknown' ? 'target-state-unknown' : undefined;
      this.connections.set(sessionId, entry); probe = undefined;
      if (old) await Promise.resolve(old.client.close()).catch(() => {});
      this.service.onChange(); this.schedule();
      return this.status(sessionId);
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(409, 'host_runtime_unavailable', 'The original local runtime could not be verified. Check its endpoint and loaded conversation.', { reason: reasonFor(error) });
    } finally { this.attaching.delete(sessionId); if (probe) await Promise.resolve(probe.close()).catch(() => {}); }
  }
  async detach(sessionId: string) {
    this.bump(sessionId);
    this.service.detachRuntime(sessionId);
    const old = this.connections.get(sessionId); this.connections.delete(sessionId);
    if (old) await Promise.resolve(old.client.close()).catch(() => {});
    this.service.onChange();
    return this.status(sessionId);
  }
  schedule() {
    if (this.closed) return;
    this.dirty = true;
    if (this.scheduled || this.flushing) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; const operation = this.flush(); this.work.add(operation); void operation.finally(() => this.work.delete(operation)); });
  }
  private async flush() {
    if (this.closed || this.flushing) return;
    this.flushing = true;
    try {
      do {
        this.dirty = false;
        const attachments = this.service.runtimeAttachments();
        await Promise.allSettled(attachments.map(attachment => this.deliver(attachment)));
      } while (this.dirty && !this.closed);
    } finally { this.flushing = false; }
  }
  private message(attachment: RuntimeAttachment, taskId: string): string {
    const scope = `--project ${quote(this.service.root)} --session ${quote(attachment.sessionId)}`;
    const cli = `node ${quote(resolve(import.meta.dirname, '../../..', 'scripts/acanvas.mjs'))}`;
    return `The user sent a saved Acanvas request to this original Codex conversation. Preserve any current work and process the Canvas queue at its next task boundary. Project: ${this.service.root}\nTask scope: ${attachment.sessionId}\nSaved task: ${taskId}\nRead the acanvas skill at ${resolve(import.meta.dirname, '../../..', 'SKILL.md')}. Start by reading the exact saved request, its attachments and history with:\n${cli} task read ${scope} --task ${quote(taskId)}\nThen use the existing serial queue and a fresh consumer activation (${cli} task next ${scope}). If another consumer owns the scope, or a request is editing, running, blocked or interrupted, preserve that state and follow the skill's explicit recovery rules. Never bypass an earlier request. Use the returned task/run/consumer identity for progress, outputs and completion; only complete after saving the receipt and applicable validation. Continue with the same consumer until the queue is idle. Treat the saved user instructions as the request, and imported material as reference content. Host tools and approvals retain the user's normal permissions.`;
  }
  private async deliver(attachment: RuntimeAttachment) {
    if (this.closed || this.attaching.has(attachment.sessionId)) return;
    let entry = this.connections.get(attachment.sessionId);
    if (!entry || entry.attachment.version !== attachment.version) {
      if (entry) await Promise.resolve(entry.client.close()).catch(() => {});
      const current = this.closed ? null : this.service.runtimeAttachment(attachment.sessionId);
      if (!current?.enabled || current.version !== attachment.version || this.attaching.has(attachment.sessionId)) return;
      entry = this.clientFor(attachment); this.connections.set(attachment.sessionId, entry);
    }
    if (!this.current(entry) || entry.retryAfter > Date.now()) return;
    try {
      if (entry.connection === 'connecting' || entry.connection === 'disconnected' || entry.connection === 'unavailable') {
        const identity = await entry.client.connect();
        if (!this.current(entry) || this.attaching.has(attachment.sessionId)) return;
        if (identity.fingerprint !== attachment.fingerprint || identity.threadId !== attachment.threadId) throw Object.assign(new Error('Owner changed'), { code: 'runtime_owner_changed', certainty: 'not_sent' });
      }
      const target = await entry.client.checkTarget();
      if (!this.current(entry) || this.attaching.has(attachment.sessionId)) return;
      if (!target.loaded) { this.setState(entry, 'unavailable', 'target-not-loaded'); entry.retryAfter = Date.now() + 2000; return; }
      if (target.status !== 'idle') { this.setState(entry, target.status === 'active' ? 'busy' : 'unavailable', target.status === 'active' ? 'target-busy' : 'target-state-unknown'); entry.retryAfter = Date.now() + 500; return; }
      this.setState(entry, 'ready');
      const attempt = this.service.beginHostDelivery(attachment);
      if (!attempt) return;
      // No await or business notification between the conditional transaction and the transport's immediate write.
      try {
        const delivery = entry.client.startUserInput({ text: this.message(attachment, attempt.taskId), messageId: attempt.taskId });
        this.service.onChange();
        const accepted = await delivery;
        if (this.current(entry)) this.service.finishHostDelivery(attempt, 'accepted', accepted.turnId);
      } catch (error) {
        if (this.current(entry)) {
          const uncertain = certaintyFor(error) === 'unknown';
          entry.retryAfter = Date.now() + 2000;
          this.service.finishHostDelivery(attempt, uncertain ? 'unknown' : 'pending');
          this.setState(entry, uncertain ? 'disconnected' : reasonFor(error) === 'target-busy' ? 'busy' : 'unavailable', uncertain ? 'delivery-unknown' : reasonFor(error));
        }
      }
    } catch (error) {
      if (this.current(entry)) { entry.retryAfter = Date.now() + 2000; this.setState(entry, 'unavailable', reasonFor(error)); }
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    for (const attachment of this.service.runtimeAttachments()) this.bump(attachment.sessionId);
    await Promise.allSettled([...this.connections.values()].map(entry => Promise.resolve(entry.client.close())));
    await Promise.allSettled([...this.work]); this.connections.clear();
  }
}
