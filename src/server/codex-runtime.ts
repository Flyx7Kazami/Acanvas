import { lstatSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { connect as connectSocket } from 'node:net';
import { isAbsolute } from 'node:path';
import { WebSocket } from 'ws';

export type RuntimeFingerprint = string;
export type RuntimeState = 'connecting' | 'ready' | 'busy' | 'disconnected' | 'unavailable';
export type RuntimeCertainty = 'not_sent' | 'rejected' | 'unknown';
export interface RuntimeTargetState { loaded: boolean; status: 'idle' | 'active' | 'unknown' }
export interface CodexRuntimeIdentity { endpoint: string; threadId: string; fingerprint: RuntimeFingerprint; userAgent?: string }
export interface CodexRuntimeOptions {
  endpoint: string;
  threadId: string;
  expectedFingerprint?: RuntimeFingerprint;
  rpcTimeoutMs?: number;
  onState?(state: RuntimeState): void;
  onApprovalRequest?(request: { method: string; requestId: string | number; threadId: string }): void;
}

export class RuntimeDeliveryError extends Error {
  constructor(public readonly certainty: RuntimeCertainty, public readonly code: string, message: string) { super(message); this.name = 'RuntimeDeliveryError'; }
}

function endpointPath(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new RuntimeDeliveryError('not_sent', 'runtime_endpoint_invalid', 'Use an absolute local Unix socket endpoint.'); }
  if (url.protocol !== 'unix:' || url.host || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/')) throw new RuntimeDeliveryError('not_sent', 'runtime_endpoint_invalid', 'Use an absolute local Unix socket endpoint.');
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { throw new RuntimeDeliveryError('not_sent', 'runtime_endpoint_invalid', 'Use an absolute local Unix socket endpoint.'); }
  if (!isAbsolute(path) || path.includes('\0')) throw new RuntimeDeliveryError('not_sent', 'runtime_endpoint_invalid', 'Use an absolute local Unix socket endpoint.');
  return path;
}

function fingerprint(stat: { isSocket(): boolean; isSymbolicLink(): boolean; dev: bigint; ino: bigint; uid: bigint }): RuntimeFingerprint {
  if (stat.isSymbolicLink() || !stat.isSocket()) throw new RuntimeDeliveryError('not_sent', 'runtime_endpoint_invalid', 'The runtime endpoint must be a socket file without a file symlink.');
  if (!process.getuid || stat.uid !== BigInt(process.getuid())) throw new RuntimeDeliveryError('not_sent', 'runtime_endpoint_owner', 'The runtime endpoint must belong to the current user.');
  return `${stat.dev}:${stat.ino}:${stat.uid}`;
}

function endpointFailure(error: unknown): RuntimeDeliveryError { return error instanceof RuntimeDeliveryError ? error : new RuntimeDeliveryError('not_sent', 'runtime_endpoint_unavailable', 'The local runtime endpoint is unavailable.'); }

export async function validateRuntimeEndpoint(endpoint: string, expectedFingerprint?: RuntimeFingerprint): Promise<{ endpoint: string; socketPath: string; fingerprint: RuntimeFingerprint }> {
  try {
    const path = endpointPath(endpoint), original = fingerprint(await lstat(path, { bigint: true }));
    const socketPath = await realpath(path), canonical = fingerprint(await lstat(socketPath, { bigint: true }));
    if (original !== canonical || expectedFingerprint && expectedFingerprint !== canonical) throw new RuntimeDeliveryError('not_sent', 'runtime_endpoint_replaced', 'The runtime endpoint changed. Explicitly attach the intended runtime again.');
    return { endpoint: `unix://${encodeURI(socketPath).replaceAll('?', '%3F').replaceAll('#', '%23')}`, socketPath, fingerprint: canonical };
  } catch (error) { throw endpointFailure(error); }
}

interface PendingRpc { delivery: boolean; written: boolean; timer: ReturnType<typeof setTimeout>; resolve(value: unknown): void; reject(error: RuntimeDeliveryError): void }
const contentNotifications = [
  'thread/started', 'item/started', 'item/completed', 'item/agentMessage/delta', 'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta', 'item/mcpToolCall/progress', 'turn/diff/updated', 'turn/plan/updated',
];
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function targetStatus(value: unknown): RuntimeTargetState['status'] { const type = object(value)?.type; return type === 'idle' || type === 'active' ? type : 'unknown'; }

/** One connection to an explicitly attached existing runtime and already loaded thread. */
export class CodexRuntimeClient {
  private socket?: WebSocket;
  private identity?: CodexRuntimeIdentity;
  private socketPath?: string;
  private initialized = false;
  private closed = false;
  private connecting?: Promise<CodexRuntimeIdentity>;
  private counter = 0;
  private pending = new Map<number, PendingRpc>();
  private target: RuntimeTargetState = { loaded: false, status: 'unknown' };
  private targetRevision = 0;
  private readonly timeout: number;

  constructor(private readonly options: CodexRuntimeOptions) {
    endpointPath(options.endpoint);
    if (!options.threadId.trim() || options.threadId !== options.threadId.trim()) throw new RuntimeDeliveryError('not_sent', 'runtime_thread_invalid', 'Provide the original runtime thread ID.');
    this.timeout = options.rpcTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 60_000) throw new RuntimeDeliveryError('not_sent', 'runtime_timeout_invalid', 'Choose a bounded runtime RPC timeout.');
  }

  private state(state: RuntimeState): void { try { this.options.onState?.(state); } catch { /* Observers cannot alter transport ownership. */ } }
  connect(): Promise<CodexRuntimeIdentity> {
    if (this.closed) return Promise.reject(new RuntimeDeliveryError('not_sent', 'runtime_closed', 'The runtime connection is closed.'));
    if (this.initialized && this.identity) return Promise.resolve(this.identity);
    return this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
  }

  private async open(): Promise<CodexRuntimeIdentity> {
    this.state('connecting');
    try {
      const endpoint = await validateRuntimeEndpoint(this.options.endpoint, this.options.expectedFingerprint ?? this.identity?.fingerprint);
      if (this.closed) throw new RuntimeDeliveryError('not_sent', 'runtime_closed', 'The runtime connection is closed.');
      this.socketPath = endpoint.socketPath;
      this.identity = { endpoint: endpoint.endpoint, threadId: this.options.threadId, fingerprint: endpoint.fingerprint };
      // The HTTP route is fixed; the supplied endpoint can only choose a Unix file.
      const socket = this.socket = new WebSocket('ws://localhost/rpc', { createConnection: () => connectSocket(endpoint.socketPath), handshakeTimeout: this.timeout, perMessageDeflate: false, maxPayload: 1024 * 1024, followRedirects: false });
      socket.on('message', (data, binary) => { if (this.socket === socket) this.message(data.toString(), binary); });
      socket.on('error', () => { if (this.socket === socket) this.disconnected(); });
      socket.on('close', () => { if (this.socket === socket) this.disconnected(); });
      await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', () => reject(new RuntimeDeliveryError('not_sent', 'runtime_unavailable', 'The runtime connection could not be opened.'))); socket.once('close', () => reject(new RuntimeDeliveryError('not_sent', 'runtime_disconnected', 'The runtime connection closed.'))); });
      this.checkSocket();
      const initialized = object(await this.rpc('initialize', { clientInfo: { name: 'acanvas', title: 'Acanvas local canvas delivery', version: '0.1.0' }, capabilities: { experimentalApi: true, optOutNotificationMethods: contentNotifications } }));
      if (typeof initialized?.userAgent === 'string') this.identity.userAgent = initialized.userAgent;
      if (socket.readyState !== WebSocket.OPEN) throw new RuntimeDeliveryError('not_sent', 'runtime_disconnected', 'The runtime connection closed.');
      socket.send(JSON.stringify({ method: 'initialized', params: {} }));
      this.initialized = true;
      const target = await this.checkTarget();
      if (!target.loaded) throw new RuntimeDeliveryError('not_sent', 'runtime_thread_unloaded', 'The original thread is not loaded in the attached runtime.');
      return this.identity;
    } catch (error) {
      this.initialized = false; this.socket?.terminate(); this.state('unavailable');
      throw error instanceof RuntimeDeliveryError ? error : new RuntimeDeliveryError('not_sent', 'runtime_unavailable', 'The attached runtime is unavailable.');
    }
  }

  private checkSocket(): void {
    if (!this.identity || !this.socketPath) throw new RuntimeDeliveryError('not_sent', 'runtime_disconnected', 'Connect the attached runtime first.');
    try {
      const path = endpointPath(this.options.endpoint), original = fingerprint(lstatSync(path, { bigint: true }));
      const canonical = realpathSync(path);
      if (canonical !== this.socketPath || original !== this.identity.fingerprint || fingerprint(lstatSync(canonical, { bigint: true })) !== this.identity.fingerprint) throw new RuntimeDeliveryError('not_sent', 'runtime_endpoint_replaced', 'The runtime endpoint changed. Explicitly attach the intended runtime again.');
    } catch (error) { throw endpointFailure(error); }
  }

  async checkTarget(): Promise<RuntimeTargetState> {
    if (!this.initialized || this.socket?.readyState !== WebSocket.OPEN) throw new RuntimeDeliveryError('not_sent', 'runtime_disconnected', 'The attached runtime is disconnected.');
    this.checkSocket();
    let cursor: string | undefined, loaded = false;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const result = object(await this.rpc('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) }));
      if (!Array.isArray(result?.data) || !result.data.every(id => typeof id === 'string')) throw new RuntimeDeliveryError('not_sent', 'runtime_protocol_invalid', 'The runtime returned an invalid loaded-thread list.');
      if (result.data.includes(this.options.threadId)) { loaded = true; break; }
      if (result.nextCursor === null || result.nextCursor === undefined) break;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || seen.has(result.nextCursor) || page === 99) throw new RuntimeDeliveryError('not_sent', 'runtime_protocol_invalid', 'The runtime loaded-thread pagination could not be completed.');
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    if (!loaded) { this.target = { loaded: false, status: 'unknown' }; this.state('unavailable'); return { ...this.target }; }
    const revision = this.targetRevision;
    const thread = object(object(await this.rpc('thread/read', { threadId: this.options.threadId, includeTurns: false }))?.thread);
    if (thread?.id !== this.options.threadId) throw new RuntimeDeliveryError('not_sent', 'runtime_thread_mismatch', 'The runtime returned another thread.');
    this.checkSocket();
    // A notification received during the read is newer than its snapshot.
    if (revision === this.targetRevision) this.target = { loaded: object(thread.status)?.type !== 'notLoaded', status: targetStatus(thread.status) };
    this.state(this.target.loaded ? this.target.status === 'idle' ? 'ready' : this.target.status === 'active' ? 'busy' : 'unavailable' : 'unavailable');
    return { ...this.target };
  }

  startUserInput(input: { text: string; messageId: string }): Promise<{ turnId: string }> {
    // This path has no async preflight: after the caller's sending CAS, send is
    // invoked before returning. Loaded/status checks belong to checkTarget().
    try {
      this.checkSocket();
      if (!this.initialized || this.socket?.readyState !== WebSocket.OPEN) throw new RuntimeDeliveryError('not_sent', 'runtime_disconnected', 'The attached runtime is disconnected.');
      if (!this.target.loaded || this.target.status !== 'idle') throw new RuntimeDeliveryError('not_sent', this.target.status === 'active' ? 'runtime_busy' : 'runtime_thread_unavailable', 'Wait until the original runtime thread is idle.');
      if (!input.text.trim() || !input.messageId.trim()) throw new RuntimeDeliveryError('not_sent', 'runtime_input_invalid', 'Provide the saved request and its message ID.');
      // clientUserMessageId is correlation metadata, not a deduplication promise.
      const revision = this.targetRevision;
      const response = this.rpc('turn/start', { threadId: this.options.threadId, clientUserMessageId: input.messageId, input: [{ type: 'text', text: input.text }] }, true);
      this.target = { loaded: true, status: 'active' }; this.state('busy');
      return response.then(value => {
        const turn = object(object(value)?.turn);
        if (typeof turn?.id !== 'string' || !turn.id) throw new RuntimeDeliveryError('unknown', 'runtime_response_invalid', 'The runtime did not return a verifiable turn ID.');
        if (revision === this.targetRevision) { this.target = { loaded: true, status: 'active' }; this.targetRevision++; this.state('busy'); }
        return { turnId: turn.id };
      });
    } catch (error) { return Promise.reject(endpointFailure(error)); }
  }

  private rpc(method: string, params: unknown, delivery = false): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (this.closed || !socket || socket.readyState !== WebSocket.OPEN) { reject(new RuntimeDeliveryError('not_sent', 'runtime_disconnected', 'The attached runtime is disconnected.')); return; }
      const id = ++this.counter;
      const pending: PendingRpc = { delivery, written: false, resolve, reject, timer: setTimeout(() => { this.pending.delete(id); reject(new RuntimeDeliveryError(delivery && pending.written ? 'unknown' : 'not_sent', 'runtime_timeout', 'The runtime response timed out.')); }, this.timeout) };
      this.pending.set(id, pending);
      try {
        const bytes = JSON.stringify({ id, method, params });
        pending.written = true;
        socket.send(bytes, error => { if (!error || !this.pending.delete(id)) return; clearTimeout(pending.timer); reject(new RuntimeDeliveryError(delivery ? 'unknown' : 'not_sent', 'runtime_write_failed', 'The runtime connection could not confirm the write.')); });
      } catch { this.pending.delete(id); clearTimeout(pending.timer); reject(new RuntimeDeliveryError(delivery && pending.written ? 'unknown' : 'not_sent', 'runtime_write_failed', 'The runtime connection could not confirm the write.')); }
    });
  }

  private message(bytes: string, binary: boolean): void {
    let message: Record<string, unknown> | undefined;
    try { if (binary) throw new Error(); message = object(JSON.parse(bytes)); } catch { this.socket?.terminate(); this.disconnected(); return; }
    if (!message) { this.socket?.terminate(); this.disconnected(); return; }
    if (typeof message.id === 'number' && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (Object.hasOwn(message, 'error')) {
        const error = object(message.error), rejected = typeof error?.code === 'number' && [-32700, -32600, -32601, -32602].includes(error.code);
        pending.reject(new RuntimeDeliveryError(pending.delivery ? rejected ? 'rejected' : 'unknown' : 'not_sent', 'runtime_rpc_error', 'The runtime rejected or could not confirm the request.'));
      } else pending.resolve(message.result);
      return;
    }
    const params = object(message.params);
    if (params?.threadId !== this.options.threadId) return;
    if (Object.hasOwn(message, 'id')) {
      if (typeof message.method === 'string' && message.method.endsWith('/requestApproval') && (typeof message.id === 'number' || typeof message.id === 'string')) {
        try { this.options.onApprovalRequest?.({ method: message.method, requestId: message.id, threadId: this.options.threadId }); } catch { /* Approval decisions remain with the original host. */ }
      }
      return; // This client never sends any server-request response.
    }
    if (message.method === 'thread/status/changed') { this.target = { loaded: object(params.status)?.type !== 'notLoaded', status: targetStatus(params.status) }; }
    else if (message.method === 'turn/started') this.target = { loaded: true, status: 'active' };
    else if (message.method === 'turn/completed' && this.target.status !== 'idle') this.target = { loaded: true, status: 'unknown' }; // Await explicit idle status/read.
    else if (message.method === 'turn/completed') { /* Preserve the preceding explicit idle status. */ }
    else return;
    this.targetRevision++;
    this.state(this.target.status === 'idle' ? 'ready' : this.target.status === 'active' ? 'busy' : 'unavailable');
  }

  private disconnected(): void {
    this.initialized = false; this.target = { loaded: false, status: 'unknown' };
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RuntimeDeliveryError(pending.delivery && pending.written ? 'unknown' : 'not_sent', 'runtime_disconnected', 'The attached runtime disconnected.')); }
    this.pending.clear(); this.state('disconnected');
  }
  close(): void { this.closed = true; this.disconnected(); this.socket?.terminate(); }
}
