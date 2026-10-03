'use strict';
/* ScrapeMASTER desktop - Electron main process.
 * Window = the control UI (renderer/) on the left + a live Google pane (WebContentsView) on the right.
 * The engine drives the pane exactly like the extension drives a tab; you can see Google, solve a
 * CAPTCHA, or sign in to Google in it. The pane uses its own persistent profile, so cookies stay.
 */
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, session, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { Engine } = require('./engine/engine');
const { Store } = require('./engine/store');
const { ViewDriver } = require('./driver');
const { parseTsk } = require('./engine/tsk');

const SMOKE = process.argv.includes('--smoke');
const REAL = process.argv.includes('--real');
const PARTITION = 'persist:scrapemaster-google';

let win = null, view = null, engine = null, store = null;
let paneVisible = false;                  // the Google pane only appears when needed (CAPTCHA) or on request
let lastBounds = { x: 0, y: 0, width: 0, height: 0 };

function googleSession() {
  const ses = session.fromPartition(PARTITION);
  // Present a normal Chrome identity (no "Electron/x" or app token in the user agent).
  const ua = ses.getUserAgent().replace(/\s(Electron|ScrapeMASTER|scrapemaster-desktop)\/\S+/gi, '');
  ses.setUserAgent(ua, 'en-IN,en;q=0.9');
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));   // no location / notifications / camera prompts
  ses.on('will-download', e => e.preventDefault());
  return ses;
}

const HIDDEN_VIEWPORT = { x: 0, y: 0, width: 1280, height: 860 };   // the pane's size while it is not on screen

function applyBounds() {
  if (!view) return;
  const b = lastBounds;
  const show = paneVisible && b.width > 10 && b.height > 10;
  if (show) {
    view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
    view.setVisible(true);
  } else {
    view.setBounds(HIDDEN_VIEWPORT);          // keep a normal-sized page so Google lays out the same list
    view.setVisible(false);
  }
}

function createView() {
  view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.setBackgroundThrottling(false);   // the scraper keeps running while the pane is hidden
  return view;
}

