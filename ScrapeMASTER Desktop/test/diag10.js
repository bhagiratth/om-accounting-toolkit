'use strict';
/* How to make the Maps results list load more places. Uses the real driver code.
 *   npx electron . --diag10 --q="dentist in Dubai" --out=C:\path\dump10.json */
const fs = require('fs');
const { ViewDriver } = require('../driver');
const arg = (n, d) => { const m = process.argv.find(a => a.startsWith('--' + n + '=')); return m ? m.slice(n.length + 3) : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run({ BrowserWindow, WebContentsView, googleSession }) {
  googleSession();
  const win = new BrowserWindow({ show: true, width: 1400, height: 900 });
  const view = new WebContentsView({ webPreferences: { partition: 'persist:scrapemaster-google', sandbox: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1400, height: 860 });
  const d = new ViewDriver(view.webContents);
  const out = { variants: [], hrefLens: [] };
  await d.loadQuick('https://www.google.com/maps/search/' + encodeURIComponent(arg('q', 'dentist in Dubai')) + '?hl=en');
  let list;
  for (let i = 0; i < 30; i++) { list = await d.mapsList(); if (list && list.feed && list.count) break; await sleep(600); }
  out.hrefLens = list.cards.map(c => c.href.length);
  out.start = list.count;

  // Variant A: the driver's scroll (JS + 3 wheel ticks), then watch the count for 6 s
  const watch = async (label, act) => {
    const row = { label, counts: [] };
    for (let round = 0; round < 6; round++) {
      await act();
      for (let k = 0; k < 8; k++) { await sleep(500); const l = await d.mapsList(); row.counts.push(l.count); }
      if (row.counts.length > 12 && row.counts[row.counts.length - 1] === row.counts[row.counts.length - 9]) { /* stuck */ }
    }
    const l = await d.mapsList(); row.end = l.end; row.final = l.count;
    out.variants.push(row);
  };
  await watch('driver.mapsScroll', () => d.mapsScroll());
  // Variant B: many small wheel ticks
  const mp = require('../scraper/maps-page');
  await watch('many wheel ticks', async () => {
    const p = await d._call(mp.mapsFeedPoint);
    if (p) for (let i = 0; i < 12; i++) { view.webContents.sendInputEvent({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: -240, canScroll: true }); await sleep(100); }
  });
  // Variant C: scroll up a bit then down (Maps loads when the end sentinel re-enters view)
  await watch('up then down', async () => {
    const p = await d._call(mp.mapsFeedPoint);
    if (p) {
      for (let i = 0; i < 3; i++) { view.webContents.sendInputEvent({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: 300, canScroll: true }); await sleep(120); }
      for (let i = 0; i < 8; i++) { view.webContents.sendInputEvent({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: -400, canScroll: true }); await sleep(120); }
    }
  });
  fs.writeFileSync(arg('out', 'dump10.json'), JSON.stringify(out, null, 2));
  console.log('DIAG10 written');
  return 0;
}
module.exports = { run };
