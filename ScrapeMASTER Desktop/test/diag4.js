'use strict';
/* Two live checks:
 *  1) where rating / review count / place ids / coordinates sit in the finder page's data blob
 *  2) what the Google Maps site (google.com/maps/search) gives in our pane: results, phone in the list or only after a click, any CAPTCHA
 *  npx electron . --diag4 --out=C:\path\dump4.json */
const fs = require('fs');
const arg = (n, d) => { const m = process.argv.find(a => a.startsWith('--' + n + '=')); return m ? m.slice(n.length + 3) : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function blobProbe() {
  try {
    const out = [];
    const scripts = Array.from(document.getElementsByTagName('script')).filter(s => s.textContent && s.textContent.indexOf('Place name') >= 0);
    scripts.forEach(sc => {
      const t = sc.textContent;
      const re = /\["((?:[^"\\]|\\.)*)",-?\d+,2,\d+,\[\d+,null,\d+\],"Place name"\]/g;
      let m;
      while ((m = re.exec(t)) && out.length < 4) {
        const win = t.slice(Math.max(0, m.index - 3000), m.index);
        const rating = win.match(/\["[^"]{1,80}",\[(\d(?:\.\d+)?),null,null,\[(\d+)\]\]/g);
        const cids = win.match(/"0x[0-9a-f]+:0x[0-9a-f]+"/g);
        const pids = win.match(/"ChIJ[\w-]{10,}"/g);
        const ll = win.match(/\[null,null,-?\d{1,2}\.\d{3,},-?\d{1,3}\.\d{3,}\]/g);
        const ll2 = win.match(/-?\d{1,2}\.\d{4,},-?\d{2,3}\.\d{4,}/g);
        out.push({ name: m[1], ratingMatches: rating && rating.slice(-2), cid: cids && cids.slice(-1), placeId: pids && pids.slice(-1), latlng: ll && ll.slice(-1), latlng2: ll2 && ll2.slice(-2) });
      }
    });
    return out;
  } catch (e) { return { error: String(e) }; }
}
function mapsProbe() {
  try {
    const feed = document.querySelector('div[role="feed"]');
    const cards = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
    return {
      url: location.href, title: document.title, hasFeed: !!feed, cards: cards.length,
      sorry: /\/sorry\//.test(location.href) || /unusual traffic|captcha/i.test(document.body.innerText.slice(0, 3000)),
      consent: /consent\.google/.test(location.href) || /Before you continue/i.test(document.body.innerText.slice(0, 500)),
      first: cards.slice(0, 3).map(a => ({ label: a.getAttribute('aria-label'), href: a.href.slice(0, 140), parentText: (a.parentElement.innerText || '').slice(0, 220) })),
      feedText: feed ? feed.innerText.slice(0, 700) : document.body.innerText.slice(0, 500)
    };
  } catch (e) { return { error: String(e) }; }
}
function mapsScroll() {
  const feed = document.querySelector('div[role="feed"]');
  if (!feed) return -1;
  feed.scrollTop = feed.scrollHeight;
  return document.querySelectorAll('a[href*="/maps/place/"]').length;
}
function mapsClick() {
  const a = document.querySelector('a[href*="/maps/place/"]');
  if (!a) return 'no card';
  a.click();
  return 'clicked ' + (a.getAttribute('aria-label') || '');
}
function mapsDetail() {
  try {
    const q = sel => { const e = document.querySelector(sel); return e ? (e.getAttribute('aria-label') || e.innerText || '').trim() : null; };
    return {
      name: (document.querySelector('h1') || {}).innerText || null,
      phone: q('button[data-item-id^="phone"]'), website: q('a[data-item-id="authority"]'), address: q('button[data-item-id="address"]'),
      hours: q('[data-item-id="oh"]'), rating: q('div.F7nice span[aria-hidden="true"]'), url: location.href.slice(0, 160)
    };
  } catch (e) { return { error: String(e) }; }
}

async function run({ BrowserWindow, WebContentsView, googleSession }) {
  googleSession();
  const win = new BrowserWindow({ show: true, width: 1400, height: 900 });
  const view = new WebContentsView({ webPreferences: { partition: 'persist:scrapemaster-google', sandbox: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1400, height: 860 });
  const wc = view.webContents;
  const call = (fn, ...args) => wc.executeJavaScript('(' + fn.toString() + ')(' + args.map(a => JSON.stringify(a)).join(',') + ')').catch(e => ({ error: String(e) }));
  const out = {};
  await wc.loadURL('https://www.google.com/search?q=' + encodeURIComponent('dentist in Pune') + '&udm=1&hl=en').catch(() => {});
  await sleep(6000);
  out.blob = await call(blobProbe);
  const t0 = Date.now();
  await wc.loadURL('https://www.google.com/maps/search/' + encodeURIComponent('dentist in Pune') + '?hl=en').catch(() => {});
  await sleep(7000);
  out.maps = await call(mapsProbe);
  out.mapsLoadMs = Date.now() - t0;
  out.scroll = [];
  for (let i = 0; i < 4; i++) { out.scroll.push(await call(mapsScroll)); await sleep(2500); }
  out.click = await call(mapsClick);
  await sleep(3500);
  out.detail = await call(mapsDetail);
  fs.writeFileSync(arg('out', 'dump4.json'), JSON.stringify(out, null, 2));
  console.log('DIAG4 written');
  return 0;
}
module.exports = { run };