function createEngine(opts = {}) {
  const dataDir = path.join(app.getPath('userData'), 'runs');
  store = new Store(dataDir);
  const driver = new ViewDriver(view.webContents);
  engine = new Engine({
    driver, store, outputDir: path.join(app.getPath('documents'), 'ScrapeMASTER Leads'),
    base: opts.base, profiles: opts.profiles
  });
  engine.on('state', s => { if (win && !win.isDestroyed()) win.webContents.send('state', s); });
  return engine;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 1000, minHeight: 640, title: 'ScrapeMASTER', backgroundColor: '#0e0f1d',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  win.setMenuBarVisibility(false);
  googleSession();
  win.contentView.addChildView(createView());
  createEngine();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  view.webContents.loadURL('https://www.google.com/').catch(() => {});
  win.on('resize', applyBounds);
  if (process.env.SM_DEBUG) {
    const log = (...x) => console.log('[dbg]', ...x);
    win.webContents.on('did-finish-load', () => log('ui loaded'));
    win.webContents.on('did-fail-load', (_e, code, desc, url) => log('ui FAILED', code, desc, url));
    win.webContents.on('console-message', (e) => log('ui console', e.level, e.message));
    win.webContents.on('preload-error', (_e, p, err) => log('preload error', p, err && err.message));
    view.webContents.on('did-finish-load', () => log('pane loaded', view.webContents.getURL()));
    view.webContents.on('did-fail-load', (_e, code, desc, url) => log('pane FAILED', code, desc, url));
    ipcMain.on('pane:bounds', (_e, r) => log('bounds', JSON.stringify(r)));
    setTimeout(() => log('view bounds', JSON.stringify(view.getBounds()), 'visible', view.getVisible && view.getVisible()), 5000);
  }
  win.on('close', () => { if (store) store.flush(); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.key === 'F12' && input.type === 'keyDown' && !app.isPackaged) win.webContents.openDevTools({ mode: 'detach' });
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

// ------------------------------------------------------------------ IPC
ipcMain.on('pane:bounds', (_e, rect) => {
  if (rect && Number.isFinite(rect.x)) { lastBounds = rect; applyBounds(); }
});

ipcMain.handle('api', async (_e, type, p) => {
  try {
    switch (type) {
      case 'getState': return { ok: true, state: engine.getState() };
      case 'leads': return Object.assign({ ok: true }, engine.leadsView(p && p.limit));
      case 'columns': return engine.setColumns(Array.isArray(p) ? p : []);
      case 'tasks:load': {
        const r = await dialog.showOpenDialog(win, {
          properties: ['openFile'], defaultPath: app.getPath('downloads'),
          filters: [{ name: 'Task files', extensions: ['tsk', 'txt', 'csv'] }, { name: 'All files', extensions: ['*'] }]
        });
        if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
        const file = r.filePaths[0];
        if (fs.statSync(file).size > 8 * 1024 * 1024) return { ok: false, error: 'That file is too large for a task file (over 8 MB).' };
        let text = fs.readFileSync(file);
        text = text.length > 1 && text[0] === 0xFF && text[1] === 0xFE ? text.toString('utf16le') : text.toString('utf8');
        const t = parseTsk(text);
        if (!t.tasks.length) return { ok: false, error: 'No usable tasks in that file. Expected lines like  id|category|location|country|state|city|1000' };
        return { ok: true, name: path.basename(file), tasks: t.tasks.slice(0, 20000), skipped: t.skipped, count: Math.min(t.tasks.length, 20000) };
      }
      case 'start': return engine.start(p || {});
      case 'stop': return engine.stop();
      case 'resume': return engine.resume();
      case 'continue': return engine.continueRun();
      case 'export': {
        if (!engine.job.leads.length) return { ok: false, error: 'Nothing to export yet.' };
        const { filename, text } = engine.csv();
        const r = await dialog.showSaveDialog(win, {
          defaultPath: path.join(app.getPath('documents'), filename), filters: [{ name: 'CSV', extensions: ['csv'] }]
        });
        if (r.canceled || !r.filePath) return { ok: true, canceled: true };
        fs.writeFileSync(r.filePath, '﻿' + text, 'utf8');
        return { ok: true, path: r.filePath };
      }
      case 'openFile': {
        const f = engine.job.savedPath;
        if (f && fs.existsSync(f)) shell.showItemInFolder(f);
        return { ok: !!f };
      }
      case 'runs:list': return { ok: true, runs: store.list() };
      case 'runs:open': {
        store.flush();
        const r = engine.loadJob(store.load(String(p)));
        return r;
      }
      case 'runs:delete': {
        if (engine.job.id === String(p) && (engine.job.status === 'running' || engine.job.status === 'blocked')) return { ok: false, error: 'Stop the run first.' };
        store.remove(String(p));
        return { ok: true };
      }
      case 'pane:signin': view.webContents.loadURL('https://accounts.google.com/').catch(() => {}); return { ok: true };
      case 'pane:home': view.webContents.loadURL('https://www.google.com/').catch(() => {}); return { ok: true };
      case 'pane:reload': view.webContents.reload(); return { ok: true };
      case 'pane:visible': paneVisible = !!p; applyBounds(); return { ok: true };
      default: return { ok: false, error: 'Unknown command' };
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

// ------------------------------------------------------------ app life-cycle
if (!SMOKE && !REAL && !process.argv.includes('--diag') && !process.argv.includes('--diag2') && !process.argv.includes('--diag3') && !process.argv.includes('--diag4') && !process.argv.includes('--diag5') && !process.argv.includes('--diag6') && !process.argv.includes('--diag7') && !process.argv.includes('--diag8') && !process.argv.includes('--diag9') && !process.argv.includes('--diag10') && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    if (SMOKE) {
      const code = await require('./test/smoke').run({ app, BrowserWindow, WebContentsView, Engine, ViewDriver, Store, googleSession });
      app.exit(code);
      return;
    }
    if (process.argv.includes('--diag10')) {
      const code = await require('./test/diag10').run({ BrowserWindow, WebContentsView, googleSession });
      app.exit(code);
      return;
    }
    if (process.argv.includes('--diag9')) {
      const code = await require('./test/diag9').run({ BrowserWindow, WebContentsView, googleSession });
      app.exit(code);
      return;
    }
    if (process.argv.includes('--diag8')) {
      const code = await require('./test/diag8').run({ BrowserWindow, WebContentsView, googleSession });
      app.exit(code);
      return;
    }
    if (process.argv.includes('--diag7')) {
      const code = await require('./test/diag7').run({ BrowserWindow, WebContentsView, googleSession });
      app.exit(code);
      return;
    }
    if (process.argv.includes('--diag6')) {
      const code = await require('./test/diag6').run({ BrowserWindow, WebContentsView, googleSession });
      app.exit(code);
      return;
    }
    if (process.argv.includes('--diag5')) {
      const code = await require('./test/diag5').run({ BrowserWindow, WebContentsView, googleSession });
      app.exit(code);
      return;
    }
    if (process.argv.includes('--diag4')) {
      const code = await require('./test/diag4').run({ BrowserWindow, WebContentsView, googleSession });
      app.exit(code);
      return;
    }
    if (process.argv.includes('--diag3')) {
      const code = await require('./test/diag3').run({ BrowserWindow, WebContentsView, googleSession });
      app.exit(code);
      return;
    }
    if (process.argv.includes('--diag2')) {
      const code = await require('./test/diag2').run({ BrowserWindow, WebContentsView, googleSession });
      app.exit(code);
      return;
    }
    if (process.argv.includes('--diag')) {
      const code = await require('./test/diag').run({ BrowserWindow, WebContentsView, googleSession });
      app.exit(code);
      return;
    }
    if (REAL) {
      const code = await require('./test/real').run({ app, BrowserWindow, WebContentsView, Engine, ViewDriver, Store, googleSession });
      app.exit(code);
      return;
    }
    if (app.isPackaged) Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('before-quit', () => { if (store) store.flush(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
