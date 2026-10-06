/*
 * LeadPilot LinkedIn — background service worker (Manifest V3, no build step)
 *
 * The service worker owns ALL durable state and every decision:
 *   - automation job state machine  (idle → running → paused → completed / error / restricted)
 *   - daily activity budgets, cooldowns, follow-up scheduling
 *   - lead database (chrome.storage.local), activity log, post history
 *   - queue management, tab binding, CSV generation
 *   - recovery after the worker is killed and restarted by Chrome
 *
 * The content script (content.js) only reads the visible LinkedIn page and clicks visible UI controls
 * when told to. It never decides *whether* to act.
 *
 * Compliance design (see README):
 *   - only the LinkedIn tab the user attached is ever driven; no hidden tabs, no private APIs
 *   - Review-Before-Send is the default; Conservative Auto Mode is opt-in and strictly capped
 *   - any CAPTCHA / verification / warning / restriction stops everything and waits for the human
 *   - pauses are ordinary UX pacing and daily budgets, never a technique to dodge detection
 */
'use strict';

/* ───────────────────────────── constants ───────────────────────────── */

const VERSION = '1.0.1';

const K = {
  settings: 'lp_settings',
  leads: 'lp_leads',
  log: 'lp_log',
  job: 'lp_job',
  counters: 'lp_counters',
  posts: 'lp_posts',
  tab: 'lp_tab',
  diag: 'lp_diag',
};

// Hard ceilings the settings UI cannot exceed. Deliberately conservative.
const HARD_CAPS = { connections: 30, messages: 50, followUps: 50, posts: 5 };
const MIN_COOLDOWN_SEC = 30;
const MIN_PROFILE_GAP_SEC = 10;
const CONNECT_NOTE_MAX = 300;
const MESSAGE_MAX = 3000;
const POST_MAX = 3000;
const LOG_MAX = 1000;
const POSTS_MAX = 300;
const NAV_TIMEOUT_MS = 30000;
const CONTENT_TIMEOUT_MS = 60000;
const ALARM_ADVANCE = 'lp-advance';
const ALARM_TICK = 'lp-tick';

const ACTIONS = ['connect', 'message', 'followup'];
const BUDGET_KEY = { connect: 'connections', message: 'messages', followup: 'followUps' };
const ACTION_LABEL = { connect: 'connection request', message: 'message', followup: 'follow-up' };

const CONNECTION_STATUSES = ['Not Connected', 'Pending', 'Connected', 'Unknown'];
const MESSAGE_STATUSES = ['Not Contacted', 'Messaged', 'Followed Up', 'Replied', 'Do Not Contact', 'Converted'];
const BLOCKING_MESSAGE_STATUSES = ['Replied', 'Do Not Contact', 'Converted'];

const CSV_FIELDS = [
  { key: 'firstName', label: 'First Name' },
  { key: 'lastName', label: 'Last Name' },
  { key: 'profileUrl', label: 'Profile URL' },
  { key: 'jobTitle', label: 'Job Title' },
  { key: 'company', label: 'Company' },
  { key: 'location', label: 'Location' },
  { key: 'industry', label: 'Industry' },
  { key: 'connectionStatus', label: 'Connection Status' },
  { key: 'messageStatus', label: 'Message Status' },
  { key: 'lastContacted', label: 'Last Contacted' },
  { key: 'nextFollowUp', label: 'Next Follow-up' },
  { key: 'source', label: 'Source' },
  { key: 'notes', label: 'Notes' },
];

/**
 * Error catalogue. Each failure is classified into exactly one of these so the UI never mislabels
 * (for example a slow page is NAV_TIMEOUT, never "CAPTCHA").
 * `state` is the automation state the failure leads to.
 */
const ERRORS = {
  LOGIN_REQUIRED: { label: 'Login required', state: 'paused' },
  PAGE_CHANGED: { label: 'LinkedIn page changed', state: 'error' },
  CAPTCHA_SECURITY: { label: 'CAPTCHA / security challenge', state: 'paused' },
  ACCOUNT_RESTRICTED: { label: 'Account restriction', state: 'restricted' },
  RATE_WARNING: { label: 'Rate / activity warning', state: 'paused' },
  MISSING_SELECTOR: { label: 'Missing selector', state: 'error' },
  NAV_TIMEOUT: { label: 'Navigation timeout', state: 'error' },
  USER_STOPPED: { label: 'User stopped automation', state: 'idle' },
  NO_TAB: { label: 'No LinkedIn tab attached', state: 'paused' },
  CONTENT_UNAVAILABLE: { label: 'LinkedIn page not reachable', state: 'error' },
  UNSUPPORTED_PAGE: { label: 'Unsupported LinkedIn page', state: 'error' },
  IDENTITY_MISMATCH: { label: 'Recipient / identity could not be verified', state: 'error' },
  INTERRUPTED: { label: 'Interrupted (extension restarted)', state: 'error' },
};

const FINDING_TO_CODE = {
  login_required: 'LOGIN_REQUIRED',
  security_challenge: 'CAPTCHA_SECURITY',
  restricted: 'ACCOUNT_RESTRICTED',
  rate_warning: 'RATE_WARNING',
};

/* ───────────────────────────── tiny utils ───────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const pad2 = (n) => String(n).padStart(2, '0');
const iso = (t = Date.now()) => new Date(t).toISOString();
const DAY_MS = 86400000;

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

const str = (v, max = 500) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalise a LinkedIn profile URL: https://www.linkedin.com/in/<slug>/  (lower-case slug, no query/hash).
 * Returns null for anything that is not a /in/ profile URL. This is the lead's unique id.
 */
function normalizeProfileUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim(), 'https://www.linkedin.com');
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/in\/([^/?#]+)/i);
    if (!m) return null;
    let slug;
    try { slug = decodeURIComponent(m[1]); } catch (_) { slug = m[1]; }
    slug = slug.trim().toLowerCase();
    if (!slug) return null;
    return `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`;
  } catch (_) {
    return null;
  }
}

function pageTypeFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    if (/^\/(checkpoint|uas|login|authwall|signup)(\/|$)/i.test(p)) return 'auth';
    if (/^\/search\/results\/people/i.test(p)) return 'search_people';
    if (/^\/search\//i.test(p)) return 'search_other';
    if (/^\/in\/[^/]+/i.test(p)) return 'profile';
    if (/^\/feed(\/|$)/i.test(p)) return 'feed';
    if (/^\/company\/[^/]+/i.test(p)) return 'company';
    if (/^\/messaging(\/|$)/i.test(p)) return 'messaging';
    return 'other';
  } catch (_) {
    return 'other';
  }
}

/* ───────────────────────────── storage helpers ───────────────────────────── */

const store = {
  async get(key, factory) {
    const o = await chrome.storage.local.get(key);
    return o[key] === undefined ? factory() : o[key];
  },
  async set(key, val) {
    await chrome.storage.local.set({ [key]: val });
  },
};

// All read-modify-write operations go through one promise chain so concurrent messages cannot
// interleave and lose updates. Never call withLock() from inside a withLock() callback.
let lockChain = Promise.resolve();
function withLock(fn) {
  const p = lockChain.then(fn);
  lockChain = p.catch(() => {});
  return p;
}

function mutate(key, factory, fn) {
  return withLock(async () => {
    const cur = await store.get(key, factory);
    await fn(cur);
    await store.set(key, cur);
    return cur;
  });
}

/* ───────────────────────────── defaults & settings ───────────────────────────── */

function defaultTemplates() {
  return [
    {
      id: 'tpl-connect-1', kind: 'connect', name: 'Connect — short intro',
      body: 'Hi {{firstName}}, I came across your work as {{jobTitle}} at {{company}} and would enjoy connecting and following what you are building.',
    },
    {
      id: 'tpl-connect-2', kind: 'connect', name: 'Connect — shared interests',
      body: 'Hi {{firstName}}, I like to stay in touch with {{jobTitle}}s in {{location|your area}}. Would be great to connect.',
    },
    {
      id: 'tpl-message-1', kind: 'message', name: 'First message (existing connection)',
      body: 'Hi {{firstName}}, thanks for being connected. I would be glad to learn more about what you are focused on at {{company}} right now — is there anything I can help you think through?',
    },
    {
      id: 'tpl-followup-1', kind: 'followup', name: 'Day 2 — gentle follow-up',
      body: 'Hi {{firstName}}, following up in case my earlier note got buried. If it would help, I can share a short, practical idea for {{company}} — just say the word.',
    },
    {
      id: 'tpl-followup-2', kind: 'followup', name: 'Day 5 — value message',
      body: 'Hi {{firstName}}, one practical tip for a {{jobTitle}}: review your key numbers weekly rather than monthly — small, regular check-ins catch problems early. Happy to share how other teams approach it if useful.',
    },
    {
      id: 'tpl-followup-3', kind: 'followup', name: 'Day 10 — final follow-up',
      body: 'Hi {{firstName}}, I do not want to crowd your inbox, so this is my last note. If the timing is not right, no problem at all — wishing you and the team at {{company}} a great quarter.',
    },
    {
      id: 'tpl-post-1', kind: 'post', name: 'Weekly update',
      body: 'Weekly update — {{date}}\n\nThis week at {{companyName}}:\n• \n• \n• \n\nWhat are you working on? Tell us in the comments.',
    },
    {
      id: 'tpl-post-2', kind: 'post', name: 'Announcement',
      body: 'Announcement from {{companyName}} ({{month}} {{year}})\n\n',
    },
  ];
}

function defaultSettings() {
  return {
    accountMode: 'personal',
    companyPages: [],
    activeCompanyId: null,
    targeting: { titles: 'Founder, CEO, CFO, Ecommerce Manager', industry: '', location: '', companySize: '', keywords: '' },
    limits: { connections: 10, messages: 15, followUps: 15, posts: 2 },
    pacing: { cooldownMinSec: 90, cooldownMaxSec: 240, profileGapSec: 20 },
    autoMode: { enabled: false, maxPerRun: 5 },
    scheduledPublishing: false,
    templates: defaultTemplates(),
    selectedTemplates: { connect: 'tpl-connect-1', message: 'tpl-message-1' },
    followUps: [
      { day: 2, label: 'Follow-up', templateId: 'tpl-followup-1' },
      { day: 5, label: 'Value message', templateId: 'tpl-followup-2' },
      { day: 10, label: 'Final follow-up', templateId: 'tpl-followup-3' },
    ],
    exportFields: CSV_FIELDS.map((f) => f.key),
  };
}

function mergeSettings(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    if (!(k in base)) continue;
    const b = base[k];
    if (Array.isArray(b) || b === null || typeof b !== 'object') out[k] = over[k];
    else out[k] = { ...b, ...(over[k] || {}) };
  }
  return out;
}

async function getSettings() {
  const stored = await store.get(K.settings, () => ({}));
  return sanitizeSettings(mergeSettings(defaultSettings(), stored));
}

