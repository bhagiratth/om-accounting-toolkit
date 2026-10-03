'use strict';
/* ScrapeMASTER desktop engine - the Node port of the extension's background.js.
 *
 * A run is a QUEUE of searches ("keyword in place"). Each search pages through the Google Local
 * Finder inside the app's Google view. Google returns at most ~60 businesses per search, so when a
 * state/district search comes back "full" it is split into its districts / pincodes (adaptive
 * drill-down) and those are searched one by one.
 *
 *   idle -> running -> (blocked <-> running)* -> [emails phase] -> done | error
 *
 * The engine knows nothing about Electron: it talks to a `driver` ({load(url), scrape(), currentUrl(),
 * onNavigate(cb)}) and a `store` ({save(job), flush()}), so the same code is unit-tested in plain Node.
 */
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const emails = require('./emails');

// India geography: State > District > [pincode, area]
function loadGeo(file) {
  const text = fs.readFileSync(file || path.join(__dirname, '..', 'geo-data.js'), 'utf8');
  return new Function(text + '\n;return INDIA_GEO;')();
}

// ---------------------------------------------------------------- constants
const PAGE_SIZE = 20;            // ASSUMPTION: Local Finder (udm=1) pages by start=0,20,40...
const TASK_MAX_PAGES = 5;        // pages per search (Google caps a search at ~60 = 3 pages; 5 is slack)
const CAP_BIZ = 40;              // a search showing >= this many businesses is "full" -> drill down
const MAX_RUN_PAGES = 5000;      // safety backstop per run (use Continue to go on)
const MAX_TASKS = 60000;
const EMPTY_STREAK_FAIL = 8;     // this many empty searches in a row with 0 leads = markup problem
const CAP_MAPS = 100;            // Google Maps shows ~120 places per search; this many listed = "full" -> drill down
const MAPS_DEFAULT_LIMIT = 50;   // places read per Maps search unless the user (or a task file line) says otherwise
const GOOGLE_BASE = 'https://www.google.com';

// Optional fields a page can supply for the column chooser (copied as they are, text capped).
const EXTRA_FIELDS = ['category', 'hours', 'rating', 'reviews', 'cid', 'lat', 'lng', 'details'];

// Pacing, in ms. Google publishes no fixed limit, so these are conservative and get slower
// automatically (x job.slow) after every CAPTCHA/block.
const PROFILES = {
  safe:     { page: [4000, 9000], place: [1200, 2800], task: [10000, 22000], breakEvery: 20, brk: [60000, 150000] },
  balanced: { page: [2500, 5000], place: [700, 1800],  task: [6000, 12000],  breakEvery: 30, brk: [40000, 90000] },
  fast:     { page: [800, 2000],  place: [250, 700],    task: [2500, 6000],   breakEvery: 50, brk: [20000, 45000] }
};

// --------------------------------------------------------------- URL logic
// The builder and the recognizer MUST stay in sync (see README).
function buildFinderUrl(base, query, start) {
  let url = base + '/search?q=' + encodeURIComponent(query) + '&udm=1&hl=en';   // hl=en keeps Google's English field labels
  if (start > 0) url += '&start=' + start;
  return url;
}

// Accepts udm=1 (current) and tbm=lcl (legacy fallback) on the base host.
function isFinderUrl(url, base) {
  try {
    const u = new URL(url), b = new URL(base || GOOGLE_BASE);
    if (u.host !== b.host && !/^www\.google\.(com|co\.in)$/.test(u.hostname)) return false;
    if (u.pathname !== '/search') return false;
    return u.searchParams.get('udm') === '1' || u.searchParams.get('tbm') === 'lcl';
  } catch (e) { return false; }
}
function buildMapsSearchUrl(base, query) { return base + '/maps/search/' + encodeURIComponent(query) + '?hl=en'; }

function isSorryUrl(url, base) {
  try {
    const u = new URL(url);
    const ours = /(^|\.)google\./.test(u.hostname) || (base && u.host === new URL(base).host);
    return !!ours && u.pathname.startsWith('/sorry');
  } catch (e) { return false; }
}
function isConsentUrl(url) {
  try { return new URL(url).hostname === 'consent.google.com'; } catch (e) { return false; }
}

// ------------------------------------------------------------ data cleaning
const INVISIBLE = /[​-‏‪-‮⁠⁦-⁩﻿]/g;

function normalizePhone(raw) {
  const s = String(raw == null ? '' : raw).replace(INVISIBLE, '').trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return '';
  return (s.charAt(0) === '+' ? '+' : '') + digits;
}
function cleanName(raw) { return String(raw == null ? '' : raw).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, 200); }
function cleanQuery(raw) { return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 200); }
// A business is the same business if EITHER key matches: name + mobile digits, or name + address. The address key
// lets a business with no mobile ("Not found") be recognised again on another page or search.
function locKey(name, loc) { return name.toLowerCase() + '|x:' + String(loc || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40); }
// 'India' / 'United Arab Emirates' -> the region code phoneOf() uses to read local numbers.
function regionOf(country) {
  const c = String(country || '').toLowerCase();
  return /emirates|^uae$/.test(c) ? 'AE' : /india/.test(c) ? 'IN' : '';
}

function leadKeys(l) {
  const keys = [], d = String(l.phone || '').replace(/\D/g, '');
  if (d.length >= 8) keys.push(l.name.toLowerCase() + '|' + d);
  keys.push(locKey(l.name, l.location));
  return keys;
}

