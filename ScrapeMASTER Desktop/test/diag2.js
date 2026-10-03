'use strict';
/* Investigates where phone numbers live on the live Local Finder: hidden in the list HTML, or only in the
 * detail panel after clicking a card.  npx electron . --diag2 --q="dentist in Mumbai" --out=C:\path\dump2.json */
const fs = require('fs');
const arg = (n, d) => { const m = process.argv.find(a => a.startsWith('--' + n + '=')); return m ? m.slice(n.length + 3) : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// These run INSIDE the Google page (serialized with toString, so no string-escaping surprises).
function scanList() {
  try {
    const html = document.documentElement.outerHTML;
    return {
      tel: (html.match(/tel:[^"'<> ]{6,20}/g) || []).slice(0, 10),
      phones: (html.match(/(?:\+91[\s-]?)?0?\d{4,5}[\s-]\d{5,6}/g) || []).slice(0, 15),
      attrs: Array.from(new Set(html.match(/data-[a-z-]*(?:phone|tel|call)[a-z-]*/gi) || [])),
      ariaCall: Array.from(document.querySelectorAll('[aria-label*="Call" i], [aria-label*="phone" i]')).slice(0, 8).map(e => e.tagName + ' ' + e.getAttribute('aria-label')),
      cards: document.querySelectorAll('.VkpGBb').length
    };
  } catch (e) { return { error: String(e) }; }
}
function clickCard(idx) {
  try {
    const cards = Array.from(document.querySelectorAll('.VkpGBb'));
    const c = cards[idx];
    if (!c) return 'no card ' + idx + ' (have ' + cards.length + ')';
    const target = c.querySelector('[role="button"]') || c.querySelector('.rllt__details') || c;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return 'clicked ' + ((c.querySelector('[role=heading]') || {}).innerText || '?');
  } catch (e) { return 'error ' + e; }
}
function readPanel() {
  try {
    const body = document.body.innerText;
    const websites = Array.from(document.querySelectorAll('a[href]')).filter(a => /website/i.test((a.getAttribute('aria-label') || '') + ' ' + (a.innerText || ''))).slice(0, 4).map(a => (a.getAttribute('aria-label') || a.innerText) + ' -> ' + a.href.slice(0, 120));
    const phoneEls = Array.from(document.querySelectorAll('[aria-label*="Phone" i], [aria-label*="Call" i], [data-dtype]')).slice(0, 8).map(e => e.tagName + '|' + (e.getAttribute('aria-label') || '') + '|' + (e.innerText || '').slice(0, 60) + '|' + (e.getAttribute('href') || ''));
    return {
      tel: Array.from(document.querySelectorAll('a[href^="tel:"]')).map(a => a.getAttribute('href')),
      websites, phoneEls, bodyLen: body.length,
      phoneLines: body.split('\n').filter(l => /phone|call|\+91|\b0?\d{4,5}[\s-]\d{5,6}\b/i.test(l)).slice(0, 12),
      tail: body.slice(-1500)
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
  await wc.loadURL('https://www.google.com/search?q=' + encodeURIComponent(arg('q', 'dentist in Mumbai')) + '&udm=1').catch(() => {});
  await sleep(6000);
  const out = { list: await call(scanList), clicks: [] };
  for (const idx of [2, 3, 4]) {
    const clicked = await call(clickCard, idx);
    await sleep(3000);
    out.clicks.push({ clicked, panel: await call(readPanel) });
  }
  fs.writeFileSync(arg('out', 'dump2.json'), JSON.stringify(out, null, 2));
  console.log('DIAG2 written');
  return 0;
}
module.exports = { run };