/** Clamp / validate every setting. Anything out of range is pulled back to a safe value. */
function sanitizeSettings(s) {
  const d = defaultSettings();
  s.accountMode = s.accountMode === 'company' ? 'company' : 'personal';

  for (const k of Object.keys(HARD_CAPS)) s.limits[k] = clampInt(s.limits[k], 0, HARD_CAPS[k], d.limits[k]);

  s.pacing.cooldownMinSec = clampInt(s.pacing.cooldownMinSec, MIN_COOLDOWN_SEC, 3600, d.pacing.cooldownMinSec);
  s.pacing.cooldownMaxSec = clampInt(s.pacing.cooldownMaxSec, s.pacing.cooldownMinSec, 7200, Math.max(s.pacing.cooldownMinSec, d.pacing.cooldownMaxSec));
  s.pacing.profileGapSec = clampInt(s.pacing.profileGapSec, MIN_PROFILE_GAP_SEC, 600, d.pacing.profileGapSec);

  s.autoMode.enabled = s.autoMode.enabled === true;
  s.autoMode.maxPerRun = clampInt(s.autoMode.maxPerRun, 1, 20, d.autoMode.maxPerRun);
  s.scheduledPublishing = s.scheduledPublishing === true;

  for (const k of ['titles', 'industry', 'location', 'companySize', 'keywords']) s.targeting[k] = str(s.targeting[k], 300);

  const kinds = ['connect', 'message', 'followup', 'post'];
  const seen = new Set();
  s.templates = (Array.isArray(s.templates) ? s.templates : [])
    .map((t) => ({
      id: str(t && t.id, 80) || uid('tpl'),
      kind: kinds.includes(t && t.kind) ? t.kind : 'message',
      name: str(t && t.name, 80) || 'Untitled template',
      body: String((t && t.body) || '').slice(0, POST_MAX),
    }))
    .filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
  if (!s.templates.length) s.templates = d.templates;

  const firstOf = (kind) => (s.templates.find((t) => t.kind === kind) || {}).id || null;
  for (const kind of ['connect', 'message']) {
    const cur = s.selectedTemplates && s.selectedTemplates[kind];
    if (!s.templates.some((t) => t.id === cur && t.kind === kind)) s.selectedTemplates[kind] = firstOf(kind);
  }

  s.followUps = (Array.isArray(s.followUps) ? s.followUps : [])
    .slice(0, 6)
    .map((f) => ({
      day: clampInt(f && f.day, 1, 90, 2),
      label: str(f && f.label, 40) || 'Follow-up',
      templateId: s.templates.some((t) => t.id === (f && f.templateId)) ? f.templateId : firstOf('followup'),
    }))
    .sort((a, b) => a.day - b.day);

  s.companyPages = (Array.isArray(s.companyPages) ? s.companyPages : [])
    .map((p) => ({ id: str(p && p.id, 120), name: str(p && p.name, 150), adminUrl: str(p && p.adminUrl, 300) }))
    .filter((p) => p.id && p.name && /^https:\/\/www\.linkedin\.com\/company\//i.test(p.adminUrl));
  if (!s.companyPages.some((p) => p.id === s.activeCompanyId)) s.activeCompanyId = s.companyPages[0] ? s.companyPages[0].id : null;

  const validKeys = CSV_FIELDS.map((f) => f.key);
  s.exportFields = (Array.isArray(s.exportFields) ? s.exportFields : validKeys).filter((k) => validKeys.includes(k));
  return s;
}

/* ───────────────────────────── job state ───────────────────────────── */

const newJob = () => ({
  id: null,
  kind: 'none',          // 'none' | 'outreach' | 'post'
  action: null,          // 'connect' | 'message' | 'followup' (outreach) or 'post'
  auto: false,
  state: 'idle',         // idle | running | paused | completed | error | restricted
  phase: 'none',         // none | preparing | awaiting_approval | sending | cooldown
  queue: [],
  total: 0, done: 0, skipped: 0, failed: 0, sent: 0,
  current: null,
  templateId: null,
  nextRunAt: 0,
  lastViewAt: 0,
  error: null,
  summary: '',
  startedAt: 0,
  updatedAt: 0,
});

async function getJob() {
  return { ...newJob(), ...(await store.get(K.job, newJob)) };
}

/**
 * Apply `fn` to the persisted job. A restricted account can never be un-restricted by an ordinary
 * mutation — only clearRestriction() passes { leaveRestricted: true }.
 */
function mutateJob(fn, opts = {}) {
  return withLock(async () => {
    const job = { ...newJob(), ...(await store.get(K.job, newJob)) };
    const was = job.state;
    fn(job);
    if (was === 'restricted' && job.state !== 'restricted' && !opts.leaveRestricted) job.state = 'restricted';
    job.updatedAt = Date.now();
    await store.set(K.job, job);
    refreshBadge(job);
    return job;
  });
}

async function getCounters() {
  const c = await store.get(K.counters, () => ({}));
  const base = { date: todayKey(), connections: 0, messages: 0, followUps: 0, posts: 0 };
  return c.date === base.date ? { ...base, ...c } : base;
}

function bump(key) {
  return withLock(async () => {
    let c = await store.get(K.counters, () => ({}));
    if (c.date !== todayKey()) c = { date: todayKey(), connections: 0, messages: 0, followUps: 0, posts: 0 };
    c[key] = (c[key] || 0) + 1;
    await store.set(K.counters, c);
  });
}

const getLeads = () => store.get(K.leads, () => ({}));
const getPosts = () => store.get(K.posts, () => []);

/** Append to the activity log. level: info | success | warn | error */
function log(level, message, extra = {}) {
  return mutate(K.log, () => [], (arr) => {
    arr.push({ ts: Date.now(), level, message: str(message, 600), ...extra });
    if (arr.length > LOG_MAX) arr.splice(0, arr.length - LOG_MAX);
  }).catch(() => {});
}

async function refreshBadge(jobArg) {
  try {
    const job = jobArg || (await getJob());
    let text = '';
    let color = '#2563eb';
    if (job.state === 'restricted') { text = 'X'; color = '#b91c1c'; }
    else if (job.state === 'error') { text = 'ERR'; color = '#b91c1c'; }
    else if (job.state === 'paused') { text = 'II'; color = '#d97706'; }
    else if (job.state === 'running' && job.phase === 'awaiting_approval') { text = '?'; color = '#7c3aed'; }
    else if (job.state === 'running') { text = 'ON'; color = '#059669'; }
    else {
      const [leads, settings] = await Promise.all([getLeads(), getSettings()]);
      const due = Object.values(leads).filter((l) => eligible(l, 'followup', settings, Date.now())).length;
      if (due > 0) text = String(Math.min(due, 99));
    }
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) { /* badge is cosmetic */ }
}

/* ───────────────────────────── lead model ───────────────────────────── */

function titleCaseName(s) {
  s = str(s, 80);
  if (!s) return '';
  if (s === s.toUpperCase() || s === s.toLowerCase()) {
    return s.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }
  return s;
}

function makeLead(raw, source) {
  const id = normalizeProfileUrl(raw.profileUrl);
  const t = iso();
  return {
    id,
    firstName: titleCaseName(raw.firstName),
    lastName: titleCaseName(raw.lastName),
    profileUrl: id,
    jobTitle: str(raw.jobTitle, 200),
    company: str(raw.company, 200),
    location: str(raw.location, 200),
    industry: str(raw.industry, 200),
    connectionStatus: CONNECTION_STATUSES.includes(raw.connectionStatus) ? raw.connectionStatus : 'Not Connected',
    messageStatus: MESSAGE_STATUSES.includes(raw.messageStatus) ? raw.messageStatus : 'Not Contacted',
    lastContacted: '',
    nextFollowUp: '',
    source: str(source || raw.source || 'manual', 100),
    notes: str(raw.notes, 2000),
    day0: '',            // ISO time of the first contact (connection request or first message)
    followUpStep: 0,     // number of follow-up steps already completed
    paused: false,       // user paused this lead
    createdAt: t,
    updatedAt: t,
  };
}

const connRank = { Unknown: 0, 'Not Connected': 1, Pending: 2, Connected: 3 };
const upgradeConnection = (a, b) => ((connRank[b] || 0) > (connRank[a] || 0) ? b : a);
const fullName = (l) => [l.firstName, l.lastName].filter(Boolean).join(' ');

async function upsertLeads(incoming, source) {
  let added = 0;
  let updated = 0;
  await mutate(K.leads, () => ({}), (leads) => {
    for (const raw of incoming) {
      const id = normalizeProfileUrl(raw && raw.profileUrl);
      if (!id) continue;
      const ex = leads[id];
      if (!ex) {
        leads[id] = makeLead({ ...raw, profileUrl: id }, source);
        added++;
        continue;
      }
      // Existing lead: only fill blanks / upgrade connection state; never overwrite the user's edits or statuses.
      let changed = false;
      for (const f of ['firstName', 'lastName', 'jobTitle', 'company', 'location', 'industry']) {
        if (!ex[f] && raw[f]) { ex[f] = f.endsWith('Name') ? titleCaseName(raw[f]) : str(raw[f], 200); changed = true; }
      }
      const up = upgradeConnection(ex.connectionStatus, raw.connectionStatus);
      if (up !== ex.connectionStatus) { ex.connectionStatus = up; changed = true; }
      if (changed) { ex.updatedAt = iso(); updated++; }
    }
  });
  return { added, updated, duplicates: incoming.length - added - updated };
}

function updateLead(id, fn) {
  return mutate(K.leads, () => ({}), (leads) => {
    const l = leads[id];
    if (l) { fn(l); l.updatedAt = iso(); }
  });
}

/** Reasons we must never contact a lead again (spec: replied / asked not to / converted / paused). */
function blockedReason(lead) {
  if (lead.paused) return 'lead is paused by you';
  if (lead.messageStatus === 'Replied') return 'lead has replied';
  if (lead.messageStatus === 'Do Not Contact') return 'lead asked not to be contacted';
  if (lead.messageStatus === 'Converted') return 'lead is marked converted';
  return null;
}

function isFollowUpDue(lead, settings, nowMs) {
  return !!(
    lead.nextFollowUp &&
    Date.parse(lead.nextFollowUp) <= nowMs &&
    lead.followUpStep < settings.followUps.length &&
    (lead.connectionStatus === 'Pending' || lead.connectionStatus === 'Connected')
  );
}

function eligible(lead, action, settings, nowMs) {
  if (!lead || blockedReason(lead)) return false;
  switch (action) {
    case 'connect':
      return !lead.day0 && ['Not Connected', 'Unknown', ''].includes(lead.connectionStatus || '');
    case 'message':
      return lead.connectionStatus === 'Connected' && (lead.messageStatus || 'Not Contacted') === 'Not Contacted';
    case 'followup':
      return isFollowUpDue(lead, settings, nowMs);
    default:
      return false;
  }
}

/** Next follow-up time after a touch: scheduled relative to Day 0, but never sooner than a day after the last touch. */
function computeNextFollowUp(lead, settings, nowMs) {
  const step = settings.followUps[lead.followUpStep];
  if (!step) return '';
  const day0 = lead.day0 ? Date.parse(lead.day0) : nowMs;
  return iso(Math.max(day0 + step.day * DAY_MS, nowMs + DAY_MS));
}

/* ───────────────────────────── templates ───────────────────────────── */

const VAR_RE = /\{\{\s*([A-Za-z]+)\s*(?:\|([^}]*))?\}\}/g;

