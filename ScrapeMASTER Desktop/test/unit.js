'use strict';
/* Plain-Node tests of the engine with a fake browser: drill-down, deepest-level-wins, dedupe,
 * Stop -> Continue, interrupted runs, CAPTCHA slow-down, CSV shape. Run: npm test */
const assert = require('assert');
const { Engine, loadGeo, buildCsv, makeFilename, isFinderUrl, buildFinderUrl } = require('../engine/engine');

const geo = loadGeo();
const STATES = new Set(geo.map(s => s[0]));
const hash = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const tiny = { page: [1, 2], task: [1, 2], breakEvery: 5, brk: [3, 4] };
const profiles = { safe: tiny, balanced: tiny, fast: tiny };

// A fake Google: a state-level search is "full" (3 pages of 20); anything smaller returns 8.
function fakeDriver({ captchaOn } = {}) {
  let url = '', log = [], blockedOnce = !!captchaOn;
  return {
    log,
    onNavigate() {},
    currentUrl: () => url,
    async load(u) { url = (blockedOnce && new URL(u).searchParams.get('q') === captchaOn) ? 'https://www.google.com/sorry/index' : u; if (url.includes('/sorry/')) blockedOnce = false; },
    async scrape() {
      const u = new URL(url), q = u.searchParams.get('q'), start = +(u.searchParams.get('start') || 0);
      log.push(q + '@' + start);
      const isState = STATES.has(q.split(' in ').pop()), per = isState ? 20 : 8, pages = isState ? 3 : 1, page = start / 20;
      const leads = [];
      for (let i = 0; i < per; i++) {
        const id = (hash(q) % 7) * 5 + page * 20 + i, k = id % 45;
        // every 5th business has no phone, every 7th only a landline, the rest a real mobile
        const phone = k % 5 === 0 ? '' : k % 7 === 0 ? '022 2639 55' + (10 + k) : '+91 98' + (10000000 + k * 13);
        leads.push({ name: 'Biz ' + k, phone, location: 'Street ' + k + ', City', website: 'https://biz' + k + '.example.in/' });
      }
      return { leads, businessCount: per, noPhone: 0, signature: q + page, hasNext: page + 1 < pages, captcha: false, url: u.href };
    }
  };
}
const until = (e, pred, ms = 20000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout: ' + JSON.stringify(e.getState()).slice(0, 300))), ms);
  const chk = s => { if (pred(s)) { clearTimeout(t); e.off('state', chk); res(s); } };
  e.on('state', chk); chk(e.getState());
});
const mk = (driver, extra) => new Engine(Object.assign({ driver, geo, profiles }, extra));

