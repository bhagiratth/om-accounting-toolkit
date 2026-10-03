'use strict';
/* End-to-end smoke test, run with `npm run smoke` (needs a display session; the window is hidden).
 * Starts a local mock "Google" (Local Finder pages, a /sorry/ CAPTCHA page), points the real engine
 * + the real Chromium view + the real page scraper at it, and checks:
 *   - cards are scraped by the real scraper in a real browser page
 *   - a "full" state search is split into its districts, duplicates are dropped, CSV is saved
 *   - a CAPTCHA redirect blocks the run and solving it in the pane resumes it by itself
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const hash = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

function startMock(states) {
  const hits = [];
  let blockOnce = true;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/sorry')) {
      res.setHeader('content-type', 'text/html');
      return res.end('<html><body><form id="captcha-form">We have detected unusual traffic</form></body></html>');
    }
    if (u.pathname.startsWith('/maps/search/')) {            // a Maps results list: 8 places, plus the "end of list" line
      const host = 'http://' + req.headers.host;
      let html = '<html><body><div role="feed">';
      for (let i = 0; i < 8; i++) html += `<a aria-label="Clinic ${i}" href="${host}/maps/place/Clinic+${i}/data=!4m7!3m6!1s0x3e5f${(1000 + i).toString(16)}:0x${(5000 + i).toString(16)}!8m2!3d25.${100 + i}!4d55.${200 + i}">Clinic ${i}</a>`;
      html += "</div><p>You've reached the end of the list.</p></body></html>";
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(html);
    }
    if (u.pathname.startsWith('/maps/place/')) {             // one place's detail panel
      const i = parseInt((u.pathname.match(/Clinic\+(\d+)/) || [])[1], 10);
      const phone = i % 3 === 0 ? `<button data-item-id="phone:tel:+9715012345${10 + i}" aria-label="Phone: +971 50 123 45${10 + i}"></button>`
        : i % 3 === 1 ? '<button data-item-id="phone:tel:+97143354041" aria-label="Phone: +971 4 335 4041"></button>' : '';
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(`<html><body><h1 class="DUwDvf">Clinic ${i}</h1><div class="F7nice"><span>4.5</span><span>(100)</span></div><button class="DkEaL">Dental clinic</button>` +
        `<button data-item-id="address" aria-label="Address: Tower ${i} - Business Bay - Dubai - United Arab Emirates"></button>${phone}` +
        `<a data-item-id="authority" href="https://clinic${i}.example.ae/"></a></body></html>`);
    }
    if (u.pathname !== '/search') { res.statusCode = 204; return res.end(); }
    const q = u.searchParams.get('q') || '', start = +(u.searchParams.get('start') || 0);
    if (q === 'blocked test' && blockOnce) { blockOnce = false; res.statusCode = 302; res.setHeader('location', '/sorry/index?continue=' + encodeURIComponent(req.url)); return res.end(); }
    hits.push(q + '@' + start);
    const isState = states.has(q.split(' in ').pop());
    const per = isState ? 20 : 8, pages = isState ? 3 : 1, page = start / 20;
    // Like the real page: the visible cards show NO phone; Google's per-place data sits in a <script> blob.
    let html = '<html><body><div role="heading">Choose what you are giving feedback on</div><div id="rso">';
    let blob = '';
    for (let i = 0; i < per; i++) {
      const id = (hash(q) % 7) * 5 + page * 20 + i, k = id % 45;
      // every 5th business has no phone, every 7th only a landline, the rest a mobile written like Google does
      const phone = k % 5 === 0 ? null : k % 7 === 0 ? '022 2639 55' + (10 + k) : '08657 ' + (100000 + k * 13);
      html += `<div class="c"><div><div role="heading">Biz ${k}</div><div>4.5(20) · Dentist</div><div>Street ${k}</div><div>On-site services</div></div></div>`;
      const f = (v, n, label) => `["${v}",${n * 1000},${n},1,[${n},null,0],"Place ${label}"]`;
      blob += '[' + [f('Biz ' + k, 2, 'name'), f('Dental clinic', 3, 'category'), f('Street ' + k + ', Mumbai, Maharashtra 400053', 4, 'location'),
        f('Open · Closes 9 pm', 5, 'opening hours'), phone ? f(phone, 6, 'phone number') : null,
        f('https://biz' + k + '.example.in/', 7, 'website')].filter(Boolean).join(',') + '],';
    }
    html += '</div><script>var data=[' + blob + '];</script>' + (page + 1 < pages ? '<a id="pnnext" href="#">Next</a>' : '') + '</body></html>';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, hits, port: server.address().port })));
}

function waitState(engine, pred, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + label + ' (last: ' + JSON.stringify(engine.getState()).slice(0, 300) + ')')), ms);
    const check = s => { if (pred(s)) { clearTimeout(t); engine.off('state', check); resolve(s); } };
    engine.on('state', check);
    check(engine.getState());
  });
}

async function run({ app, BrowserWindow, WebContentsView, Engine, ViewDriver, Store, googleSession }) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-smoke-')), 'out');
  let mock;
  try {
    const geo = require('./../engine/engine').loadGeo();
    const states = new Set(geo.map(s => s[0]));
    mock = await startMock(states);
    const base = 'http://127.0.0.1:' + mock.port;

    googleSession();
    const win = new BrowserWindow({ show: false, width: 900, height: 700 });
    const view = new WebContentsView({ webPreferences: { partition: 'persist:scrapemaster-google', sandbox: true } });
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 900, height: 700 });

    const tiny = { page: [5, 10], task: [5, 10], breakEvery: 6, brk: [20, 30] };
    const engine = new Engine({
      driver: new ViewDriver(view.webContents), store: new Store(path.join(out, 'runs')),
      base, profiles: { safe: tiny, balanced: tiny, fast: tiny }, outputDir: path.join(out, 'csv')
    });

    // 1) full state search -> split into districts, dedupe, CSV saved
    const goa = geo.findIndex(s => s[0] === 'Goa'), nDist = geo[goa][1].length;
    let r = engine.start({ keywords: ['dentist'], places: { mode: 'india', states: [goa] }, speed: 'fast', target: 0, placeLabel: 'Goa' });
    assert(r.ok, JSON.stringify(r));
    let st = await waitState(engine, s => s.status === 'done' || s.status === 'error', 90000, 'state run');
    assert.strictEqual(st.status, 'done', st.message);
    assert.strictEqual(st.tasksDone, 1 + nDist, 'tasks: state + its districts, got ' + st.tasksDone);
    assert(mock.hits.some(h => h.endsWith('@40')), 'third page of the full state search was requested');
    assert(mock.hits.some(h => /in North Goa, Goa@0/.test(h)), 'district searches ran');
    assert(st.savedPath && fs.existsSync(st.savedPath), 'csv saved');
    const csv = fs.readFileSync(st.savedPath, 'utf8');
    assert(csv.charCodeAt(0) === 0xFEFF, 'BOM');
    const rows = csv.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    assert.strictEqual(rows[0], 'Name,Phone,Email,Website,Address,City,State,Pincode');
    const keys = rows.slice(1).map(l => l.split(',')[0]);
    assert.strictEqual(new Set(keys).size, keys.length, 'no duplicate rows');
    assert(rows.slice(1).every(l => /^[^,]+,(\+91\d{10}|Not found),,https:\/\/biz\d+\.example\.in\/,"Street \d+, Mumbai, Maharashtra 400053",Mumbai,Maharashtra,400053$/.test(l)), 'row = name, a +91 number or Not found, blank email, website, address, city, state, pincode');
    assert(rows.some(l => /,Not found,,/.test(l)), 'businesses without a mobile are kept as Not found');
    assert(rows.some(l => /,\+91[6-9]\d{9},,/.test(l)), 'mobiles were read from the page data and normalised to +91');
    assert(st.message.includes('Phone numbers:'), 'summary line');
    console.log('SMOKE 1 ok:', rows.length - 1, 'unique leads,', st.tasksDone, 'searches');

    // 2) CAPTCHA: blocked, then solved in the pane -> resumes by itself
    r = engine.start({ keywords: ['blocked test'], places: { mode: 'custom', list: [] }, speed: 'fast', target: 0 });
    assert(r.ok, JSON.stringify(r));
    st = await waitState(engine, s => s.status === 'blocked', 30000, 'captcha block');
    assert.strictEqual(st.blockedReason, 'captcha');
    assert(engine.job.slow > 1.5, 'slowed down after captcha');
    // the "user" solves the challenge: Google sends them back to the results page
    await view.webContents.loadURL(base + '/search?q=' + encodeURIComponent('blocked test') + '&udm=1').catch(() => {});
    st = await waitState(engine, s => s.status === 'done' || s.status === 'error', 60000, 'resume after captcha');
    assert.strictEqual(st.status, 'done', st.message);
    assert(st.count > 0, 'leads after resume');
    console.log('SMOKE 2 ok: captcha blocked then auto-resumed;', st.count, 'leads');

    // 2b) Google Maps source: the real driver scrolls a (mock) results list, opens each place by URL and reads the panel
    r = engine.start({ keywords: ['dentist'], places: { mode: 'custom', list: ['Dubai'] }, source: 'maps', perTask: 6, speed: 'fast', target: 0 });
    assert(r.ok, JSON.stringify(r));
    st = await waitState(engine, s => s.status === 'done' || s.status === 'error', 90000, 'maps run');
    assert.strictEqual(st.status, 'done', st.message);
    assert.strictEqual(st.count, 6, 'six places read from the Maps list');
    const ml = engine.job.leads;
    assert(ml.every(l => l.keyword === 'dentist' && l.city === 'Dubai' && l.country === 'United Arab Emirates' && /\/maps\/place\//.test(l.details)), 'keyword / city / country / details link');
    assert(ml.some(l => /^\+9715[024568]\d{7}$/.test(l.phone) && l.phoneType === 'mobile'), 'a UAE mobile (+971 5x) was read');
    assert(ml.some(l => /^\+9714\d{7}$/.test(l.phone) && l.phoneType === 'landline'), 'a UAE landline is used when there is no mobile');
    assert(ml.some(l => !l.phone), 'a place without any number is Not found');
    assert(ml.every(l => !l.website || /^https:\/\/clinic\d\.example\.ae\/$/.test(l.website)), 'website read from the panel');
    assert(ml.every(l => l.rating === 4.5 && l.reviews === 100 && l.category === 'Dental clinic'), 'rating / reviews / category');
    console.log('SMOKE 2b ok: Maps source read', st.count, 'places (mobile, landline and no-number cases)');

    // 3) the real UI loads in a real window (CSP, preload, geo list, pane placeholder)
    const ui = new BrowserWindow({ show: false, width: 1300, height: 800, webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: true } });
    const errors = [];
    ui.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
    // the UI talks to the engine through the same commands main.js serves; serve the ones the UI uses at start-up
    const { ipcMain } = require('electron');
    ipcMain.removeHandler('api');   // main.js registered its own (it has no engine in smoke mode)
    ipcMain.handle('api', (_e, type, p) => {
      if (type === 'leads') return Object.assign({ ok: true }, engine.leadsView(p && p.limit));
      if (type === 'columns') return engine.setColumns(p);
      if (type === 'getState') return { ok: true, state: engine.getState() };
      if (type === 'runs:list') return { ok: true, runs: [] };
      return { ok: true };
    });
    await ui.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise(r => setTimeout(r, 900));
    const info = await ui.webContents.executeJavaScript(`({
      api: typeof window.api, states: document.querySelectorAll('#geoStates input[type=checkbox]').length,
      demoBar: !document.getElementById('demoBar').hidden, pane: document.getElementById('paneModal').hidden, table: !!document.getElementById('dataTable'),
      cols: document.querySelectorAll('#dataTable th').length, rows: document.querySelectorAll('#dataBody tr').length,
      quickStates: document.querySelectorAll('#qState option').length
    })`);
    assert(info.rows > 0, 'the live table shows the extracted businesses');
    assert.strictEqual(info.quickStates, 37, 'quick-pick dropdown lists the states');
    // choosing columns changes the table and the CSV
    const cols = ['name', 'phone', 'rating', 'category', 'maps'];
    engine.setColumns(cols);
    await new Promise(r => setTimeout(r, 1800));
    const th = await ui.webContents.executeJavaScript(`Array.from(document.querySelectorAll('#dataTable th')).map(x => x.textContent).join('|')`);
    assert.strictEqual(th, '#|Name|Phone|Category|Rating|Google Maps link', 'table follows the chosen columns: ' + th);
    assert.strictEqual(engine.csv().text.split('\r\n')[0], 'Name,Phone,Category,Rating,Google Maps link', 'CSV follows the chosen columns');
    engine.setColumns(undefined);
    assert.strictEqual(info.api, 'object', 'preload api exposed');
    assert.strictEqual(info.states, 36, 'states list rendered (geo-data loaded under the CSP)');
    assert.strictEqual(info.demoBar, false, 'not in demo mode inside the app');
    assert.strictEqual(info.pane, true, 'the Google page stays hidden until needed'); assert(info.table, 'live data table present');
    assert.deepStrictEqual(errors, [], 'no console errors: ' + errors.join(' | '));
    console.log('SMOKE 3 ok: UI renders,', info.states, 'states, live table (' + info.rows + ' rows), column chooser, quick-pick, Google page hidden');

    console.log('SMOKE PASSED');
    return 0;
  } catch (e) {
    console.error('SMOKE FAILED:', e && e.stack || e);
    return 1;
  } finally {
    if (mock) mock.server.close();
  }
}

module.exports = { run };