/** {{name}} or {{name|fallback}}. Unresolved variables stay visible so the user must fix them. */
function renderTemplate(body, vars) {
  const missing = [];
  const text = String(body || '').replace(VAR_RE, (m, name, fallback) => {
    const v = vars[name];
    if (v !== undefined && String(v).trim()) return String(v).trim();
    if (fallback !== undefined && fallback.trim()) return fallback.trim();
    if (!missing.includes(name)) missing.push(name);
    return m;
  });
  return { text, missing };
}

const leadVars = (l) => ({
  firstName: l.firstName, lastName: l.lastName, company: l.company, jobTitle: l.jobTitle,
  location: l.location, industry: l.industry,
});

const LEAD_VAR_NAMES = ['firstName', 'lastName', 'company', 'jobTitle', 'location', 'industry'];
const templateHasLeadVars = (body) => {
  const names = [];
  String(body || '').replace(VAR_RE, (m, n) => names.push(n));
  return names.some((n) => LEAD_VAR_NAMES.includes(n));
};

function postVars(settings, companyName) {
  const d = new Date();
  return {
    date: d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    weekday: d.toLocaleDateString(undefined, { weekday: 'long' }),
    month: d.toLocaleDateString(undefined, { month: 'long' }),
    year: String(d.getFullYear()),
    companyName: companyName || '',
    pageName: companyName || '',
  };
}

function findTemplate(settings, id, kind) {
  return (
    settings.templates.find((t) => t.id === id && t.kind === kind) ||
    settings.templates.find((t) => t.kind === kind) ||
    null
  );
}

function templateIdFor(lead, action, settings, job) {
  if (action === 'followup') {
    const step = settings.followUps[lead.followUpStep];
    return step ? step.templateId : null;
  }
  return job.templateId || settings.selectedTemplates[action] || null;
}

/** Build the personalised draft + the warnings the reviewer must see. */
function buildDraft(lead, action, settings, job) {
  const tpl = findTemplate(settings, templateIdFor(lead, action, settings, job), action === 'followup' ? 'followup' : action);
  if (!tpl) return { text: '', missing: [], warnings: ['No template found for this action. Create one in Settings → Templates.'], templateId: null };
  const { text, missing } = renderTemplate(tpl.body, leadVars(lead));
  const warnings = [];
  if (missing.length) warnings.push(`Missing data for: ${missing.map((m) => `{{${m}}}`).join(', ')}. Fill it in before sending.`);
  if (action === 'connect' && text.length > CONNECT_NOTE_MAX) warnings.push(`Connection notes are limited to ${CONNECT_NOTE_MAX} characters (this one is ${text.length}).`);
  if (!templateHasLeadVars(tpl.body)) warnings.push('This template has no lead-specific variables, so it would be identical for everyone. Add {{firstName}} etc.');
  return { text, missing, warnings, templateId: tpl.id, hasLeadVars: templateHasLeadVars(tpl.body) };
}

function validateDraft(action, text) {
  const t = String(text == null ? '' : text);
  if (/\{\{[^}]*\}\}/.test(t)) return { ok: false, code: 'VALIDATION', message: 'The text still contains an unresolved {{placeholder}}. Replace it before sending.' };
  if (action === 'connect') {
    if (t.length > CONNECT_NOTE_MAX) return { ok: false, code: 'VALIDATION', message: `Connection notes are limited to ${CONNECT_NOTE_MAX} characters.` };
    return { ok: true };
  }
  if (!t.trim()) return { ok: false, code: 'VALIDATION', message: 'The message is empty.' };
  if (t.length > MESSAGE_MAX) return { ok: false, code: 'VALIDATION', message: `Messages are limited to ${MESSAGE_MAX} characters here.` };
  return { ok: true };
}

/* ───────────────────────────── CSV ───────────────────────────── */

/**
 * RFC 4180: CRLF record separators, fields containing comma / quote / CR / LF are quoted, quotes doubled.
 * Output starts with a UTF-8 BOM so Excel detects the encoding.
 * `neutralize` prefixes cells that start with = + - @ so spreadsheet apps cannot execute scraped text as a formula.
 */
function toCsv(rows, fields, neutralize) {
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (neutralize && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [fields.map((f) => esc(f.label)).join(',')];
  for (const r of rows) lines.push(fields.map((f) => esc(r[f.key])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/* ───────────────────────────── tab handling ───────────────────────────── */

async function getBoundTab() {
  const t = await store.get(K.tab, () => null);
  if (!t) return null;
  try {
    const tab = await chrome.tabs.get(t.tabId);
    if (!tab || !/^https:\/\/www\.linkedin\.com\//i.test(tab.url || '')) return null;
    return tab;
  } catch (_) {
    return null;
  }
}

async function bindTab(tab) {
  if (!tab || !/^https:\/\/www\.linkedin\.com\//i.test(tab.url || '')) {
    return { ok: false, code: 'NO_TAB', message: 'Open linkedin.com in the active tab first, then attach it.' };
  }
  const prev = await store.get(K.tab, () => null);
  await store.set(K.tab, { tabId: tab.id, windowId: tab.windowId });
  if (!prev || prev.tabId !== tab.id) await log('info', `Attached a LinkedIn tab (${pageTypeFromUrl(tab.url).replace(/_/g, ' ')} page).`);
  return { ok: true };
}

function rawSend(tabId, msg, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, code: 'CONTENT_TIMEOUT', message: `The LinkedIn page did not answer within ${Math.round(timeoutMs / 1000)} seconds.` });
    }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const lastErr = chrome.runtime.lastError;
        if (lastErr) resolve({ ok: false, code: 'CONTENT_UNAVAILABLE', message: lastErr.message });
        else resolve(resp || { ok: false, code: 'CONTENT_UNAVAILABLE', message: 'Empty response from the page.' });
      });
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, code: 'CONTENT_UNAVAILABLE', message: String(e && e.message || e) }); }
    }
  });
}

/** The static content script is only injected on page load; inject it on demand into tabs that were already open. */
async function ensureContent(tabId) {
  const ping = async () => {
    const r = await rawSend(tabId, { type: 'PING' }, 2500);
    return r && r.ok ? r : null;
  };
  if (await ping()) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (_) {
    return false;
  }
  await sleep(300);
  return !!(await ping());
}

async function callContent(tabId, msg, timeoutMs = CONTENT_TIMEOUT_MS) {
  if (!(await ensureContent(tabId))) {
    return { ok: false, code: 'CONTENT_UNAVAILABLE', message: 'Could not talk to the LinkedIn tab. Reload the tab and try again.' };
  }
  return rawSend(tabId, msg, timeoutMs);
}

const ALLOWED_NAV = [
  /^https:\/\/www\.linkedin\.com\/in\/[^/?#]+\/?/i,
  /^https:\/\/www\.linkedin\.com\/feed\/?/i,
  /^https:\/\/www\.linkedin\.com\/company\/[^/?#]+\//i,
  /^https:\/\/www\.linkedin\.com\/search\/results\/people\/?/i,
];

/** Navigate the attached tab (and only that tab) to an allow-listed LinkedIn URL and wait for load. */
async function navigateTab(tab, url) {
  if (!ALLOWED_NAV.some((re) => re.test(url))) {
    const e = new Error(`Refusing to navigate to ${url}`);
    e.code = 'UNSUPPORTED_PAGE';
    throw e;
  }
  const same = (a, b) => {
    const na = normalizeProfileUrl(a);
    return na ? na === normalizeProfileUrl(b) : a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  };
  if (tab.url && same(tab.url.split('?')[0], url) && tab.status === 'complete') return;
  await new Promise((resolve, reject) => {
    let done = false;
    let sawLoading = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (err) reject(err); else resolve();
    };
    const listener = (id, info) => {
      if (id !== tab.id) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) finish();
    };
    const timer = setTimeout(() => {
      const e = new Error(`LinkedIn did not finish loading within ${Math.round(NAV_TIMEOUT_MS / 1000)} seconds.`);
      e.code = 'NAV_TIMEOUT';
      finish(e);
    }, NAV_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tab.id, { url }).catch((err) => { const e = new Error(String(err && err.message || err)); e.code = 'NO_TAB'; finish(e); });
  });
}

/* ───────────────────────────── failure handling ───────────────────────────── */

function normalizeCode(code) {
  if (ERRORS[code]) return code;
  if (code === 'CONTENT_TIMEOUT') return 'NAV_TIMEOUT';
  return 'PAGE_CHANGED';
}

async function cancelAdvance() {
  try { await chrome.alarms.clear(ALARM_ADVANCE); } catch (_) { /* ignore */ }
}

/**
 * Stop gracefully with a classified error. paused → user can Resume after fixing the cause;
 * error → job ends (no retry loop); restricted → everything locks until the user clears the flag.
 */
async function failJob(rawCode, ctx = {}) {
  const code = normalizeCode(rawCode);
  const meta = ERRORS[code];
  const err = {
    code,
    label: meta.label,
    detail: str(ctx.detail, 400),
    action: ctx.action || '',
    leadName: ctx.leadName || '',
    selector: ctx.selector || '',
    ts: Date.now(),
  };
  await cancelAdvance();
  const job = await mutateJob((j) => {
    j.state = meta.state;
    j.error = err;
    j.nextRunAt = 0;
    if (meta.state === 'paused') {
      if (j.phase !== 'awaiting_approval') j.phase = 'none';
    } else {
      j.phase = 'none';
      j.current = null;
      if (meta.state === 'restricted') j.queue = [];
    }
  });
  const where = [ctx.action && `action: ${ctx.action}`, ctx.leadName && `lead: ${ctx.leadName}`, ctx.selector && `element: ${ctx.selector}`].filter(Boolean).join(' · ');
  await log(meta.state === 'paused' ? 'warn' : 'error', `${meta.label}${where ? ` (${where})` : ''}${err.detail ? ` — ${err.detail}` : ''}`, { code, leadId: ctx.leadId });
  return job;
}

async function failFromResult(res, ctx) {
  return failJob(res.code, { ...ctx, detail: res.message, selector: res.selector });
}

async function finishJob(summary) {
  await cancelAdvance();
  const job = await mutateJob((j) => {
    j.state = 'completed';
    j.phase = 'none';
    j.current = null;
    j.nextRunAt = 0;
    j.summary = summary || 'Queue finished';
  });
  await log('success', `Completed: ${job.summary} (${job.sent} sent, ${job.skipped} skipped).`);
  return job;
}

