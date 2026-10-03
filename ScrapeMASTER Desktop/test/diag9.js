'use strict';
/* Live check of the "collect links, then open each place by its URL" approach for Google Maps.
 *   npx electron . --diag9 --q="dentist in Dubai" --n=6 --collect=20 --out=C:\path\dump9.json */
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
  const out = { places: [], log: [] };
  const want = parseInt(arg('collect', '20'), 10), N = parseInt(arg('n', '6'), 10);
  const searchUrl = 'https://www.google.com/maps/search/' + encodeURIComponent(arg('q', 'dentist in Dubai')) + '?hl=en';
  const t0 = Date.now();
  await wc.loadURL(searchUrl).catch(() => {});
  let list;
  for (let i = 0; i < 25; i++) { list = await call(mp.mapsList); if (list.feed && list.count) break; await sleep(600); }
  let stagnant = 0;
  while (list.count < want && !list.end && stagnant < 3) {
    const before = list.count;
    await call(mp.mapsScrollFeed); await sleep(2200);
    list = await call(mp.mapsList);
    stagnant = list.count <= before ? stagnant + 1 : 0;
    out.log.push('scroll ' + before + ' -> ' + list.count + (list.end ? ' (end of list)' : ''));
  }
  out.collectMs = Date.now() - t0;
  out.collected = list.count;
  for (let i = 0; i < Math.min(N, list.cards.length); i++) {
    const card = list.cards[i];
    const t1 = Date.now();
    await wc.loadURL(card.href).catch(() => {});
    let ready = false;
    for (let k = 0; k < 40; k++) { if (await call(mp.mapsDetailReady, card.label)) { ready = true; break; } await sleep(250); }
    const d = await call(mp.mapsReadDetail);
    out.places.push(Object.assign({ idx: i, label: card.label, ready, ms: Date.now() - t1 }, mp.parseMapsHref(card.href), d));
    await sleep(600);
  }
  fs.writeFileSync(arg('out', 'dump9.json'), JSON.stringify(out, null, 2));
  console.log('DIAG9 written');
  return 0;
}
module.exports = { run };
