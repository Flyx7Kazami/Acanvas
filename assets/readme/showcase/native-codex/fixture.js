const nativeFetch = window.fetch.bind(window);
let previousBoundary = '';
const log = (type, data) => {
    if (type === 'message' && data.type === 'log-message' && data.level !== 'error')
        return;
    if (type === 'render-boundaries') {
        const value = JSON.stringify(data);
        if (value === previousBoundary)
            return;
        previousBoundary = value;
    }
    if (type === 'http')
        data = { id: data.id, request: { url: data.request.url, method: data.request.method } };
    nativeFetch('/fixture-log', { method: 'POST', body: JSON.stringify({ type, data }, (k, v) => typeof v === 'function' ? '[function]' : v) }).catch(() => { });
};
const config = await nativeFetch('/fixture-config.json').then(response => response.json());
window.fetch = (url, options) => { const u = new URL(typeof url === 'string' ? url : url.url, location.href); if (u.origin !== location.origin) {
    log('blocked-fetch', { url: u.href });
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
} return nativeFetch(url, options); };
window.addEventListener('error', e => log('error', { message: e.message, stack: e.error?.stack }));
window.addEventListener('unhandledrejection', e => log('rejection', { message: String(e.reason), stack: e.reason?.stack }));
const thread = { id: 'showcase-slow-signal', preview: 'Build a visual world for Slow Signal.', name: 'Create Slow Signal campaign', modelProvider: 'openai', createdAt: 1791993600, updatedAt: 1791993600, path: '/synthetic/slow-signal/session.jsonl', cwd: '/synthetic/slow-signal', cliVersion: '0.162.0', source: 'cli', status: { type: 'idle' }, turns: [] };
thread.turns = [{ id: 'showcase-turn-1', status: 'completed', error: null, items: [
            { type: 'userMessage', id: 'showcase-user-1', content: [{ type: 'text', text_elements: [], text: 'Explore a geometric direction for Slow Signal. Give me four mobile app studies to compare, and sound sketches with matching cover art.' }] },
            { type: 'agentMessage', id: 'showcase-agent-1', text: 'I’ve put the directions on Acanvas.\n\n• Geometric posters in varied color palettes.\n• Four mobile app studies, side by side.\n• Two sound sketches with matching cover art.\n\nThe folder keeps the extra references together.' },
            { type: 'userMessage', id: 'showcase-user-2', content: [{ type: 'text', text_elements: [], text: 'Keep the geometric style. I want to compare the screens before choosing one.' }] },
            { type: 'agentMessage', id: 'showcase-agent-2', text: 'The four studies are ready on the right. Pick a screen or mark a region, and we can refine that direction together.' }
        ] }];