/* ───────────────────────────── outreach engine ───────────────────────────── */

let advancing = false;
const onUnexpected = (e) => {
  console.error('LeadPilot unexpected error', e);
  failJob('PAGE_CHANGED', { detail: `Unexpected extension error: ${e && e.message || e}` }).catch(() => {});
};

function scheduleAdvance(atMs) {
  const delay = Math.max(0, atMs - Date.now());
  try { chrome.alarms.create(ALARM_ADVANCE, { when: Math.max(atMs, Date.now() + 31000) }); } catch (_) { /* ignore */ }
  // Alarms have a ~30 s floor; short UX gaps use a timer, the alarm is only a restart-proof backup.
  if (delay <= 25000) setTimeout(() => { advance().catch(onUnexpected); }, delay);
}

function advance() {
  if (advancing) return Promise.resolve();
  advancing = true;
  return advanceInner().finally(() => { advancing = false; });
}

async function skipCurrent(leadId, name, reason, level = 'info') {
  await mutateJob((j) => {
    j.skipped++;
    j.phase = 'none';
    j.current = null;
  });
  await log(level, `Skipped ${name || leadId}: ${reason}`, { leadId });
}

async function advanceInner() {
  for (let guard = 0; guard < 1000; guard++) {
    let job = await getJob();
    if (job.state !== 'running' || job.kind !== 'outreach') return;
    if (job.phase === 'awaiting_approval' || job.phase === 'sending' || job.phase === 'preparing') return;

    const settings = await getSettings();
    const gapMs = settings.pacing.profileGapSec * 1000;
    const readyAt = Math.max(job.nextRunAt || 0, (job.lastViewAt || 0) + gapMs);
    if (readyAt > Date.now()) {
      await mutateJob((j) => { if (j.phase !== 'cooldown') j.phase = 'cooldown'; j.nextRunAt = readyAt; });
      scheduleAdvance(readyAt);
      return;
    }

    const counters = await getCounters();
    const budgetKey = BUDGET_KEY[job.action];
    if ((counters[budgetKey] || 0) >= settings.limits[budgetKey]) {
      await finishJob(`Daily limit for ${ACTION_LABEL[job.action]}s reached (${settings.limits[budgetKey]})`);
      return;
    }
    if (job.auto && job.sent >= settings.autoMode.maxPerRun) {
      await finishJob(`Conservative Auto Mode run cap reached (${settings.autoMode.maxPerRun})`);
      return;
    }
    if (!job.queue.length) { await finishJob('Queue finished'); return; }

    const tab = await getBoundTab();
    if (!tab) { await failJob('NO_TAB', { detail: 'The attached LinkedIn tab was closed or left linkedin.com.' }); return; }

    const leadId = job.queue[0];
    const leads = await getLeads();
    const lead = leads[leadId];
    if (!lead || !eligible(lead, job.action, settings, Date.now())) {
      await mutateJob((j) => { j.queue.shift(); j.skipped++; });
      await log('info', `Skipped ${lead ? fullName(lead) : leadId}: no longer eligible (${lead ? blockedReason(lead) || 'status changed' : 'lead removed'}).`, { leadId });
      continue;
    }

    const name = fullName(lead);
    await mutateJob((j) => {
      j.queue.shift();
      j.phase = 'preparing';
      j.current = { leadId, action: j.action, name, draft: '', warnings: [], missing: [], templateId: null, auto: false, preparedAt: 0 };
      j.lastViewAt = Date.now();
    });

    // 1. Go to the lead's profile in the attached tab and read it (no clicks that change anything).
    let prep;
    try {
      await navigateTab(tab, lead.profileUrl);
      prep = await callContent(tab.id, {
        type: 'PREPARE_PROFILE',
        action: job.action,
        expectedUrl: lead.profileUrl,
        expectedName: name,
      });
    } catch (e) {
      prep = { ok: false, code: e.code || 'NAV_TIMEOUT', message: e.message };
    }

    job = await getJob();
    if (job.state !== 'running' || !job.current || job.current.leadId !== leadId) return; // paused / stopped meanwhile

    if (!prep.ok) {
      if (prep.code === 'ACTION_UNAVAILABLE') { await skipCurrent(leadId, name, prep.message || 'action not available on this profile', 'warn'); continue; }
      await failFromResult(prep, { action: ACTION_LABEL[job.action], leadName: name, leadId });
      return;
    }
    if (prep.profileUnavailable) {
      await updateLead(leadId, (l) => { l.paused = true; l.connectionStatus = 'Unknown'; l.notes = str(`${l.notes} [Profile unavailable ${todayKey()}]`, 2000); });
      await skipCurrent(leadId, name, 'profile is unavailable or not found (lead paused)', 'warn');
      continue;
    }

    // 2. Refresh the lead from the visible profile (fresher data = better personalisation).
    const p = prep.profile || {};
    const conn = (prep.connection && prep.connection.state) || 'unknown';
    await updateLead(leadId, (l) => {
      if (p.firstName) l.firstName = titleCaseName(p.firstName);
      if (p.lastName) l.lastName = titleCaseName(p.lastName);
      if (p.jobTitle) l.jobTitle = str(p.jobTitle, 200);
      if (p.company) l.company = str(p.company, 200);
      if (p.location) l.location = str(p.location, 200);
      if (conn === 'connected') l.connectionStatus = 'Connected';
      else if (conn === 'pending') l.connectionStatus = upgradeConnection(l.connectionStatus, 'Pending');
    });

    const fresh = (await getLeads())[leadId];
    const freshName = fullName(fresh);

    // 3. Decide whether this lead can take this action right now.
    if (job.action === 'connect') {
      if (conn === 'connected') { await skipCurrent(leadId, freshName, 'already a 1st-degree connection'); continue; }
      if (conn === 'pending') { await skipCurrent(leadId, freshName, 'an invitation is already pending'); continue; }
      if (conn !== 'connect' && conn !== 'connect_via_menu') { await skipCurrent(leadId, freshName, 'LinkedIn offers no Connect option for this profile', 'warn'); continue; }
    } else {
      if (conn === 'pending') {
        if (job.action === 'followup') {
          await updateLead(leadId, (l) => { l.nextFollowUp = iso(Date.now() + 2 * DAY_MS); });
        }
        await skipCurrent(leadId, freshName, 'connection still pending — nothing to send yet (follow-up moved 2 days)');
        continue;
      }
      if (conn !== 'connected') { await skipCurrent(leadId, freshName, 'not confirmed as a 1st-degree connection — messaging is only for existing connections', 'warn'); continue; }
      if (prep.thread && prep.thread.status === 'replied') {
        await updateLead(leadId, (l) => { l.messageStatus = 'Replied'; l.nextFollowUp = ''; });
        await skipCurrent(leadId, freshName, 'they already replied in the conversation (marked Replied)');
        continue;
      }
    }

    // 4. Draft the personalised text and wait for the human.
    const draft = buildDraft(fresh, job.action, settings, job);
    if (prep.thread && prep.thread.status === 'unknown') draft.warnings.push('Could not read the conversation history — check LinkedIn for earlier replies before sending.');
    const autoOk = job.auto && !draft.missing.length && draft.hasLeadVars && validateDraft(job.action, draft.text).ok && !draft.warnings.length;
    await mutateJob((j) => {
      j.phase = 'awaiting_approval';
      j.current = { leadId, action: j.action, name: freshName, draft: draft.text, original: draft.text, warnings: draft.warnings, missing: draft.missing, templateId: draft.templateId, auto: !!autoOk, preparedAt: Date.now(), profile: p, connection: prep.connection };
    });
    await log('info', `Draft ready for ${freshName} (${ACTION_LABEL[job.action]}) — ${autoOk ? 'Conservative Auto Mode will send it' : 'waiting for your review'}.`, { leadId, action: job.action });

    if (autoOk) {
      // Short, ordinary UX pause so the page settles and the user can still hit Pause/Stop.
      await sleep(rand(4000, 9000));
      const j2 = await getJob();
      if (j2.state !== 'running' || j2.phase !== 'awaiting_approval' || !j2.current || j2.current.leadId !== leadId) return;
      await sendCurrent(draft.text, 'auto');
    }
    return;
  }
}

/** Run the approved action in the visible LinkedIn UI, record it, and schedule the next lead. */
async function sendCurrent(finalText, how) {
  const [settings, job0] = await Promise.all([getSettings(), getJob()]);
  const cur = job0.current;
  if (job0.state !== 'running' || job0.phase !== 'awaiting_approval' || !cur) {
    return { ok: false, code: 'VALIDATION', message: 'Nothing is waiting for approval (automation may be paused or stopped).' };
  }
  const action = cur.action;
  const leads = await getLeads();
  const lead = leads[cur.leadId];
  if (!lead) { await skipCurrent(cur.leadId, cur.name, 'lead was removed'); scheduleAdvance(Date.now()); return { ok: false, message: 'Lead was removed.' }; }
  const blocked = blockedReason(lead);
  if (blocked) {
    await skipCurrent(cur.leadId, cur.name, `${blocked} — not sent`);
    scheduleAdvance(Date.now() + 1000);
    return { ok: false, code: 'VALIDATION', message: `Not sent: ${blocked}.` };
  }
  const counters = await getCounters();
  const key = BUDGET_KEY[action];
  if ((counters[key] || 0) >= settings.limits[key]) {
    await finishJob(`Daily limit for ${ACTION_LABEL[action]}s reached (${settings.limits[key]})`);
    return { ok: false, code: 'LIMIT_REACHED', message: 'Daily limit reached — nothing was sent.' };
  }
  const v = validateDraft(action, finalText);
  if (!v.ok) return v;
  const tab = await getBoundTab();
  if (!tab) { await failJob('NO_TAB', { detail: 'The attached LinkedIn tab is gone.', action: ACTION_LABEL[action], leadName: cur.name }); return { ok: false, code: 'NO_TAB', message: 'No attached LinkedIn tab.' }; }

  await mutateJob((j) => { j.phase = 'sending'; if (j.current) { j.current.finalText = finalText; j.current.sendStartedAt = Date.now(); } });
  await log('info', `Attempting ${ACTION_LABEL[action]} to ${cur.name} (${how === 'auto' ? 'Conservative Auto Mode' : 'approved by you'}): "${str(finalText, 300)}"`, { leadId: cur.leadId, action });

  let res;
  try {
    await navigateTab(tab, lead.profileUrl); // no-op when the tab is still on the profile
    res = await callContent(tab.id, {
      type: 'EXECUTE_ACTION',
      action,
      text: finalText,
      expectedUrl: lead.profileUrl,
      expectedName: fullName(lead),
    }, 90000);
  } catch (e) {
    res = { ok: false, code: e.code || 'NAV_TIMEOUT', message: e.message };
  }

  const attempted = res.ok || res.clicked === true; // Send was actually clicked → counts against the budget
  if (attempted) await recordSend(lead, action, finalText, res, how);

  if (!res.ok) {
    if (res.code === 'ACTION_UNAVAILABLE' && !attempted) {
      if (res.replied) await updateLead(cur.leadId, (l) => { l.messageStatus = 'Replied'; l.nextFollowUp = ''; });
      await skipCurrent(cur.leadId, cur.name, res.message || 'action not available', 'warn');
      scheduleAdvance(Date.now() + 1000);
      return { ok: false, code: 'ACTION_UNAVAILABLE', message: res.message };
    }
    await failFromResult(res, { action: ACTION_LABEL[action], leadName: cur.name, leadId: cur.leadId });
    return { ok: false, code: res.code, message: res.message };
  }

  // Success: cooldown, then the next lead (only if the user did not pause/stop meanwhile).
  const cdMs = rand(settings.pacing.cooldownMinSec, settings.pacing.cooldownMaxSec) * 1000;
  const after = await mutateJob((j) => {
    j.sent++;
    j.done++;
    j.current = null;
    if (j.state === 'running') { j.phase = 'cooldown'; j.nextRunAt = Date.now() + cdMs; }
    else j.phase = 'none';
  });
  if (after.state === 'running') {
    if (!after.queue.length) await finishJob('Queue finished');
    else scheduleAdvance(after.nextRunAt);
  }
  return { ok: true, verified: res.verified !== false };
}

