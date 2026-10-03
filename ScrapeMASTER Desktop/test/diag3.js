'use strict';
/* Where in the (unclicked) list HTML do the phone numbers sit? npx electron . --diag3 --out=C:\path\dump3.json */
const fs = require('fs');
const arg = (n, d) => { const m = process.argv.find(a => a.startsWith('--' + n + '=')); return m ? m.slice(n.length + 3) : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function where() {
  try {
    const re = /(?:\+91[\s-]?)?0?\d{4,5}[\s-]\d{5,6}/;
    const out = [];
    const cards = Array.from(document.querySelectorAll('.VkpGBb'));
    cards.slice(0, 6).forEach((c, i) => {
      const html = c.outerHTML;
      const m = html.match(re);
      const name = ((c.querySelector('[role=heading]') || {}).innerText || '?');
      let ctx = '', attr = '';
      if (m) {
        const at = html.indexOf(m[0]);
        ctx = html.slice(Math.max(0, at - 160), at + 80);
        const el = Array.from(c.querySelectorAll('*')).find(e => Array.from(e.attributes).some(a => re.test(a.value)));
        if (el) attr = el.tagName + ' ' + Array.from(el.attributes).filter(a => re.test(a.value)).map(a => a.name + '=' + a.value.slice(0, 120)).join(' ');
      }
      out.push({ i, name, hasPhoneInCardHtml: !!m, phone: m && m[0], attr, ctx });
    });
    const outside = [];
    const all = document.documentElement.outerHTML;
    const total = (all.match(new RegExp(re.source, 'g')) || []).length;
    const g = new RegExp(re.source, 'g');
    const ctxs = [];
    let m, n = 0;
    while ((m = g.exec(all)) && n++ < 2) {
      const el = null;
      ctxs.push({ phone: m[0], before: all.slice(Math.max(0, m.index - 1700), m.index), after: all.slice(m.index + m[0].length, m.index + m[0].length + 700) });
    }
    const scripts = Array.from(document.querySelectorAll('script')).filter(sc => re.test(sc.textContent)).length;
    return { cardCount: cards.length, total, scripts, ctxs, out };
  } catch (e) { return { error: String(e) }; }
}

async function run({ BrowserWindow, WebContentsView, googleSession }) {
  googleSession();
  const win = new BrowserWindow({ show: true, width: 1400, height: 900 });
  const view = new WebContentsView({ webPreferences: { partition: 'persist:scrapemaster-google', sandbox: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1400, height: 860 });
  const wc = view.webContents;
  await wc.loadURL('https://www.google.com/search?q=' + encodeURIComponent(arg('q', 'dentist in Mumbai')) + '&udm=1').catch(() => {});
  await sleep(6000);
  const res = await wc.executeJavaScript('(' + where.toString() + ')()').catch(e => ({ error: String(e) }));
  fs.writeFileSync(arg('out', 'dump3.json'), JSON.stringify(res, null, 2));
  console.log('DIAG3 written');
  return 0;
}
module.exports = { run };