(async () => {
  const goa = geo.findIndex(s => s[0] === 'Goa'), nGoa = geo[goa][1].length;
  const mh = geo.findIndex(s => s[0] === 'Maharashtra');

  // drill-down + multi keyword + global dedupe
  let e = mk(fakeDriver());
  assert(e.start({ keywords: ['dentist', 'Gym'], places: { mode: 'india', states: [goa] }, speed: 'fast', target: 0 }).ok);
  let st = await until(e, s => s.status === 'done');
  assert.strictEqual(st.tasksDone, 2 + 2 * nGoa);
  const keys = e.job.leads.map(l => l.name.toLowerCase() + '|' + l.location);
  assert.strictEqual(new Set(keys).size, keys.length, 'global dedupe');
  assert(e.job.leads.some(l => !l.phone) && e.job.leads.some(l => /^\+91[6-9]\d{9}$/.test(l.phone)), 'both mobile and Not-found rows are kept');
  assert(e.job.leads.every(l => !l.phone || /^\+91\d{10}$/.test(l.phone)), 'the phone column holds a clean +91 number, never spaces');
  assert(e.job.leads.some(l => l.phoneType === 'landline') && e.job.leads.some(l => l.phoneType === 'mobile'), 'a landline is used when there is no mobile, a mobile when there is one');

  // deepest ticked level wins
  e = mk(fakeDriver());
  e.start({ keywords: ['salon'], places: { mode: 'india', states: [mh], districts: [[mh, 0]], pins: [[mh, 0, 0], [mh, 0, 1]] }, speed: 'fast' });
  st = await until(e, s => s.status === 'done');
  assert.strictEqual(st.tasksDone, 2);

  // target stops the run
  e = mk(fakeDriver());
  e.start({ keywords: ['x'], places: { mode: 'india', states: [goa] }, speed: 'fast', target: 5 });
  st = await until(e, s => s.status === 'done');
  assert.strictEqual(st.count, 5); assert.strictEqual(st.endReason, 'target');

  // stop -> continue; interrupted load
  const slow = { page: [60, 70], task: [60, 70], breakEvery: 50, brk: [3, 4] };
  e = mk(fakeDriver(), { profiles: { safe: slow, balanced: slow, fast: slow } });
  e.start({ keywords: ['spa', 'cafe'], places: { mode: 'custom', list: ['Pune', 'Andheri West'] }, speed: 'fast' });
  await new Promise(r => setTimeout(r, 90));
  st = e.stop().state;
  assert.strictEqual(st.status, 'done'); assert(st.canContinue);
  const saved = JSON.parse(JSON.stringify(e.job)); saved.status = 'running'; saved.endReason = '';   // as if the app was killed mid-run
  assert(e.continueRun().ok);
  st = await until(e, s => s.status === 'done' && !s.canContinue);
  const e2 = mk(fakeDriver()); const r = e2.loadJob(saved);
  assert(r.ok && r.state.endReason === 'interrupted' && r.state.canContinue, 'interrupted run can be continued');

  // captcha: blocks, slows down, resume works
  const d = fakeDriver({ captchaOn: 'blocked kw' });
  e = mk(d);
  e.start({ keywords: ['blocked kw'], places: { mode: 'custom', list: [] }, speed: 'fast' });
  st = await until(e, s => s.status === 'blocked');
  assert.strictEqual(st.blockedReason, 'captcha'); assert(e.job.slow > 1.5);
  e.resume();
  st = await until(e, s => s.status === 'done');
  assert(st.count > 0);

  // email/mobile lookups run WHILE the searches are still going, and the run waits for them before it finishes
  {
    const emailsMod = require('../engine/emails'), orig = emailsMod.findContactForSite, events = [];
    emailsMod.findContactForSite = async (site, signal, opts) => {
      events.push('lookup'); await new Promise(r => setTimeout(r, 25));
      return { email: 'hi@' + new URL(site).hostname, mobile: opts.needPhone ? '+919000000001' : '', landline: '' };
    };
    const d = fakeDriver(), baseScrape = d.scrape;
    d.scrape = async () => { const r = await baseScrape(); events.push('page'); return r; };
    e = mk(d, { profiles: { safe: slow, balanced: slow, fast: slow } });
    e.start({ keywords: ['dentist'], places: { mode: 'india', states: [goa] }, speed: 'fast', findEmails: true });
    st = await until(e, s => s.status === 'done', 30000);
    emailsMod.findContactForSite = orig;
    assert(events.indexOf('lookup') >= 0 && events.indexOf('lookup') < events.lastIndexOf('page'), 'lookups started before the last page was scraped');
    assert(e.job.leads.every(l => !l.website || l.email !== undefined), 'every lookup finished before the run was marked done');
    assert(e.job.leads.some(l => /^hi@/.test(l.email)), 'emails stored');
    assert(e.job.leads.filter(l => !l.landline && l.phone === '+919000000001').length > 0, 'a mobile found on a website fills a "Not found" row');
    assert(st.mobilesFound > 0 && st.message.includes('Phone numbers:'), 'summary');
  }

  // Google Maps source: scroll the list to collect place links, then read each place; UAE numbers; task files
  {
    const { parseTsk } = require('../engine/tsk');
    const mapsProfile = { page: [1, 2], place: [1, 2], task: [1, 2], breakEvery: 99, brk: [3, 4] };
    const mp = { safe: mapsProfile, balanced: mapsProfile, fast: mapsProfile };
    const fakeMaps = (total) => {
      let url = '', shown = 8;
      const card = i => ({ label: 'Clinic ' + i, href: 'https://www.google.com/maps/place/Clinic+' + i + '/data=!4m7!3m6!1s0x3e5f' + (1000 + i).toString(16) + ':0x' + (5000 + i).toString(16) + '!8m2!3d25.' + (100 + i) + '!4d55.' + (200 + i) });
      return {
        scrolls: 0, visited: [],
        onNavigate() {}, currentUrl: () => url,
        async load(u) { url = u; }, async loadQuick(u) { url = u; },
        async mapsList() {
          const n = Math.min(shown, total), cards = []; for (let i = 0; i < n; i++) cards.push(card(i));
          return { feed: true, count: n, end: n >= total, noResults: false, sorry: false, consent: false, detailOpen: false, cards };
        },
        async mapsScroll() { this.scrolls++; shown += 8; },
        async mapsPlace(c) {
          url = c.href; this.visited.push(c.label);
          const i = parseInt(c.label.split(' ')[1], 10);
          const phone = i % 3 === 0 ? '+971 50 123 45' + (10 + i) : i % 3 === 1 ? '+971 4 335 4041' : '';
          return {
            ready: true, url, href: { cid: '0x3e5f' + (1000 + i).toString(16) + ':0x' + (5000 + i).toString(16), lat: '25.' + (100 + i), lng: '55.' + (200 + i) },
            detail: { name: c.label, phone, website: i % 2 ? 'https://clinic' + i + '.example.ae/' : '', address: 'Tower ' + i + ' - Business Bay - Dubai - United Arab Emirates', category: 'Dental clinic', rating: 4.5, reviews: 100 + i, hours: 'Sat 9 am-9 pm' }
          };
        }
      };
    };

    // 1) a Maps search with a per-search limit: scrolls to collect enough links, reads exactly that many places
    let md = fakeMaps(40);
    e = new Engine({ driver: md, geo, profiles: mp });
    assert(e.start({ keywords: ['dentist'], places: { mode: 'custom', list: ['Dubai'] }, source: 'maps', perTask: 20, speed: 'fast' }).ok);
    st = await until(e, s => s.status === 'done');
    assert.strictEqual(st.count, 20, 'limit of 20 places per search');
    assert(md.scrolls >= 2, 'the list was scrolled to collect more links');
    assert.strictEqual(md.visited.length, 20);
    const L = e.job.leads;
    assert(L.every(l => l.keyword === 'dentist' && l.city === 'Dubai' && l.country === 'United Arab Emirates' && /^https:\/\/www\.google\.com\/maps\/place\//.test(l.details)), 'keyword / city / country / details link on every lead');
    assert(L.filter(l => l.phoneType === 'mobile').every(l => /^\+9715[024568]\d{7}$/.test(l.phone)), 'UAE mobiles are +9715...');
    assert(L.some(l => l.phoneType === 'landline' && /^\+9714\d{7}$/.test(l.phone)), 'a UAE landline is used when there is no mobile');
    assert(L.some(l => !l.phone), 'a place with no number at all stays Not found');
    assert.strictEqual(st.source, 'maps');
    const csvLines = e.csv().text.split('\r\n');
    assert.strictEqual(csvLines[0], 'Name,Phone,Email,Website,Address,City,State,Pincode');
    e.setColumns(['name', 'phone', 'keyword', 'country', 'details', 'maps']);
    assert.strictEqual(e.csv().text.split('\r\n')[0], 'Name,Phone,Google Maps link,Searched keyword,Country,Details link');

    // 2) a task file: each line is its own keyword + place; the file's country / state / city fill what the address lacks
    const tsk = parseTsk('1|ecommerce||United Arab Emirates|Dubayy|Dubai|1000\n2|ecommerce||United Arab Emirates|Abu Zaby|Al Ayn|1000\n3|salon||United Arab Emirates|Ash Shariqah|Sharjah|1000\n');
    assert.strictEqual(tsk.tasks.length, 3);
    md = fakeMaps(6);
    const lq = md.loadQuick;                 // each search shows different businesses (names carry the search text)
    md.loadQuick = async u => { md.lastSearch = decodeURIComponent((u.split('/maps/search/')[1] || '').replace('?hl=en', '')); return lq.call(md, u); };
    md.mapsPlace = async c => { md.visited.push(c.label); return { ready: true, url: c.href, href: {}, detail: { name: c.label + ' / ' + md.lastSearch, phone: '', website: '', address: 'Somewhere without a city', category: 'x', rating: null, reviews: null, hours: '' } }; };
    e = new Engine({ driver: md, geo, profiles: mp });
    assert(e.start({ keywords: [], places: { mode: 'tasks', tasks: tsk.tasks }, source: 'maps', perTask: 3, speed: 'fast' }).ok);
    st = await until(e, s => s.status === 'done');
    assert.strictEqual(st.tasksDone, 3, 'three task-file lines = three searches');
    assert(e.job.keywords.length === 2 && e.job.leads.some(l => l.keyword === 'salon') && e.job.leads.some(l => l.keyword === 'ecommerce'));
    assert(e.job.leads.some(l => l.city === 'Al Ayn' && l.country === 'United Arab Emirates'), 'city / country come from the task line when the address has none');
    assert(!e.start({ keywords: [], places: { mode: 'tasks', tasks: [] } }).ok, 'an empty task file is refused');
    assert.strictEqual(parseTsk('x|y\n\n1|CA||India|Rajasthan|Jaipur|302006').tasks[0].zip, '302006');
    assert.strictEqual(parseTsk('1|CA||India|Rajasthan|Jaipur|302006').tasks[0].place, '302006 Jaipur, Rajasthan, India');
    assert.strictEqual(parseTsk('1|ecommerce||United Arab Emirates|Ra’s al Khaymah|Ra’s al Khaymah|1000').tasks[0].place, 'Ras al Khaymah, United Arab Emirates');
  }

  // validation + csv + url sync
  assert(!mk(fakeDriver()).start({ keywords: [], places: { mode: 'custom', list: [] } }).ok);
  assert(!mk(fakeDriver()).start({ keywords: ['x'], places: { mode: 'india', states: [] } }).ok);
  assert.strictEqual(buildCsv([
    { name: 'A, "B"', phone: '+918657488772', website: 'https://a.in/', location: '1 Rd, Pune, Maharashtra 411001', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
    { name: '=x', phone: '+919876543210', email: 'a@b.in' }, { name: 'n', phone: '' }, { name: 'land', phone: '+912226395533', phoneType: 'landline', pincode: '12' }]),
    'Name,Phone,Email,Website,Address,City,State,Pincode\r\n"A, ""B""",+918657488772,,https://a.in/,"1 Rd, Pune, Maharashtra 411001",Pune,Maharashtra,411001\r\n\'=x,+919876543210,a@b.in,,,,,\r\nn,Not found,,,,,,\r\nland,+912226395533,,,,,,\r\n');
  // column chooser: any subset, canonical order, extra fields, safe fallbacks
  const { cleanColumns, COLUMNS, DEFAULT_COLUMNS } = require('../engine/engine');
  const rich = { name: 'Clinic', phone: '+919876543210', category: 'Dental clinic', rating: 4.7, reviews: 888, cid: '0x3bc2bf881e459a07:0xafc040a99b72f7c5', lat: '18.5158', lng: '73.8418', facebook: 'https://facebook.com/c' };
  assert.strictEqual(buildCsv([rich], ['maps', 'rating', 'name', 'reviews', 'category', 'nonsense']),
    'Name,Category,Rating,Reviews,Google Maps link\r\nClinic,Dental clinic,4.7,888,https://www.google.com/maps?cid=' + BigInt('0xafc040a99b72f7c5').toString() + '\r\n');
  assert.deepStrictEqual(cleanColumns(['bogus']), DEFAULT_COLUMNS); assert.deepStrictEqual(cleanColumns(undefined), DEFAULT_COLUMNS);
  assert.strictEqual(COLUMNS.length, 24);
  assert.strictEqual(buildCsv([rich], ['name', 'phone', 'facebook', 'lat', 'lng']).split('\r\n')[1], 'Clinic,+919876543210,18.5158,73.8418,https://facebook.com/c');
  const pa = require('../engine/emails').parseAddress;
  assert.deepStrictEqual(pa('A-1, Four Bungalows, Andheri West, Mumbai, Maharashtra 400053'), { city: 'Mumbai', state: 'Maharashtra', pincode: '400053', country: 'India' });
  assert.deepStrictEqual(pa('Shop 5, MG Road, Pune 411001, India'), { city: 'Pune', state: '', pincode: '411001', country: 'India' });
  assert.deepStrictEqual(pa(''), { city: '', state: '', pincode: '', country: '' });
  assert.deepStrictEqual(pa('Oxford Towers - 805 - Business Bay - Dubai - United Arab Emirates'), { city: 'Dubai', state: 'Dubai', pincode: '', country: 'United Arab Emirates' });
  const mo2 = require('../engine/emails').mobileOf;
  assert.strictEqual(mo2('050 123 4567').out, '+971501234567'); assert.strictEqual(mo2('+971 56 177 7223').out, '+971561777223'); assert.strictEqual(mo2('+971 4 335 4041'), null); assert.strictEqual(mo2('00971501234567').out, '+971501234567');
  const mo = require('../engine/emails').mobileOf;
  assert.strictEqual(mo('086574 88772').out, '+918657488772'); assert.strictEqual(mo('+91 98765 43210').out, '+919876543210');
  assert.strictEqual(mo('09819916333').out, '+919819916333'); assert.strictEqual(mo('098199 16333').ten, '9819916333');
  assert.strictEqual(mo('022 2639 5533'), null); assert.strictEqual(mo('+91 22 2639 5533'), null);
  assert.strictEqual(mo('12345'), null); assert.strictEqual(mo('+1 415 555 2671'), null);
  assert(isFinderUrl(buildFinderUrl('https://www.google.com', 'a b', 20)));
  assert(isFinderUrl('https://www.google.com/search?q=a&tbm=lcl'));
  assert(!isFinderUrl('https://www.google.com/search?q=a'));
  assert(/^leads_a_b_\d{4}-\d{2}-\d{2}\.csv$/.test(makeFilename('a/b')));
  console.log('UNIT OK');
})().catch(err => { console.error(err); process.exit(1); });
