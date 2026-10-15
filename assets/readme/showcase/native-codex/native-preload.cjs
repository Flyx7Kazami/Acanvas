const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('showcaseNativeBrowser', {
    reload: identity => ipcRenderer.invoke('showcase:browser-reload', identity),
});
