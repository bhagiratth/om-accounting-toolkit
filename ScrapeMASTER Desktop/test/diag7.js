'use strict';
/* Live end-to-end check of scraper/maps-page.js: open a Maps search, open N cards one by one with real mouse clicks,
 * read each detail panel, close it, scroll for more. Prints timings and what was read.
 *   npx electron . --diag7 --q="dentist in Dubai" --n=10 --out=C:\path\dump7.json */
const fs = require('fs');
const mp = require('../scraper/maps-page');
const arg = (n, d) => { const m = process.argv.find(a => a.startsWith('--' + n + '=')); return m ? m.slice(n.length + 3) : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run({ BrowserWindow, WebContentsView, googleSession }) {
  googleSession();
  const win = new BrowserWindow({ show: true, width: 1400, height: 900 });
  const view = new WebContentsView({ webPreferences: { partition: 'persist:scrapemaster-google', sandbox: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1400, height: 860 });
  const wc = view.webContents;
  const call = (fn, ...args) => wc.executeJavaScript('(' + fn.toString() + ')(' + args.map(a => JSON.stringify(a)).join(',') + ')').catch(e => ({ error: String(e) }));
  const click = pt => {
    wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
    wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  };
  const out = { places: [], log: [] };
  const N = parseInt(arg('n', '10'), 10);
  await wc.loadURL('https://www.google.com/maps/search/' + encodeURIComponent(arg('q', 'dentist in Dubai')) + '?hl=en').catch(() => {});
  let list;
  for (let i = 0; i < 25; i++) { list = await call(mp.mapsList); if (list.feed && list.count) break; await sleep(600); }
  out.log.push('first list: ' + list.count + ' cards, sorry=' + list.sorry + ', consent=' + list.consent);
  let done = 0;
  while (done < N) {
    list = await call(mp.mapsList);
    if (done >= list.count) {
      const before = list.count;
      await call(mp.mapsScrollFeed); await sleep(2200);
      const after = (await call(mp.mapsList)).count;
      out.log.push('scrolled: ' + before + ' -> ' + after);
      if (after <= before) break;
      continue;
    }
    const card = list.cards[done];
    const t0 = Date.now();
    await sleep(250);
    const pt = await call(mp.mapsCardPoint, done);
    if (!pt) { out.log.push('no point for card ' + done); done++; continue; }
    click(pt);
    let ready = false;
    for (let i = 0; i < 30; i++) { await sleep(250); if (await call(mp.mapsDetailReady, card.label)) { ready = true; break; } }
    const readMs = Date.now() - t0;
    const d = await call(mp.mapsReadDetail);
    const cp = await call(mp.mapsClosePoint);
    let closed = false;
    if (cp) {
      click(cp);
      for (let i = 0; i < 16; i++) { await sleep(250); const l = await call(mp.mapsList); if (!l.detailOpen) { closed = true; break; } }
    }
    out.places.push(Object.assign({ idx: done, ready, readMs, closed, hasClose: !!cp }, mp.parseMapsHref(card.href), d));
    done++;
  }
  fs.writeFileSync(arg('out', 'dump7.json'), JSON.stringify(out, null, 2));
  console.log('DIAG7 written');
  return 0;
}
module.exports = { run };
