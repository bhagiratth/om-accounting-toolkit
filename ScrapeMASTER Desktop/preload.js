'use strict';
// The only bridge between the UI and the app. The UI can call a fixed list of commands; it gets no Node access.
const { contextBridge, ipcRenderer } = require('electron');

const COMMANDS = new Set([
  'getState', 'leads', 'columns', 'tasks:load', 'start', 'stop', 'resume', 'continue', 'export', 'openFile',
  'runs:list', 'runs:open', 'runs:delete',
  'pane:signin', 'pane:reload', 'pane:home', 'pane:visible'
]);

contextBridge.exposeInMainWorld('api', {
  invoke(type, payload) {
    if (!COMMANDS.has(type)) return Promise.resolve({ ok: false, error: 'Unknown command' });
    return ipcRenderer.invoke('api', type, payload);
  },
  onState(cb) { ipcRenderer.on('state', (_e, s) => cb(s)); },
  paneBounds(rect) { ipcRenderer.send('pane:bounds', rect); }
});
