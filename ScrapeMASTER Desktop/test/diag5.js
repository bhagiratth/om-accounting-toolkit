'use strict';
/* Where exactly do the coordinates sit relative to a place's name/rating array in the finder page's data blob?
 * npx electron . --diag5 --out=C:\path\dump5.json */
const fs = require('fs');
const arg = (n, d) => { const m = process.argv.find(a => a.startsWith('--' + n + '=')); return m ? m.slice(n.length + 3) : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function probe() {
  try {
    const out = [];
    const scripts = Array.from(document.getElementsByTagName('script')).filter(s => s.textContent && s.textContent.indexOf('Place name') >= 0);
    scripts.forEach(sc => {
      const t = sc.textContent;
      const re = /\["((?:[^"\\]|\\.)*)",-?\d+,2,\d+,\[\d+,null,\d+\],"Place name"\]/g;
      let m;
      while ((m = re.exec(t)) && out.length < 3) {
        const needle = '["' + m[1] + '",[';
        const start = t.lastIndexOf(needle, m.index);
        const label = m.index;
        const ll = /(-?\d{1,2}\.\d{4,}),(-?\d{2,3}\.\d{4,})/g;
        const hits = [];
        let x;
        const lo = Math.max(0, start - 4000), hi = Math.min(t.length, label + 4000);
        const seg = t.slice(lo, hi);
        while ((x = ll.exec(seg)) && hits.length < 6) hits.push({ rel: lo + x.index - start, val: x[0], ctx: seg.slice(Math.max(0, x.index - 90), x.index + x[0].length + 40) });
        out.push({ name: m[1], needleFound: start >= 0, labelRelToNeedle: label - start, hits });
      }
    });
    return out;
  } catch (e) { return { error: String(e) }; }
}

async function run({ BrowserWindow, WebContentsView, googleSession }) {
  googleSession();
  const win = new BrowserWindow({ show: true, width: 1400, height: 900 });
  const view = new WebContentsView({ webPreferences: { partition: 'persist:scrapemaster-google', sandbox: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1400, height: 860 });
  const wc = view.webContents;
  await wc.loadURL('https://www.google.com/search?q=' + encodeURIComponent('dentist in Nashik') + '&udm=1&hl=en').catch(() => {});
  await sleep(6000);
  const res = await wc.executeJavaScript('(' + probe.toString() + ')()').catch(e => ({ error: String(e) }));
  fs.writeFileSync(arg('out', 'dump5.json'), JSON.stringify(res, null, 2));
  console.log('DIAG5 written');
  return 0;
}
module.exports = { run };