/** Update counters, lead status, follow-up schedule and the activity log after a send attempt. */
async function recordSend(lead, action, text, res, how) {
  const settings = await getSettings();
  await bump(BUDGET_KEY[action]);
  const nowMs = Date.now();
  await updateLead(lead.id, (l) => {
    l.lastContacted = iso(nowMs);
    if (!l.day0) l.day0 = iso(nowMs);
    if (action === 'connect') {
      l.connectionStatus = 'Pending';
      l.followUpStep = 0;
    } else if (action === 'message') {
      l.messageStatus = 'Messaged';
    } else {
      l.messageStatus = l.messageStatus === 'Not Contacted' ? 'Messaged' : 'Followed Up';
      l.followUpStep = (l.followUpStep || 0) + 1;
    }
    l.nextFollowUp = computeNextFollowUp(l, settings, nowMs);
  });
  const verifiedTxt = res.ok && res.verified === false ? ' (sent, but LinkedIn did not visibly confirm — please verify)' : '';
  await log(res.ok ? 'success' : 'warn', `${how === 'auto' ? 'Auto-sent' : 'Sent'} ${ACTION_LABEL[action]} to ${fullName(lead)}${verifiedTxt}.`, { leadId: lead.id, action, text: str(text, 500) });
}

/* ───────────────────────────── job commands ───────────────────────────── */

async function startJob({ action, leadIds, templateId }) {
  if (!ACTIONS.includes(action)) return { ok: false, code: 'VALIDATION', message: 'Unknown action.' };
  const [settings, job] = await Promise.all([getSettings(), getJob()]);
  if (job.state === 'restricted') return { ok: false, code: 'ACCOUNT_RESTRICTED', message: 'LinkedIn flagged a restriction. Resolve it on LinkedIn, then clear the flag in the popup.' };
  if (job.state === 'running' || job.state === 'paused') return { ok: false, code: 'VALIDATION', message: 'An automation is already active — Resume it or Stop it first.' };
  if (settings.accountMode !== 'personal') {
    return { ok: false, code: 'MODE_MISMATCH', message: 'Connection requests and messages are personal actions. Switch to "Personal Profile" — a Company Page never sends them.' };
  }
  const tab = await getBoundTab();
  if (!tab) return { ok: false, code: 'NO_TAB', message: 'Attach a LinkedIn tab first (open linkedin.com, click the extension, press "Attach this tab").' };

  const counters = await getCounters();
  const key = BUDGET_KEY[action];
  const remaining = settings.limits[key] - (counters[key] || 0);
  if (remaining <= 0) return { ok: false, code: 'LIMIT_REACHED', message: `Today's ${ACTION_LABEL[action]} budget (${settings.limits[key]}) is used up. Raise it in Settings or wait until tomorrow.` };

  if (action !== 'followup') {
    const tpl = findTemplate(settings, templateId || settings.selectedTemplates[action], action);
    if (!tpl) return { ok: false, code: 'VALIDATION', message: 'Select a template for this action first.' };
    templateId = tpl.id;
  }
  if (settings.autoMode.enabled) {
    const bodies = action === 'followup'
      ? settings.followUps.map((f) => (settings.templates.find((t) => t.id === f.templateId) || {}).body)
      : [(settings.templates.find((t) => t.id === templateId) || {}).body];
    if (bodies.some((b) => !templateHasLeadVars(b))) {
      return { ok: false, code: 'VALIDATION', message: 'Conservative Auto Mode needs every template to contain at least one lead-specific variable such as {{firstName}} — otherwise everyone would receive the identical text.' };
    }
  }

  const leads = await getLeads();
  const nowMs = Date.now();
  const pool = Array.isArray(leadIds) && leadIds.length ? leadIds.map((id) => leads[id]).filter(Boolean) : Object.values(leads);
  let cands = pool.filter((l) => eligible(l, action, settings, nowMs));
  if (action === 'followup') cands.sort((a, b) => Date.parse(a.nextFollowUp) - Date.parse(b.nextFollowUp));
  else cands.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const cap = settings.autoMode.enabled ? Math.min(remaining, settings.autoMode.maxPerRun) : remaining;
  cands = cands.slice(0, cap);
  if (!cands.length) return { ok: false, code: 'VALIDATION', message: `No eligible leads for a ${ACTION_LABEL[action]} (leads that replied, asked not to be contacted, converted or are paused are always excluded).` };

  const started = await mutateJob((j) => {
    Object.assign(j, newJob(), {
      id: uid('job'), kind: 'outreach', action, auto: settings.autoMode.enabled, state: 'running', phase: 'none',
      queue: cands.map((l) => l.id), total: cands.length, templateId: templateId || null, startedAt: Date.now(),
    });
  });
  await log('info', `Started ${ACTION_LABEL[action]} run: ${cands.length} lead(s) queued, ${started.auto ? 'Conservative Auto Mode' : 'Review Before Send'}.`);
  advance().catch(onUnexpected);
  return { ok: true, queued: cands.length };
}

async function pauseJob() {
  const job = await getJob();
  if (job.state !== 'running') return { ok: false, message: 'Nothing is running.' };
  if (job.kind === 'post') return { ok: false, message: 'Publishing takes a few seconds and cannot be interrupted midway.' };
  await cancelAdvance();
  await mutateJob((j) => { j.state = 'paused'; j.error = { code: 'USER_PAUSED', label: 'Paused by you', detail: '', ts: Date.now() }; j.nextRunAt = 0; if (j.phase !== 'awaiting_approval' && j.phase !== 'sending') j.phase = 'none'; });
  await log('info', 'Automation paused by you.');
  return { ok: true };
}

async function resumeJob() {
  const job = await getJob();
  if (job.state !== 'paused') return { ok: false, message: 'Automation is not paused.' };
  if (job.phase === 'sending') return { ok: false, message: 'A send is still finishing — try again in a few seconds.' };
  const tab = await getBoundTab();
  if (!tab) return { ok: false, code: 'NO_TAB', message: 'Attach a LinkedIn tab first.' };
  // Re-check LinkedIn before continuing: a challenge must have been resolved by the human.
  const scan = await callContent(tab.id, { type: 'SCAN_SAFETY' }, 15000);
  if (scan.ok && scan.finding && scan.finding.status !== 'ok') {
    const code = FINDING_TO_CODE[scan.finding.status];
    await failJob(code, { detail: scan.finding.evidence });
    return { ok: false, code, message: `LinkedIn still shows: ${scan.finding.evidence || ERRORS[code].label}. Resolve it manually in the tab first.` };
  }
  if (!scan.ok) return { ok: false, code: normalizeCode(scan.code), message: scan.message || 'Could not check the LinkedIn page.' };

  const inFlight = advancing;
  const after = await mutateJob((j) => {
    j.error = null;
    if (j.kind !== 'outreach' || (!j.queue.length && !j.current)) { j.state = 'idle'; j.phase = 'none'; return; }
    j.state = 'running';
    if (j.current && j.phase !== 'awaiting_approval' && !inFlight) {
      j.queue.unshift(j.current.leadId); // redo this lead from the profile read
      j.current = null;
      j.phase = 'none';
    }
  });
  await log('info', 'Automation resumed by you.');
  if (after.state === 'running') advance().catch(onUnexpected);
  return { ok: true };
}

async function stopJob() {
  const job = await getJob();
  if (job.state === 'restricted') return { ok: false, message: 'Account is flagged as restricted — use "Clear restriction flag" after resolving it on LinkedIn.' };
  await cancelAdvance();
  await mutateJob((j) => {
    j.state = 'idle'; j.phase = 'none'; j.queue = []; j.nextRunAt = 0; j.current = null;
    j.error = { code: 'USER_STOPPED', label: ERRORS.USER_STOPPED.label, detail: '', ts: Date.now() };
  });
  await log('info', 'Automation stopped by you.', { code: 'USER_STOPPED' });
  return { ok: true };
}

async function clearRestriction() {
  const job = await getJob();
  if (job.state !== 'restricted') return { ok: false, message: 'No restriction flag is set.' };
  await mutateJob((j) => { Object.assign(j, newJob()); j.error = null; }, { leaveRestricted: true });
  await log('warn', 'Restriction flag cleared manually by you. Make sure LinkedIn no longer shows a restriction before automating again.');
  return { ok: true };
}

async function approveSend(text) {
  const job = await getJob();
  if (job.state !== 'running' || job.phase !== 'awaiting_approval' || !job.current) {
    return { ok: false, code: 'VALIDATION', message: 'Nothing is waiting for approval.' };
  }
  return sendCurrent(String(text == null ? job.current.draft : text), 'user');
}

async function updateDraft(text) {
  await mutateJob((j) => { if (j.current && j.phase === 'awaiting_approval') j.current.draft = String(text || '').slice(0, MESSAGE_MAX + 100); });
  return { ok: true };
}

async function regenerateDraft() {
  const [settings, job] = await Promise.all([getSettings(), getJob()]);
  if (!job.current || job.phase !== 'awaiting_approval') return { ok: false, message: 'No draft to regenerate.' };
  const lead = (await getLeads())[job.current.leadId];
  if (!lead) return { ok: false, message: 'Lead not found.' };
  const d = buildDraft(lead, job.current.action, settings, job);
  await mutateJob((j) => { if (j.current) { j.current.draft = d.text; j.current.warnings = d.warnings; j.current.missing = d.missing; j.current.auto = false; } });
  return { ok: true };
}

