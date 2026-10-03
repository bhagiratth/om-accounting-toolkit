'use strict';
/* Loads one live Local Finder page in a visible window and dumps what the scraper sees, so selectors can be
 * checked against real markup:  npx electron . --diag --q="dentist in Mumbai" --out=C:\path\dump.json */
const fs = require('fs');
const path = require('path');
const arg = (n, d) => { const m = process.argv.find(a => a.startsWith('--' + n + '=')); return m ? m.slice(n.length + 3) : d; };

async function run({ BrowserWindow, WebContentsView, googleSession }) {
  googleSession();
  const win = new BrowserWindow({ show: true, width: 1100, height: 820 });
  const view = new WebContentsView({ webPreferences: { partition: 'persist:scrapemaster-google', sandbox: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1100, height: 780 });
  const url = 'https://www.google.com/search?q=' + encodeURIComponent(arg('q', 'dentist in Mumbai')) + '&udm=1';
  await view.webContents.loadURL(url).catch(() => {});
  await new Promise(r => setTimeout(r, 6000));
  const dump = await view.webContents.executeJavaScript(`(() => {
    const hs = [...document.querySelectorAll('[role="heading"]')];
    const cards = hs.slice(0, 6).map(h => {
      let c = h, p = h.parentElement;
      for (let i = 0; p && i < 8; i++) {
        if (p === document.body || p.matches('#rso, #search, #center_col, #main, #rcnt, [role="main"]')) break;
        let n = 0; for (const x of hs) if (p.contains(x)) n++;
        if (n > 1) break; c = p; p = p.parentElement;
      }
      return { heading: h.innerText, innerText: c.innerText, telLinks: [...c.querySelectorAll('a[href^="tel:"]')].map(a => a.href),
               links: [...c.querySelectorAll('a[href]')].map(a => (a.getAttribute('aria-label') || a.innerText || '').slice(0, 30) + ' -> ' + a.href.slice(0, 90)).slice(0, 8),
               html: c.outerHTML.slice(0, 2500) };
    });
    const chain = hs.slice(2, 5).map(h => { const out = []; let p = h; for (let i = 0; p && i < 10; i++, p = p.parentElement) { let n = 0; for (const x of hs) if (p.contains(x)) n++; out.push(p.tagName + '#' + p.id + '.' + String(p.className).slice(0, 30) + ' role=' + p.getAttribute('role') + ' headings=' + n + ' textLen=' + (p.innerText || '').length); } return { heading: h.innerText, out }; });
    return { url: location.href, title: document.title, headingCount: hs.length, body: document.body.innerText.slice(0, 7000), chain, cards };
  })()`);
  fs.writeFileSync(arg('out', path.join(require('os').tmpdir(), 'sm-diag.json')), JSON.stringify(dump, null, 2));
  console.log('DIAG written', arg('out', ''), 'headings', dump.headingCount);
  return 0;
}
module.exports = { run };