function csvField(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function safeName(name) { return /^[=@+\-]/.test(name) ? "'" + name : name; }   // spreadsheet-formula guard

// Every field a lead can export / show. The user picks which ones (and the order is always this one).
// `def` = ticked by default. get(lead) returns the text that goes in the CSV cell and in the live table.
function mapsUrl(cid) {
  try { return 'https://www.google.com/maps?cid=' + BigInt('0x' + String(cid).split(':')[1].replace(/^0x/i, '')).toString(); } catch (e) { return ''; }
}
const COLUMNS = [
  { key: 'name', head: 'Name', def: true, get: l => safeName(l.name) },
  { key: 'phone', head: 'Phone', def: true, get: l => (/^\+?\d{8,15}$/.test(l.phone || '') ? l.phone : 'Not found') },   // best number (mobile preferred), no spaces
  { key: 'phoneType', head: 'Phone type', def: false, get: l => (l.phone ? (l.phoneType === 'mobile' ? 'Mobile' : 'Landline') : '') },
  { key: 'landline', head: 'Other phone', def: false, get: l => (/^\+?\d{8,15}$/.test(l.landline || '') ? l.landline : '') },
  { key: 'email', head: 'Email', def: true, get: l => (emails.EMAIL_RE_FULL.test(l.email || '') ? l.email : '') },
  { key: 'website', head: 'Website', def: true, get: l => (/^https?:\/\//i.test(l.website || '') ? l.website : '') },
  { key: 'address', head: 'Address', def: true, get: l => safeName(l.location || '') },
  { key: 'city', head: 'City', def: true, get: l => safeName(l.city || '') },
  { key: 'state', head: 'State', def: true, get: l => safeName(l.state || '') },
  { key: 'pincode', head: 'Pincode', def: true, get: l => (/^[1-9]\d{5}$/.test(l.pincode || '') ? l.pincode : '') },
  { key: 'category', head: 'Category', def: false, get: l => safeName(l.category || '') },
  { key: 'rating', head: 'Rating', def: false, get: l => (l.rating != null ? String(l.rating) : '') },
  { key: 'reviews', head: 'Reviews', def: false, get: l => (l.reviews != null ? String(l.reviews) : '') },
  { key: 'hours', head: 'Hours (today)', def: false, get: l => safeName(l.hours || '') },
  { key: 'lat', head: 'Latitude', def: false, get: l => String(l.lat || '') },
  { key: 'lng', head: 'Longitude', def: false, get: l => String(l.lng || '') },
  { key: 'maps', head: 'Google Maps link', def: false, get: l => (l.cid ? mapsUrl(l.cid) : '') },
  { key: 'keyword', head: 'Searched keyword', def: false, get: l => safeName(l.keyword || '') },
  { key: 'country', head: 'Country', def: false, get: l => safeName(l.country || '') },
  { key: 'details', head: 'Details link', def: false, get: l => (/^https?:\/\//i.test(l.details || '') ? l.details : '') },
  { key: 'facebook', head: 'Facebook', def: false, get: l => l.facebook || '' },
  { key: 'instagram', head: 'Instagram', def: false, get: l => l.instagram || '' },
  { key: 'linkedin', head: 'LinkedIn', def: false, get: l => l.linkedin || '' },
  { key: 'twitter', head: 'Twitter / X', def: false, get: l => l.twitter || '' }
];
const DEFAULT_COLUMNS = COLUMNS.filter(c => c.def).map(c => c.key);

// Keeps only known keys, in the canonical order; falls back to the defaults if nothing valid was given.
function cleanColumns(keys) {
  const want = new Set(Array.isArray(keys) ? keys : []);
  const out = COLUMNS.filter(c => want.has(c.key)).map(c => c.key);
  return out.length ? out : DEFAULT_COLUMNS.slice();
}

// Header = the chosen columns. Phone is a real mobile (+91XXXXXXXXXX, no spaces) or "Not found"; every business gets a row.
function buildCsv(leads, columns) {
  const cols = cleanColumns(columns).map(k => COLUMNS.find(c => c.key === k));
  const rows = [cols.map(c => c.head).join(',')];
  for (const l of leads) rows.push(cols.map(c => csvField(c.get(l))).join(','));
  return rows.join('\r\n') + '\r\n';
}

function pad2(n) { return String(n).padStart(2, '0'); }
function makeFilename(query) {
  const d = new Date();
  const date = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const slug = String(query || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().replace(/\s+/g, '_').replace(/\.+$/, '').slice(0, 60) || 'search';
  return 'leads_' + slug + '_' + date + '.csv';
}

function rand(a, b) { return a + Math.random() * (b - a); }

// ================================================================== Engine
class Engine extends EventEmitter {
  constructor({ driver, store, geo, base, profiles, outputDir } = {}) {
    super();
    this.driver = driver;
    this.store = store || { save() {}, flush() {} };
    this.geo = geo || loadGeo();
    this.base = base || GOOGLE_BASE;
    this.profiles = profiles || PROFILES;
    this.outputDir = outputDir || null;
    this.job = this._fresh();
    this.seen = new Map();         // dedupe key -> lead
    this._token = null;            // identifies the active loop; changing it cancels the loop
    this._wake = null;             // resolves the current sleep early
    this._blockWait = null;        // resolves a block wait: true = resume, false = stop
    this._enrich = null;             // the website-lookup pool (see _enqueueEnrich)
    this._districtIndex = null;
    if (driver && driver.onNavigate) driver.onNavigate(url => this._onNavigate(url));
  }

  _fresh() {
    return {
      id: '', status: 'idle', query: '', keywords: [], target: 0, speed: 'safe', findEmails: false, source: 'finder', perTask: 0,
      queue: [], cur: null, tasksDone: 0, pagesScraped: 0, runPages: 0, emptyStreak: 0,
      leads: [], skippedNoPhone: 0, duplicates: 0,
      nextNavAt: 0, slow: 1, sinceBreak: 0, cleanTasks: 0, cooling: false,
      message: '', help: [], blockedReason: '', endReason: '', startedAt: 0, updatedAt: 0,
      columns: DEFAULT_COLUMNS.slice(), phase: '', pendingEnd: null, emailsTotal: 0, emailsDone: 0, emailsFound: 0, mobilesFound: 0, savedPath: ''
    };
  }

  // -------------------------------------------------------------- public API
  getState() {
    const j = this.job;
    const active = j.status === 'running' || j.status === 'blocked';
    return {
      id: j.id, status: j.status,
      query: j.cur ? j.cur.text : j.query, title: j.query, target: j.target,
      count: j.leads.length, tasksDone: j.tasksDone, tasksLeft: j.queue.length + (j.cur ? 1 : 0),
      speed: j.speed, source: j.source, perTask: j.perTask, slow: j.slow, cooling: j.cooling,
      waitUntil: j.status === 'running' && j.nextNavAt ? j.nextNavAt : 0,
      message: j.message, help: j.help, blockedReason: j.blockedReason, endReason: j.endReason,
      canResume: j.status === 'blocked', canContinue: this._canContinue(), canStop: active,
      canDownload: j.leads.length > 0, phase: j.phase,
      columns: j.columns, emailsDone: j.emailsDone, emailsTotal: j.emailsTotal, emailsFound: j.emailsFound, mobilesFound: j.mobilesFound || 0,
      withEmail: j.leads.filter(l => l.email).length, withMobile: j.leads.filter(l => l.phoneType === 'mobile').length, withPhone: j.leads.filter(l => l.phone).length, savedPath: j.savedPath
    };
  }

  _canContinue() {
    const j = this.job;
    return j.status === 'done' && ['stopped', 'page-cap', 'interrupted'].includes(j.endReason) && !!(j.cur || j.queue.length || this._pendingEnrich());
  }

  _emit() {
    this.job.updatedAt = Date.now();
    this.store.save(this.job);
    this.emit('state', this.getState());
  }

  start(opts) {
    if (this.job.status === 'running' || this.job.status === 'blocked') return { ok: false, error: 'A run is already in progress.' };
    const fromTasks = !!(opts.places && opts.places.mode === 'tasks');
    let keywords = [], queue = [];
    if (fromTasks) {
      // A task file (id|category|location|country|state|city|zip-or-limit): each line is its own keyword + place.
      const idx = new Map();
      for (const t of (Array.isArray(opts.places.tasks) ? opts.places.tasks : []).slice(0, MAX_TASKS)) {
        const kw = cleanQuery(t && t.kw).slice(0, 120), place = cleanQuery(t && t.place);
        if (!kw || !place) continue;
        const key = kw.toLowerCase();
        if (!idx.has(key)) { idx.set(key, keywords.length); keywords.push(kw); }
        queue.push({ k: idx.get(key), c: place, g: { country: cleanName(t.country), state: cleanName(t.state), city: cleanName(t.city) }, lim: Math.max(0, Math.min(5000, parseInt(t.limit, 10) || 0)) });
      }
      if (!queue.length) return { ok: false, error: 'The task file has no usable tasks.' };
    } else {
      keywords = this._parseKeywords(opts.keywords);
      if (!keywords.length) return { ok: false, error: 'Enter at least one keyword first.' };
      const units = this._buildUnits(opts.places);
      if (!units.length) return { ok: false, error: 'Pick at least one state (or type a place).' };
      if (units.length * keywords.length > MAX_TASKS) return { ok: false, error: 'Too many searches (' + units.length * keywords.length + '). Pick fewer places or keywords.' };
      for (const u of units) for (let k = 0; k < keywords.length; k++) queue.push(Object.assign({ k }, u));
    }
    if (!isFinderUrl(buildFinderUrl(this.base, 'x', 0), this.base) || !isFinderUrl(buildFinderUrl(this.base, 'x', 20), this.base)) {
      return { ok: false, error: 'Internal error: the finder URL builder and recognizer disagree.' };
    }
    const label = cleanQuery(opts.placeLabel);
    const title = keywords.slice(0, 2).join('+') + (keywords.length > 2 ? '+more' : '') + (label ? '_' + label : '');

    this.seen = new Map();
    this._enrich = null;
    this.job = Object.assign(this._fresh(), {
      id: 'run-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6),
      status: 'running', query: title, keywords, queue,
      target: Math.max(0, Math.min(1000000, parseInt(opts.target, 10) || 0)),
      speed: this.profiles[opts.speed] ? opts.speed : 'safe',
      findEmails: !!opts.findEmails, columns: cleanColumns(opts.columns),
      source: opts.source === 'maps' ? 'maps' : 'finder', perTask: Math.max(0, Math.min(1000, parseInt(opts.perTask, 10) || 0)), startedAt: Date.now(), message: 'Starting...'
    });
    this._emit();
    this._launchLoop();
    return { ok: true, state: this.getState() };
  }

  stop() {
    const j = this.job;
    if (j.status !== 'running' && j.status !== 'blocked') return { ok: false, error: 'Not running.' };
    this._finish('stopped', 'Stopped. Kept ' + j.leads.length + ' leads' + (j.queue.length || j.cur ? ' - click Continue to go on.' : '.'), false);
    return { ok: true, state: this.getState() };
  }

  resume() {
    if (this.job.status !== 'blocked') return { ok: false, error: 'Nothing to resume.' };
    this._unblock(true);
    return { ok: true, state: this.getState() };
  }

  continueRun() {
    const j = this.job;
    if (!this._canContinue()) return { ok: false, error: 'Nothing to continue.' };
    j.status = 'running'; j.endReason = ''; j.help = []; j.runPages = 0; j.savedPath = '';
    j.message = 'Continuing...';
    this._emit();
    this._launchLoop();
    return { ok: true, state: this.getState() };
  }

  // Loads a saved run (for Continue / Export). Anything that was mid-flight is shown as interrupted.
  loadJob(saved) {
    if (this.job.status === 'running' || this.job.status === 'blocked') return { ok: false, error: 'Stop the current run first.' };
    const j = Object.assign(this._fresh(), saved);
    if (j.status === 'running' || j.status === 'blocked') {
      j.status = 'done'; j.endReason = 'interrupted'; j.phase = ''; j.blockedReason = ''; j.nextNavAt = 0;
      j.message = 'This run was interrupted. Kept ' + j.leads.length + ' leads' + (j.queue.length || j.cur ? ' - click Continue to go on.' : '.');
    }
    this.job = j;
    this.seen = new Map();
    this._enrich = null;
    j.leads.forEach(l => this._register(l));
    this.emit('state', this.getState());
    return { ok: true, state: this.getState() };
  }

  csv() { return { filename: makeFilename(this.job.query), text: buildCsv(this.job.leads, this.job.columns) }; }

  // Which columns the live table shows and the CSV exports. Can be changed at any time, also after the run.
  setColumns(keys) {
    this.job.columns = cleanColumns(keys);
    this._emit();
    return { ok: true, state: this.getState() };
  }

  // -------------------------------------------------------------- the loop
  _launchLoop() {
    const token = this._token = Symbol('run');
    this._loop(token).catch(e => {
      console.error('[engine] loop crashed', e);
      if (this._token === token) this._fail('crash', 'Unexpected error: ' + (e && e.message || e), []);
    });
  }
  _alive(token) { return this._token === token && (this.job.status === 'running'); }

  async _loop(token) {
    const j = this.job;
    if (j.source === 'maps') return this._loopMaps(token);
    this._enqueueEnrich();
    while (this._alive(token)) {
      if (!j.cur && !this._takeNext()) { this._endRun('exhausted', 'All searches finished. ' + j.leads.length + ' businesses.'); return; }
      if (j.runPages >= MAX_RUN_PAGES) {
        this._finish('page-cap', 'Paused after ' + MAX_RUN_PAGES + ' page loads (safety limit). Kept ' + j.leads.length + ' leads - click Continue to go on.', false);
        return;
      }
      j.nextNavAt = 0; j.cooling = false;
      const url = buildFinderUrl(this.base, j.cur.text, j.cur.page * PAGE_SIZE);
      this._emit();
      let r;
      try { r = await this._loadAndScrape(url); } catch (e) { r = { block: 'timeout' }; }
      if (!this._alive(token)) return;
      if (r.block) {
        const resumed = await this._block(r.block, token);
        if (!resumed || !this._alive(token)) return;
        continue;                                       // retry the same page
      }
      const out = this._applyResult(r.data);
      if (out.stop || !this._alive(token)) return;
      const d = this._nextDelay(out.kind);
      j.nextNavAt = Date.now() + d;
      this._emit();
      await this._sleep(d);
      if (!this._alive(token)) return;
    }
  }

  async _loadAndScrape(url) {
    if (this._adopt && this.driver.settle) { this._adopt = false; await this.driver.settle(); }   // the user already brought the pane to this page
    else { this._adopt = false; await this.driver.load(url); }
    const u = this.driver.currentUrl();
    if (isSorryUrl(u, this.base)) return { block: 'captcha' };
    if (isConsentUrl(u)) return { block: 'consent' };
    if (!isFinderUrl(u, this.base)) return { block: 'notfinder' };
    const data = await this.driver.scrape();
    if (!data) return { block: 'timeout' };
    if (data.captcha) return { block: 'captcha' };
    return { data };
  }

  _sleep(ms) {
    return new Promise(res => {
      const t = setTimeout(() => { this._wake = null; res(); }, ms);
      this._wake = () => { clearTimeout(t); this._wake = null; res(); };
    });
  }

  // ----------------------------------------------------------------- blocks
  static get BLOCK_TEXT() {
    return {
      captcha: { message: 'Google is showing a CAPTCHA / "unusual traffic" check. Solve it in the Google pane on the right; the run continues by itself afterwards (or click Resume). Searching will be slower from now on.', help: [] },
      timeout: {
        message: "The Google page didn't load or report back in time. This is not necessarily a CAPTCHA - it can be a slow load or a change in Google's markup.",
        help: ['Look at the Google pane. If there is a challenge, solve it, then click Resume.',
               'If the results look normal, click Resume to retry this page.',
               "If the results look empty, Google's markup may have changed - see the README's selector section."]
      },
      consent: { message: 'Google is showing a cookie/consent page. Accept or dismiss it in the Google pane; the run continues by itself afterwards.', help: [] },
      notfinder: { message: "Google opened a page that isn't the Local Finder list (no udm=1 / tbm=lcl in the URL). Check the Google pane, then click Resume to retry.", help: ['If this keeps happening, Google changed the Local Finder URL - see the README (finder URL).'] }
    };
  }

  _block(reason, token) {
    const j = this.job, t = Engine.BLOCK_TEXT[reason] || Engine.BLOCK_TEXT.timeout;
    j.status = 'blocked'; j.blockedReason = reason; j.message = t.message; j.help = t.help; j.nextNavAt = 0;
    if (reason === 'captcha') { j.slow = Math.min(4, j.slow * 1.6); j.sinceBreak = 0; j.cleanTasks = 0; }
    this._emit();
    this.emit('blocked', reason);
    return new Promise(res => { this._blockWait = res; });
  }
  _unblock(resumed) {
    const j = this.job;
    if (resumed && j.status === 'blocked') { j.status = 'running'; j.blockedReason = ''; j.help = []; j.message = 'Reloading the current page...'; this._emit(); }
    const w = this._blockWait; this._blockWait = null;
    if (w) w(resumed);
  }
  // The user solved the CAPTCHA / accepted the consent page in the Google pane: carry on by ourselves.
  _onNavigate(url) {
    const j = this.job;
    if (j.status === 'blocked' && ['captcha', 'consent'].includes(j.blockedReason) && j.source === 'maps') {
      // Google Maps: once the user is back on a /maps page the check is solved; the search carries on from the same place.
      try { const u = new URL(url); if (u.pathname.indexOf('/maps') === 0) this._unblock(true); } catch (e) { /* ignore */ }
      return;
    }
    if (j.status === 'blocked' && ['captcha', 'consent'].includes(j.blockedReason) && isFinderUrl(url, this.base)) {
      try {
        const u = new URL(url), c = j.cur;
        this._adopt = !!c && u.searchParams.get('q') === c.text && (parseInt(u.searchParams.get('start') || '0', 10) || 0) === c.page * PAGE_SIZE;
      } catch (e) { this._adopt = false; }
      this._unblock(true);
    }
  }

  // ------------------------------------------------------------ the results
  _register(l) { leadKeys(l).forEach(k => this.seen.set(k, l)); }

  // A better number replaces a worse one (mobile beats landline beats nothing); the displaced number is kept as `landline`.
  _takePhone(lead, phone, type) {
    if (!phone || phone === lead.phone) return false;
    if (lead.phone && !(lead.phoneType !== 'mobile' && type === 'mobile')) return false;
    if (lead.phone) lead.landline = lead.phone;
    lead.phone = phone; lead.phoneType = type;
    return true;
  }

  // Global de-duplication across every keyword, place and page. Every business is kept. The Phone column holds the best
  // number found (mobile preferred, else landline); "Not found" is written only when there is none at all.
  _addLeads(list, ctx) {
    const j = this.job;
    let added = 0, dups = 0;
    for (const l of list) {
      if (j.target > 0 && j.leads.length >= j.target) break;
      const name = cleanName(l && l.name);
      if (!name) continue;
      const location = cleanName(l && l.location).slice(0, 200);
      const addr = location ? emails.parseAddress(location) : null;
      const region = regionOf((addr && addr.country) || (ctx && ctx.geo && ctx.geo.country) || (ctx && ctx.region) || '');
      const ph = emails.phoneOf(l && l.phone, region);
      const siteU = emails.safeSiteUrl(l && l.website);
      const site = siteU ? emails.cleanSiteUrl(siteU) : '';
      const cand = { name, phone: ph ? ph.out : '', location };
      const prev = leadKeys(cand).map(k => this.seen.get(k)).find(Boolean);
      if (prev) {
        dups++;
        if (ph) this._takePhone(prev, ph.out, ph.type);                   // a duplicate can still teach us a (better) number
        if (!prev.website && site) prev.website = site;
        if (!prev.location && location) { prev.location = location; Object.assign(prev, addr); }
        for (const k of EXTRA_FIELDS) if (prev[k] == null && l[k] != null && l[k] !== '') prev[k] = l[k];
        this._register(prev);
        continue;
      }
      const lead = { name, phone: cand.phone };
      if (ph) lead.phoneType = ph.type;
      if (location) { lead.location = location; Object.assign(lead, addr); }   // city, state, pincode, country
      if (ctx) {                                             // what the search itself knows, when the address doesn't say
        if (ctx.keyword) lead.keyword = ctx.keyword;
        const g = ctx.geo;
        if (g) { if (!lead.city && g.city) lead.city = g.city; if (!lead.state && g.state) lead.state = g.state; if (!lead.country && g.country) lead.country = g.country; }
      }
      if (site) lead.website = site;
      for (const k of EXTRA_FIELDS) if (l && l[k] != null && l[k] !== '') lead[k] = typeof l[k] === 'string' ? l[k].slice(0, 700) : l[k];
      j.leads.push(lead);
      this._register(lead);
      added++;
    }
    return { added, dups };
  }

  // Port of the extension's onPageResult. Returns {stop} when the run ended, else {kind} for the next pause.
  _applyResult(msg) {
    const j = this.job, c = j.cur;
    const businessCount = Number(msg.businessCount) || 0, noPhone = Number(msg.noPhone) || 0, signature = String(msg.signature || '');
    j.pagesScraped++; j.runPages++;
    let added = 0, dups = 0;
    if (businessCount > 0) {
      ({ added, dups } = this._addLeads(Array.isArray(msg.leads) ? msg.leads : [], this._ctx(c)));
      this._enqueueEnrich();                                // website lookups start right away, in parallel
      j.duplicates += dups; j.skippedNoPhone += noPhone; c.biz += businessCount; c.added += added;
    }
    if (businessCount === 0 && j.pagesScraped === 1 && !(c.t.p >= 0)) {
      this._fail('empty-first-page', 'No business listings were found on the first page.',
        ["If the Google pane shows results, Google's markup changed - see the README (card discovery / name extraction).",
         'If it says there are no results, try a different keyword or place.']);
      return { stop: true };
    }
    const n = j.leads.length, goal = j.target > 0 ? ' / ' + j.target : '';
    let note = 'Collected ' + n + goal + ' - search ' + (j.tasksDone + 1) + ' "' + c.text + '" page ' + (c.page + 1) + ': +' + added + ' new';
    if (noPhone) note += ', ' + noPhone + ' with no phone listed';
    if (dups) note += ', ' + dups + ' duplicate' + (dups === 1 ? '' : 's') + ' ignored';
    j.message = note;

    if (j.target > 0 && n >= j.target) { this._endRun('target', 'Done - reached the target of ' + j.target + ' businesses.'); return { stop: true }; }

    let taskDone = false, capped = false;
    if (businessCount === 0) taskDone = true;
    else if (signature && signature === c.lastSig && added === 0) taskDone = true;   // pagination stuck
    else if (!msg.hasNext) taskDone = true;
    else if (c.page + 1 >= TASK_MAX_PAGES) { taskDone = true; capped = true; }
    c.lastSig = signature;
    if (!taskDone) { c.page++; return { kind: 'page' }; }

    if (c.biz >= CAP_BIZ) capped = true;                 // "full" search -> split into smaller areas, depth-first
    return this._completeTask(capped);
  }

  // ================================================================ Google Maps source
  // One search = collect the place links by scrolling the results list, then open each place by its URL and read its
  // detail panel. Slower than the list source (about 2 s per place) but it gives phone, website, hours and coordinates
  // for every place, and the per-place visits are paced like a person browsing.
  _placeDelay() {
    const j = this.job, p = this.profiles[j.speed] || this.profiles.safe, r = p.place || p.page;
    return Math.round(rand(r[0], r[1]) * j.slow);
  }

  _mapsBlockCheck() {
    const u = this.driver.currentUrl();
    if (isSorryUrl(u, this.base)) return 'captcha';
    if (isConsentUrl(u)) return 'consent';
    return '';
  }

  // Returns {block}, {stop}, {done, listed, capped} or {done, target}. Progress is kept in job.cur (cards + index), so
  // after a CAPTCHA the same search carries on where it stopped.
  async _mapsTask(token) {
    const j = this.job, c = j.cur, d = this.driver;
    const limit = c.t.lim > 0 ? c.t.lim : (j.perTask > 0 ? j.perTask : MAPS_DEFAULT_LIMIT);
    if (!c.cards) {
      const url = buildMapsSearchUrl(this.base, c.text);
      try { await d.loadQuick(url); } catch (e) { return { block: 'timeout' }; }
      if (!this._alive(token)) return { stop: true };
      let b = this._mapsBlockCheck();
      if (b) return { block: b };
      let list = null;
      for (let i = 0; i < 30 && this._alive(token); i++) {                  // wait for the results list (up to ~18 s)
        list = await d.mapsList();
        if (list && (list.sorry || list.consent)) return { block: list.sorry ? 'captcha' : 'consent' };
        if (list && ((list.feed && list.count) || list.noResults)) break;
        await this._sleep(600);
      }
      if (!this._alive(token)) return { stop: true };
      if (!list || (!list.feed && !list.noResults)) return { block: 'timeout' };
      if (list.noResults || !list.count) { c.cards = []; c.pi = 0; return { done: true, listed: 0 }; }
      let stagnant = 0;
      while (list.count < limit && !list.end && stagnant < 4 && this._alive(token)) {
        const before = list.count;
        j.message = 'Collected ' + j.leads.length + ' - listing "' + c.text + '": ' + before + ' places found so far...';
        this._emit();
        await d.mapsScroll();
        await this._sleep(2600);
        list = await d.mapsList();
        if (!list) break;
        stagnant = list.count <= before ? stagnant + 1 : 0;
      }
      if (!this._alive(token)) return { stop: true };
      const seenHref = new Set();
      c.cards = ((list && list.cards) || []).filter(x => x.href && !seenHref.has(x.href) && seenHref.add(x.href)).slice(0, limit)
        .map(x => ({ label: String(x.label).slice(0, 160), href: x.href.slice(0, 700) }));
      c.pi = 0;
      c.listed = list ? list.count : c.cards.length;
      c.capped = c.cards.length >= limit || c.listed >= CAP_MAPS;
    }
    // visit every place
    while (c.pi < c.cards.length) {
      if (!this._alive(token)) return { stop: true };
      const card = c.cards[c.pi];
      let res;
      try { res = await d.mapsPlace(card); } catch (e) { res = null; }
      if (!this._alive(token)) return { stop: true };
      const b = this._mapsBlockCheck();
      if (b) return { block: b };
      j.pagesScraped++; j.runPages++;
      const det = res && res.ready ? res.detail : null;
      if (det) {
        const lead = {
          name: det.name || card.label, phone: det.phone, website: det.website, location: det.address, category: det.category,
          rating: det.rating, reviews: det.reviews, hours: det.hours,
          cid: res.href && res.href.cid, lat: res.href && res.href.lat, lng: res.href && res.href.lng,
          details: card.href.split('?')[0]
        };
        const { added, dups } = this._addLeads([lead], this._ctx(c));
        c.biz++; c.added += added; j.duplicates += dups;
        if (!lead.phone) j.skippedNoPhone++;
        this._enqueueEnrich();
        const n = j.leads.length, goal = j.target > 0 ? ' / ' + j.target : '';
        j.message = 'Collected ' + n + goal + ' - search ' + (j.tasksDone + 1) + ' "' + c.text + '": place ' + (c.pi + 1) + ' of ' + c.cards.length +
          (added ? '' : ' (duplicate)');
        if (j.target > 0 && n >= j.target) { c.pi++; return { done: true, target: true }; }
      } else {
        j.message = 'Collected ' + j.leads.length + ' - "' + c.text + '": could not read place ' + (c.pi + 1) + ' of ' + c.cards.length + ' (skipped)';
      }
      c.pi++;
      this._emit();
      const delay = this._placeDelay();
      j.nextNavAt = Date.now() + delay;
      await this._sleep(delay);
      j.nextNavAt = 0;
    }
    return { done: true, listed: c.listed, capped: !!c.capped };
  }

  async _loopMaps(token) {
    const j = this.job;
    this._enqueueEnrich();
    while (this._alive(token)) {
      if (!j.cur && !this._takeNext()) { this._endRun('exhausted', 'All searches finished. ' + j.leads.length + ' businesses.'); return; }
      if (j.runPages >= MAX_RUN_PAGES) {
        this._finish('page-cap', 'Paused after ' + MAX_RUN_PAGES + ' page loads (safety limit). Kept ' + j.leads.length + ' leads - click Continue to go on.', false);
        return;
      }
      j.nextNavAt = 0; j.cooling = false;
      this._emit();
      let r;
      try { r = await this._mapsTask(token); } catch (e) { console.error('[engine] maps task', e); r = { block: 'timeout' }; }
      if (!this._alive(token)) return;
      if (r.block) {
        const resumed = await this._block(r.block, token);
        if (!resumed || !this._alive(token)) return;
        continue;                                       // carries on from the same place
      }
      if (r.target) { this._endRun('target', 'Done - reached the target of ' + j.target + ' businesses.'); return; }
      const out = this._completeTask(!!r.capped);
      if (out.stop || !this._alive(token)) return;
      const d = this._nextDelay('task');
      j.nextNavAt = Date.now() + d;
      this._emit();
      await this._sleep(d);
      if (!this._alive(token)) return;
    }
  }

  // What every lead from the current search inherits (the searched keyword; the task file's country / state / city).
  _ctx(c) {
    return { keyword: this.job.keywords[c.t.k] || '', geo: c.t.g || null, region: c.t.s >= 0 ? 'India' : '' };
  }

  // A search is over (all pages read / all places visited): split it into smaller areas if it was "full", then move on.
  _completeTask(capped) {
    const j = this.job, c = j.cur;
    const n = j.leads.length, goal = j.target > 0 ? ' / ' + j.target : '';
    let split = 0;
    if (capped) {
      const kids = this._childrenOf(c.t);
      if (kids.length) { j.queue = kids.concat(j.queue); split = kids.length; }
    }
    j.tasksDone++;
    j.emptyStreak = c.biz === 0 ? j.emptyStreak + 1 : 0;
    if (!capped || !split) {
      j.cleanTasks++;
      if (j.cleanTasks >= 8 && j.slow > 1) { j.slow = Math.max(1, j.slow * 0.9); j.cleanTasks = 0; }
    }
    if (j.emptyStreak >= EMPTY_STREAK_FAIL && n === 0) {
      this._fail('empty-streak', EMPTY_STREAK_FAIL + ' searches in a row found nothing.',
        ["If the Google pane shows results, Google's markup changed - see the README (card discovery / name extraction)."]);
      return { stop: true };
    }
    if (split) j.message = 'Collected ' + n + goal + ' - "' + c.text + '" is full, splitting it into ' + split + ' smaller areas.';
    j.cur = null;
    if (!this._takeNext()) { this._endRun('exhausted', 'All searches finished. ' + n + ' businesses.'); return { stop: true }; }
    return { kind: 'task' };
  }

  // -------------------------------------------------- searches ("tasks")
  _taskText(t) {
    const kw = this.job.keywords[t.k];
    if (t.raw) return kw;
    if (t.c) return kw + ' in ' + t.c;
    const st = this.geo[t.s];
    if (t.p >= 0) { const pin = st[1][t.d][1][t.p]; return kw + ' in ' + (pin[1] ? pin[1] + ' ' : '') + pin[0]; }
    if (t.d >= 0) return kw + ' in ' + st[1][t.d][0] + ', ' + st[0];
    return kw + ' in ' + st[0];
  }
  _childrenOf(t) {
    if (t.raw || t.p >= 0 || !(t.s >= 0)) return [];
    if (t.d >= 0) return this.geo[t.s][1][t.d][1].map((_, pi) => ({ k: t.k, s: t.s, d: t.d, p: pi }));
    return this.geo[t.s][1].map((_, di) => ({ k: t.k, s: t.s, d: di, p: -1 }));
  }
  _takeNext() {
    const j = this.job, t = j.queue.shift();
    if (!t) { j.cur = null; return false; }
    j.cur = { t, text: this._taskText(t), page: 0, biz: 0, added: 0, lastSig: '' };
    return true;
  }
  _resolveDistrict(text) {
    if (!this._districtIndex) {
      this._districtIndex = new Map();
      this.geo.forEach((st, si) => st[1].forEach((d, di) => {
        const key = d[0].toLowerCase();
        if (!this._districtIndex.has(key)) this._districtIndex.set(key, []);
        this._districtIndex.get(key).push([si, di]);
      }));
    }
    const hit = this._districtIndex.get(String(text).trim().toLowerCase());
    return hit && hit.length === 1 ? hit[0] : null;     // ambiguous names (Aurangabad...) stay plain text
  }
  _buildUnits(places) {
    const geo = this.geo, isIdx = (n, max) => Number.isInteger(n) && n >= 0 && n < max;
    places = places || {};
    if (places.mode === 'india') {
      const units = [], distHasPin = new Set(), stateHasChild = new Set();
      for (const x of places.pins || []) {
        const [s, d, p] = x || [];
        if (!isIdx(s, geo.length) || !isIdx(d, geo[s][1].length) || !isIdx(p, geo[s][1][d][1].length)) continue;
        units.push({ s, d, p }); distHasPin.add(s + ':' + d); stateHasChild.add(s);
      }
      for (const x of places.districts || []) {
        const [s, d] = x || [];
        if (!isIdx(s, geo.length) || !isIdx(d, geo[s][1].length)) continue;
        stateHasChild.add(s);
        if (!distHasPin.has(s + ':' + d)) units.push({ s, d, p: -1 });
      }
      for (const s of places.states || []) if (isIdx(s, geo.length) && !stateHasChild.has(s)) units.push({ s, d: -1, p: -1 });
      units.sort((a, b) => a.s - b.s || a.d - b.d || a.p - b.p);
      return units;
    }
    const list = (Array.isArray(places.list) ? places.list : []).map(cleanQuery).filter(Boolean).slice(0, 200);
    if (!list.length) return [{ raw: 1 }];
    return list.map(c => { const hit = this._resolveDistrict(c); return hit ? { c, s: hit[0], d: hit[1], p: -1 } : { c }; });
  }
  _parseKeywords(raw) {
    const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\n\r;,]+/);
    const out = [], keys = new Set();
    for (const x of list) {
      const k = cleanQuery(x).slice(0, 120), key = k.toLowerCase();
      if (k && !keys.has(key)) { keys.add(key); out.push(k); }
      if (out.length >= 30) break;
    }
    return out;
  }

  // ----------------------------------------------------------------- pacing
  _nextDelay(kind) {
    const j = this.job, p = this.profiles[j.speed] || this.profiles.safe;
    const range = kind === 'task' ? p.task : p.page;
    let ms = rand(range[0], range[1]) * j.slow;
    j.cooling = false;
    j.sinceBreak++;
    if (j.sinceBreak >= p.breakEvery) {
      j.sinceBreak = 0; j.cooling = true;
      ms = Math.max(ms, rand(p.brk[0], p.brk[1]) * j.slow);
    } else if (Math.random() < 0.08) {
      ms += rand(0.5, 2) * range[1] * j.slow;            // occasional human-like longer pause, scaled to the profile
    }
    return Math.round(ms);
  }

  // ------------------------------------------------------------ finishing
  _finish(reason, message, autoSave) {
    const j = this.job;
    j.status = 'done'; j.endReason = reason; j.message = message; j.phase = ''; j.pendingEnd = null;
    j.help = []; j.blockedReason = ''; j.nextNavAt = 0; j.cooling = false;
    if (this._enrich) { this._enrich.ctl.abort(); this._enrich = null; }
    if (!['stopped', 'page-cap'].includes(reason)) { j.cur = null; j.queue = []; }
    this._token = null;
    if (this._wake) this._wake();
    this._unblock(false);
    if (autoSave && j.leads.length) {
      try { j.savedPath = this._saveCsv(); j.message += ' Saved to ' + j.savedPath; }
      catch (e) { j.message += ' (Auto-save failed: ' + e.message + ' - use Export CSV.)'; }
    }
    this._emit();
    this.store.flush && this.store.flush();
  }
  _fail(reason, message, help) {
    const j = this.job;
    j.status = 'error'; j.endReason = reason; j.message = message; j.help = help || []; j.nextNavAt = 0;
    this._token = null;
    if (this._wake) this._wake();
    this._unblock(false);
    this._emit();
    this.store.flush && this.store.flush();
  }
  _saveCsv() {
    if (!this.outputDir) throw new Error('no output folder');
    fs.mkdirSync(this.outputDir, { recursive: true });
    const { filename, text } = this.csv();
    let file = path.join(this.outputDir, filename), n = 1;
    while (fs.existsSync(file)) file = path.join(this.outputDir, filename.replace(/\.csv$/, '') + '_' + (++n) + '.csv');
    fs.writeFileSync(file, '﻿' + text, 'utf8');   // UTF-8 with BOM so Excel opens it cleanly
    return file;
  }

  // ------------------------------------------------- email + mobile lookup (opt-in), runs WHILE scraping
  // Every business that has a website is queued as soon as it is found; a small pool fetches the sites in the
  // background while the Google searches carry on. When the searches are done the run waits for the pool to drain.
  _pendingEnrich() {
    const j = this.job;
    return j.findEmails ? j.leads.filter(l => l.website && l.email === undefined).length : 0;
  }

  _enqueueEnrich() {
    const j = this.job;
    if (!j.findEmails) return;
    if (!this._enrich) this._enrich = { queue: [], queued: new WeakSet(), active: 0, ctl: new AbortController() };
    const E = this._enrich;
    for (const l of j.leads) {
      if (l.website && l.email === undefined && !E.queued.has(l)) { E.queued.add(l); E.queue.push(l); j.emailsTotal++; }
    }
    this._pumpEnrich();
  }

  _pumpEnrich() {
    const E = this._enrich;
    if (!E) return;
    while (E.active < emails.EMAIL_CONCURRENCY && E.queue.length && !E.ctl.signal.aborted) {
      const lead = E.queue.shift();
      E.active++;
      this._enrichOne(lead, E).finally(() => { E.active--; this._pumpEnrich(); });
    }
    this._maybeFinishEmails();
  }

  async _enrichOne(lead, E) {
    const j = this.job;
    let r = { email: '', mobile: '' };
    try { r = await emails.findContactForSite(lead.website, E.ctl.signal, { needPhone: lead.phoneType !== 'mobile', region: regionOf(lead.country) || (lead.pincode ? 'IN' : '') }); } catch (e) { /* fail soft */ }
    if (E.ctl.signal.aborted || this._enrich !== E) return;
    lead.email = r.email;
    if (r.social) for (const k of ['facebook', 'instagram', 'linkedin', 'twitter']) if (r.social[k]) lead[k] = r.social[k];
    j.emailsDone++;
    if (r.email) j.emailsFound++;
    if ((r.mobile && this._takePhone(lead, r.mobile, 'mobile')) || (r.landline && this._takePhone(lead, r.landline, 'landline'))) { this._register(lead); j.mobilesFound = (j.mobilesFound || 0) + 1; }
    if (j.phase === 'emails') {
      j.message = 'Searches finished (' + j.leads.length + ' businesses). Waiting for the website lookups: ' + j.emailsDone + ' / ' + j.emailsTotal +
        ' - ' + j.emailsFound + ' emails, ' + (j.mobilesFound || 0) + ' extra phone numbers.';
    }
    this._emit();
  }

  _mobileSummary() {
    const n = this.job.leads.length, p = this.job.leads.filter(l => l.phone).length, m = this.job.leads.filter(l => l.phoneType === 'mobile').length;
    return n ? ' Phone numbers: ' + p + ' of ' + n + ' (' + m + ' mobile; rest: Not found).' : '';
  }

  // Called when the searches are over (target reached / nothing left). Waits for running lookups, then finishes.
  _endRun(reason, message) {
    const j = this.job;
    this._enqueueEnrich();
    const E = this._enrich;
    if (j.findEmails && E && (E.active || E.queue.length)) {
      j.phase = 'emails'; j.pendingEnd = { reason, message }; j.nextNavAt = 0;
      this._token = Symbol('emails');                  // stops the page loop; the pool carries on
      j.message = 'Searches finished (' + j.leads.length + ' businesses). Waiting for the website lookups: ' + j.emailsDone + ' / ' + j.emailsTotal + '...';
      this._emit();
      return;
    }
    this._finish(reason, message + this._mobileSummary(), true);
  }

  _maybeFinishEmails() {
    const j = this.job, E = this._enrich;
    if (j.phase !== 'emails' || !E || E.active || E.queue.length) return;
    const end = j.pendingEnd || { reason: 'exhausted', message: 'Done.' };
    j.leads.forEach(l => { if (l.email === undefined) l.email = ''; });
    const withEmail = j.leads.filter(l => l.email).length;
    this._finish(end.reason, end.message + ' Emails found for ' + withEmail + ' of ' + j.leads.length + '.' + this._mobileSummary(), true);
  }

  // What the "extracted data" table shows: the newest rows first.
  leadsView(limit) {
    const n = Math.max(1, Math.min(2000, parseInt(limit, 10) || 300)), all = this.job.leads;
    const cols = cleanColumns(this.job.columns).map(k => COLUMNS.find(c => c.key === k));
    return {
      total: all.length,
      defs: COLUMNS.map(c => ({ key: c.key, head: c.head, def: c.def })),
      columns: cols.map(c => c.key),
      rows: all.slice(-n).reverse().map((l, i) => {
        const cells = {};
        cols.forEach(c => { cells[c.key] = c.get(l); });
        return { n: all.length - i, cells };
      })
    };
  }
}

module.exports = { Engine, PROFILES, COLUMNS, DEFAULT_COLUMNS, cleanColumns, loadGeo, buildCsv, makeFilename, buildFinderUrl, isFinderUrl, isSorryUrl, isConsentUrl, normalizePhone, TASK_MAX_PAGES, CAP_BIZ };
