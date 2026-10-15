const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const root = process.env.SHOWCASE_WORKSPACE;
app.setPath('userData', path.join(root, 'electron-user-data'));
app.setName('Acanvas Showcase');
const url = process.env.SHOWCASE_RENDERER_URL;
const canvas = process.env.SHOWCASE_CANVAS_URL;
const canvasEndpoint = new URL(canvas);
const canvasWebSocketOrigin = `${canvasEndpoint.protocol === 'https:' ? 'wss:' : 'ws:'}//${canvasEndpoint.host}`;
const allowedOrigins = new Set([new URL(url).origin, canvasEndpoint.origin, canvasWebSocketOrigin, ...process.env.SHOWCASE_PREVIEW_ORIGIN ? [process.env.SHOWCASE_PREVIEW_ORIGIN] : []]);
function isolate(s) {
    s.webRequest.onErrorOccurred(details => fs.appendFileSync(path.join(root, 'electron-log.jsonl'), JSON.stringify({ type: 'request-error', url: details.url, error: details.error }) + '\n'));
    s.webRequest.onBeforeRequest((details, done) => {
        const u = new URL(details.url);
        done({ cancel: !['about:', 'data:', 'blob:', 'devtools:'].includes(u.protocol) && !allowedOrigins.has(u.origin) });
    });
    s.setPermissionRequestHandler((w, p, done) => done(false));
}
app.whenReady().then(() => {
    isolate(session.defaultSession);
    const browserPages = new Map();
    const browserIdentities = new Map();
    const pageKey = identity => `${identity.conversationId}\0${identity.browserTabId}`;
    const win = new BrowserWindow({ width: 1680, height: 1000, titleBarStyle: 'hiddenInset', vibrancy: 'menu', acceptFirstMouse: true, title: 'Slow Signal — Acanvas Showcase', show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: true, preload: path.join(root, 'native-preload.cjs') } });
    ipcMain.handle('showcase:browser-reload', (event, identity) => {
        if (event.sender !== win.webContents) throw Error('Reload belongs to the showcase renderer.');
        const page = browserPages.get(pageKey(identity));
        if (page == null || page.isDestroyed()) throw Error('The showcase browser page is closed.');
        page.reload();
        fs.appendFileSync(path.join(root, 'electron-log.jsonl'), JSON.stringify({ type: 'browser-reload', browserTabId: identity.browserTabId }) + '\n');
        return true;
    });
    win.webContents.on('page-title-updated', e => { e.preventDefault(); win.setTitle('Slow Signal — Acanvas Showcase'); });
    win.webContents.on('will-attach-webview', (event, preferences, params) => {
        if (!params.partition.startsWith('persist:codex-browser-app-route:')) {
            event.preventDefault();
            return;
        }
        const route = params.partition.slice('persist:codex-browser-app-route:'.length).split(':host:')[0];
        const [conversationId, browserTabId] = decodeURIComponent(route).split('\0');
        browserIdentities.set(session.fromPartition(params.partition), { conversationId, browserTabId });
        preferences.nodeIntegration = false;
        preferences.contextIsolation = true;
        preferences.sandbox = true;
        delete preferences.preload;
        params.src = canvas;
    });
    win.webContents.on('did-attach-webview', (_, guest) => {
        const identity = browserIdentities.get(guest.session);
        const key = pageKey(identity);
        browserPages.set(key, guest);
        guest.on('destroyed', () => { if (browserPages.get(key) === guest) browserPages.delete(key); });
        isolate(guest.session);
        guest.on('will-navigate', (e, u) => { if (new URL(u).origin !== new URL(canvas).origin) e.preventDefault(); });
        guest.on('did-finish-load', () => fs.appendFileSync(path.join(root, 'electron-log.jsonl'), JSON.stringify({ type: 'canvas-loaded', url: guest.getURL() }) + '\n'));
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('console-message', (event) => fs.appendFileSync(path.join(root, 'electron-log.jsonl'), JSON.stringify({ level: event.level, message: event.message }) + '\n'));
    win.on('closed', () => app.quit());
    win.loadURL(url);
});
