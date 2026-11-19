// BIOSMAN preload: exposes a minimal, read-only bridge to the page as
// window.biosmanPC. The page (index.html) stays a plain web app; when it
// runs outside this shell the bridge is simply absent and the USB /
// update-check features hide themselves.
//
// API (all functions return promises):
//   collectLocal()     -> collector text or null (Windows only).
//   scanUSB()          -> { files: [{ drive, path, name, size, mtime }], error: string|null }
//                         files is [] (with error null) when no removable
//                         drive is present; error explains failures.
//   fetchText(url)     -> { ok, status, text, error }
//                         HTTPS GET done in the main process (no CORS).
//   notify(title, body)-> { ok, error }
//                         Shows an OS notification; never throws.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('biosmanPC', {
  ...(process.platform === 'win32' ? { collectLocal: () => ipcRenderer.invoke('biosman:collectLocal') } : {}),
  scanUSB: () => ipcRenderer.invoke('biosman:scanUSB'),
  fetchText: (url) => ipcRenderer.invoke('biosman:fetchText', String(url)),
  notify: (title, body) => ipcRenderer.invoke('biosman:notify', {
    title: String(title == null ? '' : title),
    body: String(body == null ? '' : body),
  }),
});
