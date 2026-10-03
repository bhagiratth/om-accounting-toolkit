'use strict';
/* Which action really closes a Maps detail panel, and which scroll method makes the list load more?
 *   npx electron . --diag8 --out=C:\path\dump8.json */
const fs = require('fs');
const mp = require('../scraper/maps-page');
const arg = (n, d) => { const m = process.argv.find(a => a.startsWith('--' + n + '=')); return m ? m.slice(n.length + 3) : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function visibleState() {
  var h = document.querySelector('h1.DUwDvf');
  var hr = h ? h.getBoundingClientRect() : null;
  var feed = document.querySelector('div[role="feed"]');
  var fr = feed ? feed.getBoundingClientRect() : null;
  return {
    detailVisible: !!(hr && hr.width > 0 && hr.height > 0), feedVisible: !!(fr && fr.width > 0 && fr.height > 0),
    cards: document.querySelectorAll('a[href*="/maps/place/"]').length, url: location.href.slice(0, 70)
  };
}
function closeCandidates() {
  return Array.prototype.slice.call(document.querySelectorAll('button[aria-label="Close"], button[aria-label="Back"], [aria-label="Back"], [jsaction*="back"]')).map(function (b) {
    var r = b.getBoundingClientRect();
    return { tag: b.tagName, aria: b.getAttribute('aria-label'), cls: String(b.className).slice(0, 30), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
}
function feedRect() {
  var f = document.querySelector('div[role="feed"]');
  if (!f) return null;
  var r = f.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), scrollH: f.scrollHeight, scrollTop: f.scrollTop };
}

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
  const out = { tries: [] };
  await wc.loadURL('https://www.google.com/maps/search/' + encodeURIComponent(arg('q', 'dentist in Dubai')) + '?hl=en').catch(() => {});
  for (let i = 0; i < 25; i++) { const l = await call(mp.mapsList); if (l.feed && l.count) break; await sleep(600); }
  out.start = await call(visibleState);

  // open card 0
  const pt = await call(mp.mapsCardPoint, 0); await sleep(300); click(pt);
  const t0 = Date.now();
  for (let i = 0; i < 48; i++) { await sleep(250); const v = await call(visibleState); if (v.detailVisible) break; }
  out.openMs = Date.now() - t0; out.clickedLabel = pt.label;
  await sleep(800);
  out.opened = await call(visibleState);
  out.candidates = await call(closeCandidates);

  // method 1: Escape
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await sleep(1200); out.tries.push({ method: 'Escape', state: await call(visibleState) });

  // method 2..n: click each candidate
  if (out.tries[0].state.detailVisible) {
    const cands = out.candidates.filter(c => c.w > 0 && c.h > 0 && c.y < 100).sort((p, q) => q.x - p.x);   // the panel's X is the right-most one at the top, the search box's X is the left one
    for (const c of cands) {
      click({ x: c.x + Math.round(c.w / 2), y: c.y + Math.round(c.h / 2) });
      await sleep(1200);
      const st = await call(visibleState);
      out.tries.push({ method: 'click ' + c.aria + ' ' + c.cls + ' @' + c.x + ',' + c.y, state: st });
      if (!st.detailVisible) break;
    }
  }
  // if still open: browser back
  const last = out.tries[out.tries.length - 1].state;
  if (last.detailVisible) { wc.goBack(); await sleep(2500); out.tries.push({ method: 'history back', state: await call(visibleState) }); }

  // scrolling: JS scrollTop vs real wheel events
  out.feedRect = await call(feedRect);
  const before = (await call(visibleState)).cards;
  await call(mp.mapsScrollFeed); await sleep(2500);
  out.scrollJs = { before, after: (await call(visibleState)).cards };
  const fr = await call(feedRect);
  if (fr) {
    for (let i = 0; i < 6; i++) { wc.sendInputEvent({ type: 'mouseWheel', x: fr.x, y: fr.y, deltaX: 0, deltaY: -600, canScroll: true }); await sleep(250); }
    await sleep(2500);
    out.scrollWheel = { after: (await call(visibleState)).cards, rect: await call(feedRect) };
  }
  fs.writeFileSync(arg('out', 'dump8.json'), JSON.stringify(out, null, 2));
  console.log('DIAG8 written');
  return 0;
}
module.exports = { run };