async function skipLead() {
  const job = await getJob();
  if (job.state !== 'running' || job.phase !== 'awaiting_approval' || !job.current) return { ok: false, message: 'Nothing to skip.' };
  await skipCurrent(job.current.leadId, job.current.name, 'skipped by you');
  scheduleAdvance(Date.now());
  return { ok: true };
}

/* ───────────────────────────── page-level (non-queue) actions ───────────────────────────── */

/** Resolve the tab for one-off actions (collect / detect / engagement). Binds the active LinkedIn tab if none is attached. */
async function tabForOneOff(hintTab) {
  // The user pressed a button while looking at this tab, so it is the one they mean.
  if (hintTab && /^https:\/\/www\.linkedin\.com\//i.test(hintTab.url || '')) {
    const r = await bindTab(hintTab);
    if (r.ok) return getBoundTab();
  }
  return getBoundTab();
}

async function guardIdle(label) {
  const job = await getJob();
  if (job.state === 'restricted') return { ok: false, code: 'ACCOUNT_RESTRICTED', message: 'Account flagged as restricted — all actions are locked.' };
  if (job.state === 'running') return { ok: false, code: 'VALIDATION', message: `${label} is unavailable while automation is running. Pause or stop it first.` };
  if (job.state === 'paused') return { ok: false, code: 'VALIDATION', message: `${label} is unavailable while automation is paused for a LinkedIn warning. Resolve it, then Resume or Stop.` };
  return null;
}

async function collectLeads(hintTab) {
  const blocked = await guardIdle('Collecting leads');
  if (blocked) return blocked;
  const settings = await getSettings();
  if (settings.accountMode !== 'personal') return { ok: false, code: 'MODE_MISMATCH', message: 'Lead collection uses the personal people-search. Switch to "Personal Profile".' };
  const tab = await tabForOneOff(hintTab);
  if (!tab) return { ok: false, code: 'NO_TAB', message: 'Open a LinkedIn people-search results page and attach the tab.' };
  const res = await callContent(tab.id, { type: 'COLLECT_LEADS', industry: settings.targeting.industry });
  if (!res.ok) {
    if (res.code === 'WRONG_PAGE') return { ok: false, code: 'WRONG_PAGE', message: res.message };
    await failFromResult(res, { action: 'collect leads' });
    return { ok: false, code: normalizeCode(res.code), message: res.message };
  }
  const src = `LinkedIn search ${todayKey()}`;
  const counts = await upsertLeads(res.leads, src);
  const skipped = (res.failures || []).length;
  await log('success', `Collected ${res.leads.length} visible lead(s) from the search page: ${counts.added} new, ${counts.updated} updated, ${counts.duplicates} already known.${skipped ? ` ${skipped} card(s) could not be read.` : ''}`, { action: 'collect' });
  for (const f of (res.failures || []).slice(0, 5)) await log('warn', `Card ${f.index + 1} skipped: ${f.reason}`, { action: 'collect' });
  return { ok: true, ...counts, skipped, found: res.leads.length, note: res.note || '' };
}

function buildSearchUrl(t) {
  const titles = String(t.titles || '').split(',').map((x) => x.trim()).filter(Boolean);
  const titleExpr = titles.length ? `(${titles.map((x) => `"${x}"`).join(' OR ')})` : '';
  const kw = [titleExpr, t.keywords, t.industry, t.location].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(kw)}&origin=GLOBAL_SEARCH_HEADER`;
}

async function openSearch(hintTab) {
  const blocked = await guardIdle('Opening the search');
  if (blocked) return blocked;
  const settings = await getSettings();
  const tab = await tabForOneOff(hintTab);
  if (!tab) return { ok: false, code: 'NO_TAB', message: 'Attach a LinkedIn tab first.' };
  try {
    await navigateTab(tab, buildSearchUrl(settings.targeting));
  } catch (e) {
    await failJob(e.code || 'NAV_TIMEOUT', { detail: e.message, action: 'open search' });
    return { ok: false, code: e.code || 'NAV_TIMEOUT', message: e.message };
  }
  await log('info', 'Opened the LinkedIn people search for your targeting. Apply location / industry / company-size filters in LinkedIn, then press "Collect from this page".');
  return { ok: true };
}

async function addCompanyFromTab(hintTab) {
  const blocked = await guardIdle('Detecting the Company Page');
  if (blocked) return blocked;
  const tab = await tabForOneOff(hintTab);
  if (!tab) return { ok: false, code: 'NO_TAB', message: 'Open your Company Page admin view and attach the tab.' };
  const res = await callContent(tab.id, { type: 'DETECT_COMPANY' }, 20000);
  if (!res.ok) return { ok: false, code: normalizeCode(res.code), message: res.message };
  const c = res.company;
  if (!c || !c.isCompanyPage) return { ok: false, code: 'WRONG_PAGE', message: 'This tab is not a LinkedIn Company Page. Open the page you administer first.' };
  if (!c.isAdminView) return { ok: false, code: 'WRONG_PAGE', message: 'This is the public view. Switch to the admin view of the page (you must be a Super/Content admin) so it can be used for posting.' };
  const settings = await getSettings();
  const page = { id: c.slug, name: c.name, adminUrl: c.adminUrl };
  const next = settings.companyPages.filter((p) => p.id !== page.id).concat(page);
  await saveSettings({ companyPages: next, activeCompanyId: page.id });
  await log('success', `Company Page "${page.name}" added as an administered page.`);
  return { ok: true, page };
}

/* ───────────────────────────── posts ───────────────────────────── */

function postTarget(settings, post) {
  if (post.target === 'company') {
    const page = settings.companyPages.find((p) => p.id === post.companyId);
    return { target: 'company', page };
  }
  return { target: 'personal', page: null };
}

async function savePost(p) {
  const settings = await getSettings();
  const text = String(p.text || '').slice(0, POST_MAX);
  if (!text.trim()) return { ok: false, code: 'VALIDATION', message: 'The post is empty.' };
  const target = p.target === 'company' ? 'company' : 'personal';
  let companyId = null;
  if (target === 'company') {
    companyId = p.companyId || settings.activeCompanyId;
    if (!settings.companyPages.some((x) => x.id === companyId)) return { ok: false, code: 'VALIDATION', message: 'Select an administered Company Page first (Settings → Company Pages).' };
  }
  let scheduledFor = '';
  if (p.scheduledFor) {
    const t = Date.parse(p.scheduledFor);
    if (!Number.isFinite(t)) return { ok: false, code: 'VALIDATION', message: 'Invalid schedule time.' };
    scheduledFor = iso(t);
  }
  let saved = null;
  await mutate(K.posts, () => [], (posts) => {
    let post = p.id ? posts.find((x) => x.id === p.id) : null;
    if (post && post.status === 'published') { saved = null; return; }
    if (!post) {
      post = { id: uid('post'), createdAt: iso(), status: 'draft', engagement: null };
      posts.unshift(post);
    }
    Object.assign(post, { target, companyId, text, scheduledFor, templateId: p.templateId || null, updatedAt: iso() });
    post.status = scheduledFor ? 'scheduled' : 'draft';
    if (posts.length > POSTS_MAX) posts.length = POSTS_MAX;
    saved = post;
  });
  if (!saved) return { ok: false, code: 'VALIDATION', message: 'Published posts cannot be edited.' };
  await log('info', `Post ${scheduledFor ? `scheduled for ${new Date(scheduledFor).toLocaleString()}` : 'draft saved'} (${target === 'company' ? 'Company Page' : 'Personal Profile'}).`, { action: 'post' });
  return { ok: true, post: saved };
}

async function deletePost(id) {
  await mutate(K.posts, () => [], (posts) => { const i = posts.findIndex((x) => x.id === id); if (i >= 0) posts.splice(i, 1); });
  return { ok: true };
}

/**
 * Publish through the visible LinkedIn composer. Only reachable from an explicit user click
 * (PUBLISH_POST) or from a due post when the user deliberately enabled scheduled publishing.
 */
async function publishPost(id, textOverride, opts = {}) {
  const settings = await getSettings();
  const job = await getJob();
  if (job.state === 'restricted') return { ok: false, code: 'ACCOUNT_RESTRICTED', message: 'Account flagged as restricted — publishing is locked.' };
  if (job.state === 'running' || job.state === 'paused') return { ok: false, code: 'VALIDATION', message: 'Another automation is active. Stop or finish it before publishing.' };

  const posts = await getPosts();
  const post = posts.find((x) => x.id === id);
  if (!post) return { ok: false, code: 'VALIDATION', message: 'Post not found.' };
  if (post.status === 'published') return { ok: false, code: 'VALIDATION', message: 'This post was already published.' };

  const { target, page } = postTarget(settings, post);
  if (target === 'company' && !page) return { ok: false, code: 'VALIDATION', message: 'The Company Page for this post is no longer in your administered pages list.' };

  const counters = await getCounters();
  if ((counters.posts || 0) >= settings.limits.posts) return { ok: false, code: 'LIMIT_REACHED', message: `Today's post budget (${settings.limits.posts}) is used up.` };

  const tab = await getBoundTab();
  if (!tab) return { ok: false, code: 'NO_TAB', message: 'Attach a LinkedIn tab first.' };

  const rawText = textOverride != null ? String(textOverride) : post.text;
  const { text, missing } = renderTemplate(rawText, postVars(settings, page ? page.name : ''));
  if (missing.length) return { ok: false, code: 'VALIDATION', message: `Fill in ${missing.map((m) => `{{${m}}}`).join(', ')} before publishing.` };
  if (!text.trim()) return { ok: false, code: 'VALIDATION', message: 'The post is empty.' };
  if (text.length > POST_MAX) return { ok: false, code: 'VALIDATION', message: `Posts are limited to ${POST_MAX} characters.` };

  await mutateJob((j) => {
    Object.assign(j, newJob(), { id: uid('job'), kind: 'post', action: 'post', state: 'running', phase: 'preparing', total: 1, startedAt: Date.now(), summary: '' });
    j.current = { postId: id, name: target === 'company' ? page.name : 'Personal Profile', action: 'post' };
  });
  await log('info', `Attempting to publish a post as ${target === 'company' ? `Company Page "${page.name}"` : 'your Personal Profile'}${opts.scheduled ? ' (scheduled publishing)' : ' (approved by you)'}: "${str(text, 200)}"`, { action: 'post' });

  const url = target === 'company' ? page.adminUrl : 'https://www.linkedin.com/feed/';
  let res;
  try {
    await navigateTab(tab, url);
    await mutateJob((j) => { j.phase = 'sending'; });
    res = await callContent(tab.id, {
      type: 'PUBLISH_POST',
      target,
      text,
      companyName: page ? page.name : '',
      otherPageNames: settings.companyPages.map((p) => p.name),
    }, 90000);
  } catch (e) {
    res = { ok: false, code: e.code || 'NAV_TIMEOUT', message: e.message };
  }

  if (!res.ok) {
    await mutate(K.posts, () => [], (ps) => { const p = ps.find((x) => x.id === id); if (p && res.clicked) { p.status = 'needs_check'; p.note = 'Post button was clicked but LinkedIn did not confirm. Check LinkedIn.'; } });
    if (res.clicked) await bump('posts');
    await failFromResult(res, { action: 'publish post' });
    return { ok: false, code: normalizeCode(res.code), message: res.message };
  }

  await bump('posts');
  await mutate(K.posts, () => [], (ps) => {
    const p = ps.find((x) => x.id === id);
    if (p) { p.status = 'published'; p.publishedAt = iso(); p.publishedText = text; p.identity = res.identity || ''; p.verified = res.verified !== false; p.text = rawText; }
  });
  await mutateJob((j) => { j.state = 'completed'; j.phase = 'none'; j.current = null; j.done = 1; j.sent = 1; j.summary = 'Post published'; j.error = null; });
  await log('success', `Post published as ${res.identity || (target === 'company' ? page.name : 'your Personal Profile')}${res.verified === false ? ' (LinkedIn did not visibly confirm — please verify)' : ''}.`, { action: 'post' });
  return { ok: true, verified: res.verified !== false };
}

