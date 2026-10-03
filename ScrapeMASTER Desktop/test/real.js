'use strict';
/* A small REAL run against live Google, with a visible window so a CAPTCHA can be solved by hand.
 *   npx electron . --real --kw="dentist" --place="Mumbai" --target=12 --emails [--speed=safe] [--out=C:\path]
 * Prints progress and the collected leads; exits when the run finishes (or after 8 minutes).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = (n, d) => { const m = process.argv.find(a => a.startsWith('--' + n + '=')); return m ? m.slice(n.length + 3) : d; };

async function run({ app, BrowserWindow, WebContentsView, Engine, ViewDriver, Store, googleSession }) {
  const out = arg('out', path.join(os.tmpdir(), 'sm-real-' + Date.now()));
  const kw = arg('kw', 'dentist'), place = arg('place', 'Mumbai');
  googleSession();
  const win = new BrowserWindow({ show: true, width: 1100, height: 820, title: 'ScrapeMASTER - real run' });
  const view = new WebContentsView({ webPreferences: { partition: 'persist:scrapemaster-google', sandbox: true } });
  win.contentView.addChildView(view);
  // --hidden = how the app really runs: the Google page is not on screen, at a normal viewport, never throttled
  if (process.argv.includes('--offscreen')) {
    // visible to Chromium (so JS-heavy pages like Maps render) but placed outside the window, so nobody sees it
    view.webContents.setBackgroundThrottling(false);
    view.setBounds({ x: parseInt(arg('offx', '-4000'), 10), y: 0, width: 1280, height: 860 });
    view.setVisible(true);
  } else if (process.argv.find(x => x.startsWith('--dock='))) {
    // docked on-screen panel of the given size, e.g. --dock=640x760 (right side of the window)
    const [dw, dh] = arg('dock', '640x760').split('x').map(Number);
    const [cw] = win.getContentSize();
    view.setBounds({ x: cw - dw, y: 0, width: dw, height: dh });
    view.setVisible(true);
  } else if (process.argv.includes('--covered')) {
    // full-size Maps view with another view on top of it (the app's UI would be that view)
    view.webContents.setBackgroundThrottling(false);
    view.setBounds({ x: 0, y: 0, width: 1280, height: 860 });
    view.setVisible(true);
    const cover = new WebContentsView({ webPreferences: { sandbox: true } });
    win.contentView.addChildView(cover);
    cover.setBounds({ x: 0, y: 0, width: 1400, height: 900 });
    cover.webContents.loadURL('data:text/html,<body style="background:%23123;color:white;font:20px sans-serif">covering the browser view</body>');
  } else if (process.argv.includes('--hidden')) {
    view.webContents.setBackgroundThrottling(false);
    view.setBounds({ x: 0, y: 0, width: 1280, height: 860 });
    view.setVisible(false);
  } else {
    const fit = () => { const [w, h] = win.getContentSize(); view.setBounds({ x: 0, y: 0, width: w, height: h }); };
    fit(); win.on('resize', fit);
  }

  const engine = new Engine({ driver: new ViewDriver(view.webContents), store: new Store(path.join(out, 'runs')), outputDir: path.join(out, 'csv') });
  let last = '';
  engine.on('state', s => {
    const line = `[${s.status}${s.blockedReason ? ':' + s.blockedReason : ''}] ${s.count} leads | ${s.message}`;
    if (line !== last) { console.log(line); last = line; }
  });
  let places = { mode: 'custom', list: place ? place.split(';').map(x => x.trim()).filter(Boolean) : [] };   // --place="Pune;Nashik"
  if (arg('tsk', '')) {                                  // --tsk=C:\path	ask.tsk --ntasks=2 : run lines of a real task file
    const parsed = require('../engine/tsk').parseTsk(fs.readFileSync(arg('tsk', ''), 'utf8'));
    places = { mode: 'tasks', tasks: parsed.tasks.slice(0, parseInt(arg('ntasks', '2'), 10)) };
    const per = parseInt(arg('per', '0'), 10);
    if (per > 0) places.tasks.forEach(t => { t.limit = per; });      // keep a test short: override the file's own limit
  }
  const r = engine.start({
    keywords: [kw], places, speed: arg('speed', 'safe'),
    target: parseInt(arg('target', '12'), 10), findEmails: process.argv.includes('--emails'), placeLabel: place,
    source: arg('source', 'finder'), perTask: parseInt(arg('per', '0'), 10),
    columns: process.argv.includes('--allcols') ? require('../engine/engine').COLUMNS.map(c => c.key) : undefined
  });
  if (!r.ok) { console.log('START FAILED', r.error); return 1; }

  const deadline = Date.now() + parseInt(arg('minutes', '8'), 10) * 60 * 1000;
  const t0 = Date.now();
  const beat = setInterval(() => {                      // a heartbeat every minute, so a long run can be followed
    const b = engine.getState(), mins = Math.round((Date.now() - t0) / 6000) / 10;
    console.log('HEARTBEAT ' + mins + ' min | ' + b.status + (b.blockedReason ? ':' + b.blockedReason : '') + ' | ' + b.count + ' businesses | searches done ' + b.tasksDone + ', queued ' + b.tasksLeft +
      ' | phones ' + b.withPhone + ' (mobile ' + b.withMobile + ') | emails ' + b.withEmail + ' | slow x' + (b.slow || 1).toFixed(1) + ' | ' + (b.phase || 'searching'));
  }, 60000);
  await new Promise(res => {
    const t = setInterval(() => {
      const s = engine.getState();
      if (s.status === 'done' || s.status === 'error' || Date.now() > deadline) { clearInterval(t); res(); }
    }, 1000);
  });
  clearInterval(beat);
  const s = engine.getState();
  console.log('\nFINAL', s.status, s.endReason, '-', s.message);
  console.log('leads', s.count, '| with website', engine.job.leads.filter(l => l.website).length, '| with email', engine.job.leads.filter(l => l.email).length,
    '| pages', engine.job.pagesScraped, '| skipped no-phone', engine.job.skippedNoPhone, '| duplicates', engine.job.duplicates);
  engine.job.leads.forEach(l => console.log('  ', l.name, '|', l.phone || 'Not found', '|', l.email || '-', '|', l.website || '-', '|', l.city, l.state, l.pincode));
  console.log('CSV:', s.savedPath || '(none)');
  if (s.status === 'running' || s.status === 'blocked') engine.stop();
  return s.status === 'done' ? 0 : 1;
}
module.exports = { run };
