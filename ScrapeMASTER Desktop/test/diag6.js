'use strict';
/* Live probe of the Google Maps site: open a search, click a few result cards, see which elements hold phone / website /
 * address / category / hours, how long the panel takes, and how to get back to the list.
 *   npx electron . --diag6 --q="dentist in Dubai" --out=C:\path\dump6.json */
const fs = require('fs');
const arg = (n, d) => { const m = process.argv.find(a => a.startsWith('--' + n + '=')); return m ? m.slice(n.length + 3) : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function listState() {
  const feed = document.querySelector('div[role="feed"]');
  const cards = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
  return {
    feed: !!feed, count: cards.length, end: /You've reached the end of the list/i.test(document.body.innerText),
    labels: cards.slice(0, 6).map(a => a.getAttribute('aria-label')), url: location.href.slice(0, 90)
  };
}
function cardPoint(i) {
  const cards = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
  const a = cards[i];
  if (!a) return null;
  a.scrollIntoView({ block: 'center' });
  const r = a.getBoundingClientRect();
  return { x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + r.height / 2), label: a.getAttribute('aria-label') };
}
function detail() {
  const items = Array.from(document.querySelectorAll('[data-item-id]')).map(e => e.tagName + '|' + e.getAttribute('data-item-id') + '|' + (e.getAttribute('aria-label') || '').slice(0, 80) + '|' + (e.getAttribute('href') || '').slice(0, 80));
  const h1s = Array.from(document.querySelectorAll('h1')).map(h => h.className + ':' + h.innerText.slice(0, 50));
  const cat = Array.from(document.querySelectorAll('button[jsaction*="category"], .DkEaL, button.DkEaL')).map(e => e.className + ':' + e.innerText.slice(0, 40));
  const rating = Array.from(document.querySelectorAll('div.F7nice, [aria-label*="stars"]')).slice(0, 3).map(e => (e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').slice(0, 60));
  const hours = Array.from(document.querySelectorAll('[aria-label*="Hours" i], [data-item-id="oh"], .t39EBf')).slice(0, 3).map(e => (e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').slice(0, 110));
  const backs = Array.from(document.querySelectorAll('button[aria-label]')).filter(b => /^(back|close)/i.test(b.getAttribute('aria-label'))).map(b => b.getAttribute('aria-label') + ' @' + b.className.slice(0, 20));
  return { items, h1s, cat, rating, hours, backs, url: location.href.slice(0, 150) };
}
function goBack() {
  const b = Array.from(document.querySelectorAll('button[aria-label]')).find(x => /^back/i.test(x.getAttribute('aria-label')));
  if (b) { b.click(); return 'clicked Back'; }
  return 'no Back button';
}

async function run({ BrowserWindow, WebContentsView, googleSession }) {
  googleSession();
  const win = new BrowserWindow({ show: true, width: 1400, height: 900 });
  const view = new WebContentsView({ webPreferences: { partition: 'persist:scrapemaster-google', sandbox: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1400, height: 860 });
  const wc = view.webContents;
  const call = (fn, ...args) => wc.executeJavaScript('(' + fn.toString() + ')(' + args.map(a => JSON.stringify(a)).join(',') + ')').catch(e => ({ error: String(e) }));
  const out = { steps: [] };
  await wc.loadURL('https://www.google.com/maps/search/' + encodeURIComponent(arg('q', 'dentist in Dubai')) + '?hl=en').catch(() => {});
  for (let i = 0; i < 20; i++) { const s = await call(listState); if (s.feed && s.count) { out.list = s; break; } await sleep(700); }
  out.list = out.list || await call(listState);
  for (const idx of [1, 2, 3]) {
    const step = { idx };
    await sleep(300);
    const pt = await call(cardPoint, idx);
    step.point = pt;
    if (pt && pt.x != null) {
      wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
      wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    }
    step.click = pt ? 'mouse click on ' + pt.label : 'no card';
    const t0 = Date.now();
    for (let i = 0; i < 24; i++) {
      await sleep(300);
      const d = await call(detail);
      if (d.items && d.items.some(x => /phone|authority|address/.test(x))) { step.readyMs = Date.now() - t0; step.detail = d; break; }
      step.detail = d;
    }
    step.back = await call(goBack);
    const t1 = Date.now();
    for (let i = 0; i < 20; i++) { await sleep(250); const s = await call(listState); if (s.feed && s.count) { step.listBackMs = Date.now() - t1; step.listAfter = s; break; } }
    out.steps.push(step);
  }
  fs.writeFileSync(arg('out', 'dump6.json'), JSON.stringify(out, null, 2));
  console.log('DIAG6 written');
  return 0;
}
module.exports = { run };