async function scheduledTick() {
  await refreshBadge();
  const settings = await getSettings();
  if (!settings.scheduledPublishing) return; // without this opt-in a due post only waits for your click
  const job = await getJob();
  if (job.state !== 'idle' && job.state !== 'completed') return;
  const posts = await getPosts();
  const due = posts.filter((p) => p.status === 'scheduled' && p.scheduledFor && Date.parse(p.scheduledFor) <= Date.now())
    .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))[0];
  if (!due) return;
  const r = await publishPost(due.id, null, { scheduled: true });
  if (!r.ok && r.code === 'VALIDATION') {
    await mutate(K.posts, () => [], (ps) => { const p = ps.find((x) => x.id === due.id); if (p) { p.status = 'draft'; p.note = `Scheduled publishing skipped: ${r.message}`; } });
  }
}

function normSnippet(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

async function collectEngagement(hintTab) {
  const blocked = await guardIdle('Reading engagement');
  if (blocked) return blocked;
  const tab = await tabForOneOff(hintTab);
  if (!tab) return { ok: false, code: 'NO_TAB', message: 'Attach a LinkedIn tab showing your posts first.' };
  const res = await callContent(tab.id, { type: 'COLLECT_ENGAGEMENT' });
  if (!res.ok) {
    if (res.code === 'WRONG_PAGE') return { ok: false, code: 'WRONG_PAGE', message: res.message };
    await failFromResult(res, { action: 'read engagement' });
    return { ok: false, code: normalizeCode(res.code), message: res.message };
  }
  let matched = 0;
  let added = 0;
  await mutate(K.posts, () => [], (posts) => {
    for (const it of res.items) {
      const snip = normSnippet(it.snippet).slice(0, 50);
      const eng = { reactions: it.reactions, comments: it.comments, reposts: it.reposts, capturedAt: iso() };
      let p = it.urn ? posts.find((x) => x.urn === it.urn) : null;
      if (!p && snip.length >= 12) p = posts.find((x) => x.status === 'published' && normSnippet(x.publishedText || x.text).includes(snip));
      if (p) { p.engagement = eng; if (it.urn) p.urn = it.urn; matched++; continue; }
      posts.push({ id: uid('post'), createdAt: iso(), updatedAt: iso(), status: 'observed', target: res.target || 'personal', companyId: null, text: it.snippet || '(no text)', urn: it.urn || '', scheduledFor: '', engagement: eng, publishedAt: '' });
      added++;
    }
    if (posts.length > POSTS_MAX) posts.length = POSTS_MAX;
  });
  await log('success', `Read engagement for ${res.items.length} visible post(s): ${matched} matched your history, ${added} added as observed.`, { action: 'engagement' });
  return { ok: true, found: res.items.length, matched, added };
}

/* ───────────────────────────── settings / leads commands ───────────────────────────── */

async function saveSettings(patch) {
  return withLock(async () => {
    const stored = await store.get(K.settings, () => ({}));
    const cur = mergeSettings(defaultSettings(), stored);
    const next = mergeSettings(cur, patch || {});
    sanitizeSettings(next);
    await store.set(K.settings, next);
    return next;
  });
}

const LEAD_EDITABLE = ['firstName', 'lastName', 'jobTitle', 'company', 'location', 'industry', 'source', 'notes'];

async function patchLead(id, patch) {
  let found = false;
  await updateLead(id, (l) => {
    found = true;
    for (const f of LEAD_EDITABLE) if (f in patch) l[f] = f === 'notes' ? str(patch[f], 2000) : str(patch[f], 200);
    if ('connectionStatus' in patch && CONNECTION_STATUSES.includes(patch.connectionStatus)) l.connectionStatus = patch.connectionStatus;
    if ('messageStatus' in patch && MESSAGE_STATUSES.includes(patch.messageStatus)) l.messageStatus = patch.messageStatus;
    if ('paused' in patch) l.paused = !!patch.paused;
    if ('nextFollowUp' in patch) {
      const t = Date.parse(patch.nextFollowUp);
      l.nextFollowUp = patch.nextFollowUp && Number.isFinite(t) ? iso(t) : '';
    }
    if (BLOCKING_MESSAGE_STATUSES.includes(l.messageStatus) || l.paused) l.nextFollowUp = '';
  });
  return found ? { ok: true } : { ok: false, message: 'Lead not found.' };
}

async function addManualLead(raw) {
  const id = normalizeProfileUrl(raw.profileUrl);
  if (!id) return { ok: false, code: 'VALIDATION', message: 'Enter a LinkedIn profile URL like https://www.linkedin.com/in/jane-doe/' };
  const counts = await upsertLeads([{ ...raw, profileUrl: id }], 'manual');
  return { ok: true, ...counts };
}

async function deleteLeads(ids) {
  await mutate(K.leads, () => ({}), (leads) => { for (const id of ids || []) delete leads[id]; });
  return { ok: true };
}

async function exportCsv({ fields, leadIds, neutralize }) {
  const settings = await getSettings();
  const keys = (fields && fields.length ? fields : settings.exportFields).filter((k) => CSV_FIELDS.some((f) => f.key === k));
  const cols = CSV_FIELDS.filter((f) => keys.includes(f.key)); // keep canonical column order
  if (!cols.length) return { ok: false, code: 'VALIDATION', message: 'Select at least one field to export.' };
  const leads = await getLeads();
  let rows = Object.values(leads);
  if (Array.isArray(leadIds)) rows = leadIds.map((id) => leads[id]).filter(Boolean);
  rows.sort((a, b) => (fullName(a).toLowerCase() < fullName(b).toLowerCase() ? -1 : 1));
  const csv = toCsv(rows, cols, neutralize !== false);
  await log('info', `Exported ${rows.length} lead(s) to CSV (${cols.map((c) => c.label).join(', ')}).`, { action: 'export' });
  return { ok: true, csv, count: rows.length, filename: `leadpilot-leads-${todayKey()}.csv` };
}

/* ───────────────────────────── state for the popup ───────────────────────────── */

async function getState(hintTab) {
  const [settings, job, counters, leads, posts, tabInfo] = await Promise.all([getSettings(), getJob(), getCounters(), getLeads(), getPosts(), getBoundTab()]);
  const list = Object.values(leads);
  const nowMs = Date.now();
  const followUpsDue = list.filter((l) => eligible(l, 'followup', settings, nowMs)).length;
  const dueByAction = {
    connect: list.filter((l) => eligible(l, 'connect', settings, nowMs)).length,
    message: list.filter((l) => eligible(l, 'message', settings, nowMs)).length,
    followup: followUpsDue,
  };
  const postsDue = posts.filter((p) => p.status === 'scheduled' && p.scheduledFor && Date.parse(p.scheduledFor) <= nowMs).length;
  return {
    ok: true,
    version: VERSION,
    settings,
    job,
    counters,
    leadCount: list.length,
    followUpsDue,
    dueByAction,
    postsDue,
    hardCaps: HARD_CAPS,
    connectNoteMax: CONNECT_NOTE_MAX,
    csvFields: CSV_FIELDS,
    tab: tabInfo ? { id: tabInfo.id, title: tabInfo.title || '', url: tabInfo.url || '', pageType: pageTypeFromUrl(tabInfo.url) } : null,
    activeTabIsLinkedIn: !!(hintTab && /^https:\/\/www\.linkedin\.com\//i.test(hintTab.url || '')),
  };
}

/* ───────────────────────────── diagnostics ───────────────────────────── */

function redactPath(path) {
  return String(path)
    .replace(/^(\/in\/)[^/]+/i, '$1<profile>')
    .replace(/^(\/company\/)[^/]+/i, '$1<page>')
    .replace(/^(\/messaging\/thread\/)[^/]+/i, '$1<thread>')
    .replace(/^(\/school\/)[^/]+/i, '$1<school>');
}

const agoText = (ts) => {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/**
 * One-click troubleshooting report: extension state plus the STRUCTURE of the attached LinkedIn page (the content
 * script reduces every piece of page text to a length). Lead names that appear in recent log lines are replaced by
 * "[lead]" and message bodies are cut, so the report can be pasted to whoever maintains the extension.
 */
async function runDiagnostics(hintTab) {
  const [settings, job, counters, leads, posts, logAll] = await Promise.all([
    getSettings(), getJob(), getCounters(), getLeads(), getPosts(), store.get(K.log, () => []),
  ]);
  const recent = logAll.slice(-20);

  const names = new Set();
  const addName = (full) => {
    for (const n of String(full || '').split(/\s+/)) if (n.length >= 3) names.add(n);
  };
  const textsIncluded = recent.map((e) => e.message).concat([job.error && job.error.detail, job.error && job.error.leadName]).filter(Boolean).join('\n');
  for (const l of Object.values(leads)) {
    const full = fullName(l);
    if (full.length >= 4 && textsIncluded.includes(full)) addName(full);
  }
  if (job.current && leads[job.current.leadId]) addName(fullName(leads[job.current.leadId]));
  if (job.error && job.error.leadName) addName(job.error.leadName);
  const hide = (text) => {
    let t = String(text || '');
    for (const n of [...names].sort((a, b) => b.length - a.length)) t = t.split(n).join('[lead]');
    return t;
  };

  const tab = await tabForOneOff(hintTab);
  let attachedTab = null;
  let contentScript = { attached: false };
  let page = null;
  if (tab) {
    let host = '';
    let path = '';
    try { const u = new URL(tab.url); host = u.hostname; path = redactPath(u.pathname); } catch (_) { /* ignore */ }
    attachedTab = { pageType: pageTypeFromUrl(tab.url), host, path, status: tab.status };
    const res = await callContent(tab.id, { type: 'DIAGNOSE' }, 20000);
    if (res.ok) {
      page = res.report;
      contentScript = { attached: true, reachable: true, version: res.report.contentScript && res.report.contentScript.version };
    } else {
      contentScript = { attached: true, reachable: res.code !== 'CONTENT_UNAVAILABLE', error: { code: res.code, message: hide(res.message) } };
    }
  }

  const manifest = chrome.runtime.getManifest();
  const report = {
    generatedAt: iso(),
    extension: { version: VERSION, manifestVersion: manifest.manifest_version, permissions: manifest.permissions, hostPermissions: manifest.host_permissions },
    browser: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
    settings: {
      accountMode: settings.accountMode,
      autoModeEnabled: settings.autoMode.enabled,
      scheduledPublishing: settings.scheduledPublishing,
      limits: settings.limits,
      pacing: settings.pacing,
      companyPages: settings.companyPages.length,
    },
    state: {
      job: {
        state: job.state, phase: job.phase, kind: job.kind, action: job.action,
        queued: job.queue.length, sent: job.sent, skipped: job.skipped,
        error: job.error ? { code: job.error.code, label: job.error.label, detail: hide(job.error.detail), selector: job.error.selector || undefined } : null,
      },
      counters,
    },
    data: { leads: Object.keys(leads).length, posts: posts.length, logEntries: logAll.length },
    attachedTab,
    contentScript,
    page,
    recentLog: recent.map((e) => ({
      ago: agoText(e.ts),
      level: e.level,
      code: e.code || undefined,
      action: e.action || undefined,
      message: hide(e.message).replace(/: ".*$/s, ': "…"').slice(0, 220),
    })),
  };
  await store.set(K.diag, { ts: Date.now(), report });
  return { ok: true, report };
}

/* ───────────────────────────── message router ───────────────────────────── */

async function handle(msg, sender) {
  const hint = msg && msg.tab ? msg.tab : null; // active tab info supplied by the popup
  switch (msg && msg.type) {
    case 'GET_STATE': return getState(hint);
    case 'GET_LEADS': {
      const leads = Object.values(await getLeads()).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return { ok: true, leads };
    }
    case 'GET_LOG': {
      const all = await store.get(K.log, () => []);
      return { ok: true, log: all.slice(-(msg.limit || 100)).reverse() };
    }
    case 'GET_POSTS': return { ok: true, posts: await getPosts() };
    case 'RUN_DIAGNOSTICS': return runDiagnostics(hint);
    case 'GET_DIAG': return { ok: true, diag: await store.get(K.diag, () => null) };
    case 'BIND_TAB': {
      if (msg.onlyIfNone && (await getBoundTab())) return { ok: true, already: true };
      return bindTab(hint);
    }
    case 'SAVE_SETTINGS': {
      const job = await getJob();
      if (msg.patch && msg.patch.accountMode && (job.state === 'running' || job.state === 'paused')) {
        return { ok: false, code: 'VALIDATION', message: 'Stop the automation before switching between Personal Profile and Company Page.' };
      }
      const s = await saveSettings(msg.patch);
      refreshBadge();
      return { ok: true, settings: s };
    }
    case 'START_JOB': return startJob(msg);
    case 'PAUSE': return pauseJob();
    case 'RESUME': return resumeJob();
    case 'STOP': return stopJob();
    case 'CLEAR_RESTRICTION': return msg.confirm === true ? clearRestriction() : { ok: false, message: 'Confirmation required.' };
    case 'APPROVE_SEND': return approveSend(msg.text);
    case 'SKIP_CURRENT': return skipLead();
    case 'UPDATE_DRAFT': return updateDraft(msg.text);
    case 'REGENERATE_DRAFT': return regenerateDraft();
    case 'COLLECT_LEADS': return collectLeads(hint);
    case 'OPEN_SEARCH': return openSearch(hint);
    case 'ADD_COMPANY_FROM_TAB': return addCompanyFromTab(hint);
    case 'PATCH_LEAD': return patchLead(msg.id, msg.patch || {});
    case 'ADD_LEAD': return addManualLead(msg.lead || {});
    case 'DELETE_LEADS': return deleteLeads(msg.ids);
    case 'EXPORT_CSV': return exportCsv(msg);
    case 'PREVIEW_TEMPLATE': {
      const settings = await getSettings();
      let lead = msg.leadId ? (await getLeads())[msg.leadId] : null;
      if (!lead) lead = { firstName: 'Alex', lastName: 'Morgan', company: 'Acme Co', jobTitle: 'Founder', location: 'Austin, TX', industry: 'E-commerce' };
      const r = renderTemplate(msg.body, leadVars(lead));
      return { ok: true, ...r, length: r.text.length, hasLeadVars: templateHasLeadVars(msg.body), settingsHint: settings.autoMode.enabled };
    }
    case 'RENDER_POST': {
      const settings = await getSettings();
      const page = settings.companyPages.find((p) => p.id === msg.companyId);
      const r = renderTemplate(msg.text, postVars(settings, page ? page.name : ''));
      return { ok: true, ...r, length: r.text.length };
    }
    case 'SAVE_POST': return savePost(msg.post || {});
    case 'DELETE_POST': return deletePost(msg.id);
    case 'PUBLISH_POST': {
      // textOverride lets the user publish the edited text from the editor without saving first.
      return publishPost(msg.id, msg.text);
    }
    case 'COLLECT_ENGAGEMENT': return collectEngagement(hint);
    case 'CLEAR_LOG': await store.set(K.log, []); return { ok: true };
    case 'RESET_DATA': {
      const job = await getJob();
      if (job.state === 'running' || job.state === 'paused') return { ok: false, message: 'Stop the automation first.' };
      if (msg.what === 'leads') await store.set(K.leads, {});
      else if (msg.what === 'posts') await store.set(K.posts, []);
      else if (msg.what === 'log') await store.set(K.log, []);
      else return { ok: false, message: 'Unknown data set.' };
      return { ok: true };
    }
    default:
      return { ok: false, code: 'VALIDATION', message: `Unknown message type: ${msg && msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  // Passive warnings detected by the content script (CAPTCHA, restriction, rate warning, login wall).
  // Extension pages (the popup, even when opened in a tab) have a chrome-extension:// URL; content scripts do not.
  const fromExtensionPage = String(sender.url || '').startsWith(chrome.runtime.getURL(''));
  if (sender.tab && !fromExtensionPage) {
    if (msg && msg.type === 'SAFETY_ALERT' && msg.finding && FINDING_TO_CODE[msg.finding.status]) {
      handleSafetyAlert(msg.finding, sender.tab.id).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;
    }
    return false;
  }

  handle(msg, sender).then(sendResponse, (err) => {
    console.error('LeadPilot handler error', err);
    sendResponse({ ok: false, code: 'INTERNAL', message: String(err && err.message || err) });
  });
  return true;
});

async function handleSafetyAlert(finding, tabId) {
  const bound = await store.get(K.tab, () => null);
  const isBound = bound && bound.tabId === tabId;
  const code = FINDING_TO_CODE[finding.status];
  const job = await getJob();
  if (job.error && job.error.code === code && (job.state === 'paused' || job.state === 'restricted' || job.state === 'error')) return; // already handled
  // A restriction anywhere on the account locks everything. Other warnings only matter for the attached tab.
  if (finding.status === 'restricted') {
    if (job.state !== 'restricted') await failJob(code, { detail: finding.evidence });
    return;
  }
  if (!isBound) return;
  if (job.state === 'running' || job.state === 'paused') {
    if (job.state === 'running') await failJob(code, { detail: finding.evidence, action: job.action ? ACTION_LABEL[job.action] || job.action : '' });
    return;
  }
  if (job.state === 'idle' || job.state === 'completed') {
    await log('warn', `LinkedIn is showing: ${ERRORS[code].label}${finding.evidence ? ` — "${str(finding.evidence, 160)}"` : ''}. No automation is running; resolve it manually before starting anything.`, { code });
  }
}

/* ───────────────────────────── lifecycle ───────────────────────────── */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_ADVANCE) advance().catch(onUnexpected);
  else if (alarm.name === ALARM_TICK) scheduledTick().catch((e) => console.error(e));
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const bound = await store.get(K.tab, () => null);
  if (!bound || bound.tabId !== tabId) return;
  await store.set(K.tab, null);
  const job = await getJob();
  if (job.state === 'running') await failJob('NO_TAB', { detail: 'The attached LinkedIn tab was closed.' });
  else await log('info', 'The attached LinkedIn tab was closed.');
});

async function ensureTickAlarm() {
  // Re-creating an alarm resets its schedule, so only create it when it does not exist yet.
  const a = await chrome.alarms.get(ALARM_TICK);
  if (!a) chrome.alarms.create(ALARM_TICK, { periodInMinutes: 5 });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureTickAlarm();
  if (details.reason === 'install') await log('info', `LeadPilot LinkedIn ${VERSION} installed. Default mode: Review Before Send.`);
});

/**
 * Recovery after the service worker was killed and restarted. Runs once per worker start.
 *   - 'sending'   → we cannot know whether LinkedIn received it, so we NEVER resend; stop and ask the user to verify.
 *   - 'preparing' → nothing irreversible happened; put the lead back and continue.
 *   - 'cooldown' / 'none' → re-arm the timer.
 */
async function recover() {
  try {
    await ensureTickAlarm();
    const job = await getJob();
    if ((job.state === 'running' || job.state === 'paused') && job.phase === 'sending') {
      const cur = job.current || {};
      if (job.kind === 'post' && cur.postId) {
        await mutate(K.posts, () => [], (ps) => { const p = ps.find((x) => x.id === cur.postId); if (p) { p.status = 'needs_check'; p.note = 'Extension restarted while publishing — check LinkedIn to see whether it went out.'; } });
      }
      await failJob('INTERRUPTED', { detail: `The extension restarted while sending to ${cur.name || 'a lead'}. It was NOT retried — please check LinkedIn to see whether it went through.`, action: cur.action ? ACTION_LABEL[cur.action] || cur.action : '', leadName: cur.name });
    } else if (job.state === 'running' && job.kind === 'post') {
      await failJob('INTERRUPTED', { detail: 'The extension restarted before the post was submitted. Nothing was published.', action: 'publish post' });
    } else if (job.state === 'running' && job.kind === 'outreach') {
      if (job.phase === 'preparing' && job.current) {
        await mutateJob((j) => { j.queue.unshift(j.current.leadId); j.current = null; j.phase = 'none'; });
      }
      const j2 = await getJob();
      if (j2.phase === 'awaiting_approval') { /* draft is persisted; the popup shows it */ }
      else if (j2.nextRunAt > Date.now()) scheduleAdvance(j2.nextRunAt);
      else advance().catch(onUnexpected);
    }
    await refreshBadge();
  } catch (e) {
    console.error('LeadPilot recover failed', e);
  }
}

recover();