const firstTurn = thread.turns[0];
thread.turns = [{ ...firstTurn, items: firstTurn.items.slice(0, 2) }, { ...firstTurn, id: 'showcase-turn-2', items: firstTurn.items.slice(2) }];
const syntheticSettings = { conversationDetailMode: 'STEPS_COMMANDS', sansFontSize: 14, codeFontSize: 13 };
const syntheticState = { 'sidebar-width': 240, 'app-shell:right-panel-width:v3': 0.8541251042535446, 'browser-sidebar-comment-mode-coachmark-dismissed': true, 'home-composer-mode-v1': 'work', 'electron:onboarding-welcome-v2-role-state': { roles: ['engineering'], personalizedSuggestionsEnabled: false, workMode: 'coding' }, 'electron:onboarding-projectless-completed': true, 'electron:onboarding-hide-first-new-thread-promos': true, last_completed_onboarding: 1791993600 };
const canvasUrl = config.canvasUrl;
let browserOpened = false;
const browserSnapshot = () => ({ tabType: 'web', url: canvasUrl, committedUrl: canvasUrl, pageTitle: 'Slow Signal — Acanvas', title: 'Slow Signal — Acanvas', faviconUrl: null, isLoading: false, isWaitingForResponse: false, isAudible: false, isAudioMuted: false, isCapturingUserMedia: false, isCapturingCamera: false, isCapturingMicrophone: false, canGoBack: false, canGoForward: false, zoomPercent: 100, commentModeDisabledReason: null, interactionMode: 'browse', annotationFlow: 'batch', comments: [], securityState: null });
const emit = data => window.postMessage(data, location.origin);
async function boundary(message) {
    log('message', message);
    if (message.type === 'ready') {
        emit({ type: 'codex-app-server-initialized', hostId: 'local', appServerVersion: '0.162.0', installedCodexVersion: '0.162.0', transport: 'stdio', isSnapshot: true });
        emit({ type: 'codex-app-server-connection-changed', hostId: 'local', state: 'connected', transport: 'stdio' });
        emit({ type: 'navigate-to-route', path: '/local/showcase-slow-signal' });
    }
    if (message.type === 'electron-window-focus-request')
        emit({ type: 'electron-window-focus-changed', isFocused: true });
    if (message.type === 'persisted-atom-sync-request')
        emit({ type: 'persisted-atom-sync', state: syntheticState, canWritePrimaryWindowTabPersistence: true });
    if (message.type === 'persisted-atom-update') {
        syntheticState[message.key] = message.value;
    }
    if (message.type === 'fetch') {
        const path = new URL(message.url).pathname;
        let body = {};
        if (path === '/get-global-state')
            body = { value: null };
        if (path === '/inbox-items')
            body = { items: [], unreadRunCounts: { unreadRuns: [], total: 0 } };
        if (path === '/list-pinned-threads')
            body = { threadIds: [], serverOrderedThreadIds: [] };
        if (path === '/list-automations')
            body = { items: [] };
        if (path === '/workspace-root-options')
            body = { roots: [] };
        if (path === '/locale-info')
            body = { locale: 'en-US', timezone: 'UTC' };
        if (path === '/codex-command-keymap-state')
            body = { bindings: [], commands: [] };
        if (path === '/get-settings')
            body = { values: syntheticSettings, configuredValues: syntheticSettings };
        if (path === '/set-setting') {
            const value = JSON.parse(message.body);
            syntheticSettings[value.key] = value.value;
            body = { success: true };
        }
        if (path === '/os-info')
            body = { os: 'macos', platform: 'darwin', arch: 'arm64' };
        if (path === '/codex-home')
            body = { codexHome: '/synthetic/.codex', path: '/synthetic/.codex' };
        if (path === '/is-copilot-api-available')
            body = { available: false };
        emit({ type: 'fetch-response', requestId: message.requestId, responseType: 'success', status: 200, headers: {}, body });
    }
    if (message.type === 'browser-sidebar-command' && message.command?.type === 'navigate')
        emit({ type: 'browser-sidebar-state', conversationId: message.conversationId, browserTabId: message.browserTabId, snapshot: browserSnapshot() });
    if (message.type === 'browser-sidebar-command' && message.command?.type === 'reload')
        return window.showcaseNativeBrowser.reload({ conversationId: message.conversationId, browserTabId: message.browserTabId });
    if (message.type === 'mcp-request') {
        const { id, method } = message.request;
        let result = method.endsWith('/list') ? { data: [], nextCursor: null } : {};
        if (method === 'config/read')
            result = { config: { model: 'gpt-6.1-sol', model_provider: 'openai', model_reasoning_effort: 'medium', approval_policy: 'on-request', sandbox_mode: 'workspace-write' }, origins: {}, layers: [] };
        if (method === 'remoteControl/status/read')
            result = { status: 'disabled' };
        if (method === 'thread/list')
            result = { data: message.hostId === 'durable' || message.request.params?.ancestorThreadId ? [] : [thread], nextCursor: null };
        if (method === 'thread/attachment/list' || method === 'collaborationMode/list' || method === 'permissionProfile/list' || method === 'experimentalFeature/list' || method === 'mcpServerStatus/list')
            result = { data: [], nextCursor: null };
        if (method === 'thread/read')
            result = { thread };
        if (method === 'thread/resume')
            result = { thread, model: 'gpt-6.1-sol', modelProvider: 'openai', cwd: thread.cwd, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [thread.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: 'medium' };
        if (method === 'thread/turns/list')
            result = { data: (message.request.params?.sortDirection === 'desc' ? [...thread.turns].reverse() : thread.turns).map(t => ({ ...t, itemsView: 'full' })), nextCursor: null };
        if (method === 'thread/items/list') {
            let items = thread.turns.filter(t => !message.request.params?.turnId || t.id === message.request.params.turnId).flatMap(t => t.items.map(item => ({ turnId: t.id, item, completedAtMs: 1791993600000 })));
            result = { data: message.request.params?.sortDirection === 'desc' ? items.reverse() : items, nextCursor: null };
        }
        if (method === 'model/list')
            result = { data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', description: '', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }], defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], supportsPersonality: true }], nextCursor: null };
        if (method === 'configRequirements/read')
            result = { requirements: null };
        if (method === 'fs/readFile')
            result = { data: 'e30=', encoding: 'base64' };
        if (method === 'account/read')
            result = { account: { type: 'apiKey' }, requiresOpenaiAuth: false };
        if (method === 'getAuthStatus')
            result = { authMethod: 'apikey', requiresOpenaiAuth: false };
        emit({ type: 'mcp-response', hostId: message.hostId, message: { id, result } });
        if (method === 'thread/resume' && !browserOpened) {
            browserOpened = true;
            setTimeout(() => emit({ type: 'toggle-browser-panel', conversationId: thread.id, browserTabId: 'showcase-acanvas', open: true, url: canvasUrl, source: 'manual', initiator: 'toggle_browser_command' }), 500);
        }
    }
}
const workerListeners = new Map();
window.codexWindowType = 'electron';
window.electronBridge = { windowType: 'electron', getBuildFlavor: () => 'prod', getSystemThemeVariant: () => 'light', subscribeToSystemThemeVariant: () => () => { }, getPreloadStartedAtMs: () => performance.timeOrigin, getSentryInitOptions: () => ({ appVersion: config.applicationVersion, buildFlavor: 'prod', desktopTraceSampleRate: 0, initialDesktopTraceSampleRate: 0, codexAppSessionId: 'showcase-synthetic' }), getDesktopUserAgent: () => `Codex Desktop/${config.applicationVersion} (Mac OS; arm64)`, getAppSessionId: () => 'showcase-synthetic', isDeviceCheckSupported: () => false, isIntelMacBuild: () => false, getSharedObjectSnapshotValue: key => { log('shared-read', key); return undefined; }, getInitialSidebarBootstrap: () => null, sendMessageFromView: boundary, sendWorkerMessageFromView: async (id, message) => { log('worker', { id, message }); if (message.type === 'worker-request')
        queueMicrotask(() => { const r = message.request; for (const listener of workerListeners.get(id) ?? [])
            listener({ type: 'worker-response', workerId: id, response: { id: r.id, method: r.method, result: { type: 'ok', value: r.method === 'availability' ? { available: false } : null } } }); }); }, subscribeToWorkerMessages: (id, listener) => { let set = workerListeners.get(id); if (!set)
        workerListeners.set(id, set = new Set()); set.add(listener); return () => set.delete(listener); }, acknowledgeChunkedMessage: () => { } };
document.documentElement.dataset.theme = 'light';
const shared = await import(config.sharedModule);
shared[config.rpc.initialize]();
const Target = shared[config.rpc.target];
const disposable = () => new class extends Target {
    [Symbol.dispose]() { }
};
function service(name) { return new Proxy(new Target, { get(target, key) { if (key === Symbol.dispose)
        return () => { }; if (typeof key === 'symbol')
        return target[key]; if (key === 'then')
        return undefined; return (...args) => { log('rpc', { name, key, args }); if (key === 'whenReady')
        return {}; if (key === 'subscribe' || key === 'unsubscribe')
        return disposable(); if (key.startsWith('list'))
        return []; if (key === 'getOrCreateStableId')
        return 'showcase-synthetic'; return null; }; } }); }
window.addEventListener('message', e => {
    if (e.data?.type === 'connect-app-host') {
        const httpFetch = new class extends Target {
            fetch(id, request) {
                log('http', { id, request });
                let payload = {};
                if (request.url.includes('/initialize'))
                    payload = { feature_gates: {}, dynamic_configs: {}, layer_configs: {}, has_updates: true, time: Date.now() };
                const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); } });
                return { response: { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' }, body } };
            }
            cancel() { }
        };
        const browserHost = new Proxy(new Target, { get(target, key) {
                if (key === Symbol.dispose)
                    return () => { };
                if (typeof key === 'symbol')
                    return target[key];
                if (key === 'then')
                    return undefined;
                return (...args) => {
                    log('browser-host', { key, args });
                    if (key === 'registerWebviewHost') {
                        const page = args[0];
                        emit({ type: 'browser-sidebar-state', conversationId: page.conversationId, browserTabId: page.browserTabId, snapshot: browserSnapshot() });
                        return true;
                    }
                    if (key === 'registerWebviewHostSession' || key === 'syncView')
                        return true;
                    if (key === 'subscribeFavicon')
                        return disposable();
                    return null;
                };
            } });
        const services = { startup: service('startup'), clientCoordination: service('clientCoordination'), requestUserInputAutoResolution: service('requestUserInputAutoResolution'), httpFetch, browserHost };
        const host = new class extends Target {
            get services() { return services; }
        };
        const hostConnection = shared[config.rpc.connect](e.data.port, host);
        log('host-connected', Object.keys(services));
    }
});
history.replaceState(null, '', '/?initialRoute=/local/showcase-slow-signal');
await import(config.entryModule);
