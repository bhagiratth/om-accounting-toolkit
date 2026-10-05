/*
 * LeadPilot LinkedIn — popup UI.
 * The popup holds no durable state of its own: it asks the service worker for state, renders it, and sends commands back.
 * Anything that came from LinkedIn (names, headlines, post text) is inserted with textContent only — never innerHTML.
 */
'use strict';

/* ───────────────────────────── helpers ───────────────────────────── */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

const STATE_LABEL = { idle: 'Idle', running: 'Running', paused: 'Paused', completed: 'Completed', error: 'Error', restricted: 'Restricted' };
const ACTION_NAME = { connect: 'Connection request', message: 'Message', followup: 'Follow-up' };
const BUDGET = { connect: 'connections', message: 'messages', followup: 'followUps' };

const HINTS = {
  LOGIN_REQUIRED: 'Sign in to LinkedIn in the attached tab, then press Resume.',
  CAPTCHA_SECURITY: 'LinkedIn is asking you to verify something. Resolve it yourself in the LinkedIn tab — LeadPilot never touches it — then press Resume. Consider stopping for today.',
  RATE_WARNING: 'LinkedIn showed a limit or unusual-activity notice. Do not push on today: lower your daily limits in Settings and Resume only after the notice is gone.',
  ACCOUNT_RESTRICTED: 'LinkedIn says the account is restricted. All actions are locked. Resolve it directly with LinkedIn; only then use “Clear restriction flag”.',
  PAGE_CHANGED: 'The LinkedIn page did not look as expected, so the run stopped (no retry loop). See README → “When LinkedIn changes its markup”.',
  MISSING_SELECTOR: 'LinkedIn changed the markup of the element named above. The run stopped without retrying. See README → “When LinkedIn changes its markup”.',
  NAV_TIMEOUT: 'The page was slow or did not render. This is a timeout — not a CAPTCHA. Check your connection and the tab, then start again.',
  NO_TAB: 'Open linkedin.com, then press “Attach this tab” and Resume.',
  CONTENT_UNAVAILABLE: 'The extension could not talk to the LinkedIn tab. Reload the tab (F5) and try again.',
  UNSUPPORTED_PAGE: 'LeadPilot only works on the LinkedIn pages it supports (people search, profiles, feed, Company Page admin).',
  IDENTITY_MISMATCH: 'LeadPilot could not confirm who this would be sent to / published as, so it did nothing. Check the tab and try again.',
  INTERRUPTED: 'Chrome restarted the extension mid-action. It was NOT retried. Check LinkedIn to see whether it went through, then start again.',
  LIMIT_REACHED: 'Today’s budget is used up.',
};

let S = null;               // latest GET_STATE
let leads = [];
let logRows = [];
let posts = [];
let activeTab = null;       // the browser tab the popup was opened on
let selected = new Set();
let expandedLead = null;
let leadLimit = 40;
let logLimit = 30;
let editingPostId = null;
let apKey = '';
let apDirty = false;
let tplEditing = null;
let refreshTimer = null;
let staleLeads = false;
let settingsFilled = false;

const timeFmt = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const clockFmt = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fullName = (l) => [l.firstName, l.lastName].filter(Boolean).join(' ') || l.profileUrl;
const localInputValue = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', !!bad);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
}

async function api(type, payload = {}) {
  try {
    const res = await chrome.runtime.sendMessage({ type, ...payload, tab: activeTab });
    return res || { ok: false, message: 'No answer from the extension background.' };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

async function act(type, payload, okMsg) {
  const r = await api(type, payload);
  if (!r.ok) toast(r.message || 'Something went wrong.', true);
  else if (okMsg) toast(okMsg);
  scheduleRefresh(0);
  return r;
}

/* ───────────────────────────── state & refresh ───────────────────────────── */

function scheduleRefresh(delay = 150) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, delay);
}

async function refresh() {
  const st = await api('GET_STATE');
  if (!st.ok) { toast(st.message || 'Could not load state.', true); return; }
  S = st;
  render();
}

function render() {
  renderHeader();
  renderControls();
  renderBanner();
  renderStats();
  renderRun();
  renderApproval();
  renderTabInfo();
  renderLeadsPanelState();
  renderPostsHeader();
  if (!settingsFilled) fillSettings();
  loadLog();
  if (!$('#panel-leads').hidden) loadLeads();
  if (!$('#panel-posts').hidden) loadPosts();
}

/* ───────────────────────────── header / controls ───────────────────────────── */

function renderHeader() {
  const company = S.settings.accountMode === 'company';
  $$('.segmented [role="radio"]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === S.settings.accountMode)));
  const sel = $('#companySelect');
  sel.hidden = !company;
  if (company) {
    sel.replaceChildren();
    if (!S.settings.companyPages.length) sel.append(h('option', { value: '', text: 'No Page added yet' }));
    for (const p of S.settings.companyPages) sel.append(h('option', { value: p.id, text: p.name, selected: p.id === S.settings.activeCompanyId }));
  }
  $('#verLine').textContent = `LeadPilot LinkedIn v${S.version} · all data stays in this browser`;
}

function jobDetail(j) {
  if (j.state === 'running') {
    if (j.phase === 'awaiting_approval') return 'Waiting for your review';
    if (j.phase === 'sending') return 'Working in the LinkedIn tab…';
    if (j.phase === 'preparing') return 'Reading the profile…';
    if (j.phase === 'cooldown' && j.nextRunAt > Date.now()) {
      const s = Math.max(0, Math.round((j.nextRunAt - Date.now()) / 1000));
      return `Next lead in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    return j.kind === 'post' ? 'Publishing…' : 'Working…';
  }
  if (j.state === 'paused') return (j.error && j.error.label) || 'Paused';
  if (j.state === 'completed') return j.summary || 'Finished';
  if (j.state === 'error') return (j.error && j.error.label) || 'Stopped with an error';
  if (j.state === 'restricted') return 'LinkedIn restriction — all actions locked';
  return j.error && j.error.code === 'USER_STOPPED' ? 'Stopped by you' : 'Ready';
}

function renderControls() {
  const j = S.job;
  const pill = $('#statePill');
  pill.className = `pill s-${j.state}`;
  pill.textContent = STATE_LABEL[j.state] || j.state;
  $('#stateDetail').textContent = jobDetail(j);

  const total = j.total || 0;
  const doneN = (j.done || 0) + (j.skipped || 0);
  const pct = total ? Math.min(100, Math.round((doneN / total) * 100)) : j.state === 'completed' ? 100 : 0;
  const bar = $('#progress');
  bar.setAttribute('aria-valuenow', String(pct));
  bar.setAttribute('aria-valuetext', total ? `${doneN} of ${total} leads processed` : 'No run in progress');
  $('#progressFill').style.width = `${pct}%`;
  bar.classList.toggle('indeterminate', j.state === 'running' && j.phase === 'sending' && !total);

  const start = $('#startBtn');
  const company = S.settings.accountMode === 'company';
  if (j.state === 'paused') { start.textContent = '▶ Resume'; start.disabled = false; }
  else {
    start.textContent = '▶ Start';
    start.disabled = j.state === 'running' || j.state === 'restricted' || company;
  }
  start.title = company ? 'Connection requests and messages are Personal Profile actions' : '';
  $('#pauseBtn').disabled = !(j.state === 'running' && j.kind !== 'post');
  $('#stopBtn').disabled = !['running', 'paused', 'completed', 'error'].includes(j.state);
  $('#stopBtn').textContent = j.state === 'completed' || j.state === 'error' ? '■ Reset' : '■ Stop';
}

function renderBanner() {
  const j = S.job;
  const b = $('#banner');
  const err = j.error;
  const show = (j.state === 'paused' && err && err.code !== 'USER_PAUSED') || j.state === 'error' || j.state === 'restricted';
  if (!show || !err) { b.hidden = true; b.replaceChildren(); return; }
  b.hidden = false;
  b.className = `banner ${j.state === 'paused' ? '' : 'danger'}`;
  const metaBits = [
    err.action && `Action: ${err.action}`,
    err.leadName && `Lead: ${err.leadName}`,
    err.selector && `Affected element: ${err.selector}`,
    err.ts && timeFmt(err.ts),
  ].filter(Boolean);
  b.replaceChildren(
    h('strong', { text: err.label }),
    err.detail ? h('div', { text: err.detail }) : null,
    metaBits.length ? h('div', { class: 'meta', text: metaBits.join(' · ') }) : null,
    h('div', { class: 'meta', text: HINTS[err.code] || '' }),
    j.state === 'restricted'
      ? h('div', { class: 'btns' }, h('button', { class: 'btn btn-sm btn-stop', type: 'button', text: 'Clear restriction flag…', onclick: onClearRestriction }))
      : null
  );
}

async function onClearRestriction() {
  const ok = confirm(
    'Only clear this flag after you have checked LinkedIn directly and the restriction is resolved.\n\nContinuing to automate a restricted account can make things worse. Clear the flag?'
  );
  if (ok) await act('CLEAR_RESTRICTION', { confirm: true }, 'Restriction flag cleared.');
}

/* ───────────────────────────── stats ───────────────────────────── */

function setBar(id, used, limit) {
  const el = $(id);
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  el.style.width = `${pct}%`;
  el.classList.toggle('full', limit === 0 || used >= limit);
}

function renderStats() {
  const c = S.counters;
  const L = S.settings.limits;
  $('#stLeads').textContent = S.leadCount;
  $('#stConn').textContent = c.connections;
  $('#stConnSub').textContent = `of ${L.connections} today`;
  setBar('#stConnBar', c.connections, L.connections);
  $('#stMsg').textContent = c.messages;
  $('#stMsgSub').textContent = `of ${L.messages} today`;
  setBar('#stMsgBar', c.messages, L.messages);
  $('#stDue').textContent = S.followUpsDue;
  $('#stDueSub').textContent = `${c.followUps}/${L.followUps} sent today`;
  setBar('#stFuBar', c.followUps, L.followUps);
  $('#stPosts').textContent = c.posts;
  $('#stPostsSub').textContent = S.postsDue ? `${S.postsDue} scheduled & due` : `of ${L.posts} today`;
  setBar('#stPostBar', c.posts, L.posts);
  $('#stState').textContent = STATE_LABEL[S.job.state];
  $('#stStateSub').textContent = S.settings.autoMode.enabled ? 'Conservative Auto' : 'Review Before Send';
}

function renderTabInfo() {
  const t = S.tab;
  $('#tabInfo').textContent = t ? `Attached: ${t.title || t.url}` : 'No LinkedIn tab attached';
  $('#tabInfo').title = t ? t.url : '';
  const here = activeTab && /^https:\/\/www\.linkedin\.com\//.test(activeTab.url || '');
  const same = t && activeTab && t.id === activeTab.id;
  $('#attachBtn').disabled = !here || same;
  $('#attachBtn').textContent = same ? 'Attached ✓' : t ? 'Attach this tab instead' : 'Attach this tab';
}

/* ───────────────────────────── run setup ───────────────────────────── */

function renderRun() {
  const company = S.settings.accountMode === 'company';
  $('#runCard').hidden = false;
  const action = $('#actionSel').value;
  const tplSel = $('#tplSel');
  const prev = tplSel.value;
  tplSel.replaceChildren();
  if (action === 'followup') {
    tplSel.append(h('option', { value: '', text: 'Per follow-up schedule' }));
    tplSel.disabled = true;
  } else {
    tplSel.disabled = false;
    for (const t of S.settings.templates.filter((x) => x.kind === action)) tplSel.append(h('option', { value: t.id, text: t.name }));
    const want = prev && [...tplSel.options].some((o) => o.value === prev) ? prev : S.settings.selectedTemplates[action];
    if (want) tplSel.value = want;
  }
  $('#selCount').textContent = selected.size;
  const n = S.dueByAction[action];
  const rem = Math.max(0, S.settings.limits[BUDGET[action]] - S.counters[BUDGET[action]]);
  $('#runHint').textContent = company
    ? 'Company Page mode: connection requests and messages are disabled — a Page never sends personal outreach.'
    : `${n} lead(s) currently eligible · ${rem} left in today’s ${ACTION_NAME[action].toLowerCase()} budget. Leads that replied, asked not to be contacted, converted or are paused are always skipped.`;
  $('#modeNote').textContent = S.settings.autoMode.enabled
    ? `Conservative Auto Mode is ON (max ${S.settings.autoMode.maxPerRun} per run). It stops at the first LinkedIn warning.`
    : 'Review Before Send: you approve every connection request and message.';
  $('#modeNote').classList.toggle('ok', !S.settings.autoMode.enabled);
}

async function onStart() {
  const j = S.job;
  if (j.state === 'paused') { await act('RESUME', {}, 'Resumed.'); return; }
  const action = $('#actionSel').value;
  const src = $('input[name="src"]:checked').value;
  if (src === 'selected' && !selected.size) { toast('Select some leads in the Leads tab first.', true); return; }
  const r = await act('START_JOB', {
    action,
    leadIds: src === 'selected' ? [...selected] : null,
    templateId: action === 'followup' ? null : $('#tplSel').value,
  });
  if (r.ok) toast(`Started — ${r.queued} lead(s) queued. Watch for the review card.`);
}

/* ───────────────────────────── approval card ───────────────────────────── */

function localDraftProblems(action, text) {
  const out = [];
  if (/\{\{[^}]*\}\}/.test(text)) out.push('Replace the remaining {{placeholder}} before sending.');
  if (action === 'connect' && text.length > S.connectNoteMax) out.push(`Too long: ${text.length}/${S.connectNoteMax} characters.`);
  if (action !== 'connect' && !text.trim()) out.push('The message is empty.');
  return out;
}

function renderApproval() {
  const j = S.job;
  const card = $('#approvalCard');
  const cur = j.current;
  if (!(j.state === 'running' && j.phase === 'awaiting_approval' && cur && cur.action !== 'post')) {
    card.hidden = true;
    apKey = '';
    return;
  }
  card.hidden = false;
  const key = `${cur.leadId}|${cur.action}|${cur.preparedAt}`;
  const area = $('#apText');
  if (key !== apKey) { apKey = key; apDirty = false; area.value = cur.draft || ''; }
  else if (!apDirty && document.activeElement !== area) area.value = cur.draft || '';

  $('#apAction').textContent = ACTION_NAME[cur.action] || cur.action;
  const step = cur.action === 'followup' ? ` · step ${Math.min((j.sent || 0) + 1, j.total)} of ${j.total}` : ` · lead ${Math.min((j.done || 0) + (j.skipped || 0) + 1, j.total)} of ${j.total}`;
  $('#apStep').textContent = step;
  $('#apName').textContent = cur.name || '';
  const p = cur.profile || {};
  $('#apMeta').textContent = [p.jobTitle, p.company, p.location].filter(Boolean).join(' · ');
  $('#apLabel').textContent = cur.action === 'connect' ? 'Connection note — edit as needed (leave empty to send without a note)' : 'Message — edit as needed, then press Send';
  $('#apAuto').hidden = !cur.auto;
  updateApprovalControls();
}

function updateApprovalControls() {
  const j = S.job;
  const cur = j.current;
  if (!cur) return;
  const text = $('#apText').value;
  const problems = localDraftProblems(cur.action, text);
  const ul = $('#apWarnings');
  ul.replaceChildren();
  for (const w of problems) ul.append(h('li', { class: 'bad', text: w }));
  for (const w of cur.warnings || []) if (!problems.some((p) => p.startsWith(w.slice(0, 20)))) ul.append(h('li', { text: w }));
  const counter = $('#apCount');
  counter.textContent = cur.action === 'connect' ? `${text.length}/${S.connectNoteMax}` : `${text.length} characters`;
  counter.classList.toggle('bad', cur.action === 'connect' && text.length > S.connectNoteMax);
  const send = $('#apSend');
  send.disabled = problems.length > 0;
  send.textContent = cur.action === 'connect' && !text.trim() ? 'Send without note' : cur.action === 'connect' ? 'Send connection request' : 'Send message';
}

let draftTimer = null;
function onDraftInput() {
  apDirty = true;
  updateApprovalControls();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => api('UPDATE_DRAFT', { text: $('#apText').value }), 400); // survive the popup closing
}

async function onApprove() {
  const btn = $('#apSend');
  btn.disabled = true;
  btn.textContent = 'Working in LinkedIn…';
  clearTimeout(draftTimer);
  const r = await api('APPROVE_SEND', { text: $('#apText').value });
  if (!r.ok) toast(r.message || 'Not sent.', true);
  else toast(r.verified === false ? 'Sent — LinkedIn did not visibly confirm, please verify.' : 'Sent.');
  scheduleRefresh(0);
}

/* ───────────────────────────── log ───────────────────────────── */

async function loadLog() {
  const r = await api('GET_LOG', { limit: 300 });
  if (r.ok) { logRows = r.log; renderLog(); }
}

function renderLog() {
  const onlyProblems = $('#logProblems').checked;
  const rows = logRows.filter((x) => !onlyProblems || x.level === 'warn' || x.level === 'error');
  const ol = $('#logList');
  ol.replaceChildren();
  if (!rows.length) ol.append(h('li', {}, h('span', { class: 'empty', text: 'Nothing here yet — every attempted action will appear with its time and result.' })));
  for (const row of rows.slice(0, logLimit)) {
    ol.append(
      h('li', { class: `l-${row.level}` },
        h('time', { datetime: new Date(row.ts).toISOString(), title: timeFmt(row.ts), text: clockFmt(row.ts) }),
        h('span', { class: 'dot', 'aria-label': row.level }),
        h('span', { class: 'msg', text: row.message })
      )
    );
  }
  $('#logMore').hidden = rows.length <= logLimit;
}

/* ───────────────────────────── leads ───────────────────────────── */

function renderLeadsPanelState() {
  const company = S.settings.accountMode === 'company';
  $('#leadsModeNote').hidden = !company;
  $('#collectBtn').disabled = company;
  $('#openSearchBtn').disabled = company;
}

async function loadLeads() {
  const r = await api('GET_LEADS');
  if (!r.ok) return;
  leads = r.leads;
  if ($('#leadList').contains(document.activeElement) && document.activeElement.tagName !== 'BODY') { staleLeads = true; return; }
  renderLeads();
}

function leadFilterFn(l) {
  const q = $('#leadFilter').value.trim().toLowerCase();
  if (q && ![fullName(l), l.company, l.jobTitle, l.location, l.industry, l.notes].join(' ').toLowerCase().includes(q)) return false;
  const st = $('#leadStatus').value;
  const now = Date.now();
  switch (st) {
    case 'new': return l.connectionStatus !== 'Connected' && l.messageStatus === 'Not Contacted' && !l.day0;
    case 'due': return !!l.nextFollowUp && Date.parse(l.nextFollowUp) <= now && !isBlocked(l);
    case 'pending': return l.connectionStatus === 'Pending';
    case 'connected': return l.connectionStatus === 'Connected';
    case 'replied': return l.messageStatus === 'Replied';
    case 'dnc': return l.messageStatus === 'Do Not Contact';
    case 'converted': return l.messageStatus === 'Converted';
    case 'paused': return !!l.paused;
    default: return true;
  }
}

const isBlocked = (l) => l.paused || ['Replied', 'Do Not Contact', 'Converted'].includes(l.messageStatus);

function suggestAction(l) {
  if (isBlocked(l)) return null;
  const now = Date.now();
  const fu = S.settings.followUps;
  if (l.nextFollowUp && Date.parse(l.nextFollowUp) <= now && l.followUpStep < fu.length && ['Pending', 'Connected'].includes(l.connectionStatus)) return 'followup';
  if (l.connectionStatus === 'Connected' && l.messageStatus === 'Not Contacted') return 'message';
  if (!l.day0 && ['Not Connected', 'Unknown'].includes(l.connectionStatus)) return 'connect';
  return null;
}

function chipFor(text, cls) { return h('span', { class: `chip ${cls || ''}`, text }); }

function renderLeads() {
  staleLeads = false;
  const shown = leads.filter(leadFilterFn);
  const ul = $('#leadList');
  ul.replaceChildren();
  $('#leadInfo').textContent = `${shown.length} shown of ${leads.length} · ${selected.size} selected`;
  if (!shown.length) ul.append(h('li', { class: 'muted', text: leads.length ? 'No leads match this filter.' : 'No leads yet. Open a LinkedIn people search and press “Collect from this page”.' }));
  const now = Date.now();
  for (const l of shown.slice(0, leadLimit)) {
    const due = l.nextFollowUp && Date.parse(l.nextFollowUp) <= now && !isBlocked(l);
    const cb = h('input', { type: 'checkbox', 'aria-label': `Select ${fullName(l)}`, checked: selected.has(l.id) ? true : null, onchange: (e) => { e.target.checked ? selected.add(l.id) : selected.delete(l.id); saveSelection(); $('#selCount').textContent = selected.size; $('#leadInfo').textContent = `${shown.length} shown of ${leads.length} · ${selected.size} selected`; } });
    const li = h('li', {},
      h('label', { class: 'lead-main' }, cb, h('span', {},
        h('span', { class: 'lead-name', text: fullName(l) }),
        h('span', { class: 'lead-sub', text: [l.jobTitle, l.company].filter(Boolean).join(' · ') || l.profileUrl })
      )),
      h('div', { class: 'chips' },
        chipFor(l.connectionStatus, l.connectionStatus === 'Connected' ? 'ok' : l.connectionStatus === 'Pending' ? 'warn' : ''),
        chipFor(l.messageStatus, l.messageStatus === 'Replied' || l.messageStatus === 'Converted' ? 'ok' : l.messageStatus === 'Do Not Contact' ? 'bad' : ''),
        l.paused ? chipFor('Paused', 'warn') : null,
        due ? chipFor('Follow-up due', 'warn') : l.nextFollowUp && !isBlocked(l) ? chipFor(`Next ${new Date(l.nextFollowUp).toLocaleDateString()}`) : null,
        l.lastContacted ? chipFor(`Last ${new Date(l.lastContacted).toLocaleDateString()}`) : null
      ),
      h('div', { class: 'row-actions' },
        (() => {
          const a = suggestAction(l);
          return h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: !a || S.settings.accountMode !== 'personal' || ['running', 'paused', 'restricted'].includes(S.job.state) ? true : null, text: a ? `Review & ${a === 'connect' ? 'connect' : a === 'message' ? 'message' : 'follow up'}…` : 'No action due', onclick: () => startSingle(l, a) });
        })(),
        h('button', { class: 'btn btn-sm', type: 'button', 'aria-expanded': String(expandedLead === l.id), text: expandedLead === l.id ? 'Close' : 'Edit', onclick: () => { expandedLead = expandedLead === l.id ? null : l.id; renderLeads(); } })
      )
    );
    if (expandedLead === l.id) li.append(leadEditor(l));
    ul.append(li);
  }
  $('#leadMore').hidden = shown.length <= leadLimit;
}

async function startSingle(l, action) {
  if (!action) return;
  const r = await act('START_JOB', { action, leadIds: [l.id], templateId: action === 'followup' ? null : S.settings.selectedTemplates[action] });
  if (r.ok) { toast('Draft is being prepared — see the Dashboard.'); selectTab('dashboard'); }
}

function leadEditor(l) {
  const f = (label, id, val, type = 'text') => h('label', {}, label, h('input', { type, id: `le_${id}`, value: val || '' }));
  const sel = (label, id, opts, val) => h('label', {}, label, h('select', { id: `le_${id}` }, opts.map((o) => h('option', { value: o, text: o, selected: o === val ? true : null }))));
  const box = h('div', { class: 'lead-edit' },
    h('div', { class: 'grid2' },
      f('First name', 'first', l.firstName), f('Last name', 'last', l.lastName),
      f('Job title', 'title', l.jobTitle), f('Company', 'company', l.company),
      f('Location', 'loc', l.location), f('Industry', 'ind', l.industry),
      sel('Connection status', 'conn', ['Not Connected', 'Pending', 'Connected', 'Unknown'], l.connectionStatus),
      sel('Message status', 'msg', ['Not Contacted', 'Messaged', 'Followed Up', 'Replied', 'Do Not Contact', 'Converted'], l.messageStatus),
      h('label', { class: 'span2' }, 'Next follow-up', h('input', { type: 'datetime-local', id: 'le_next', value: localInputValue(l.nextFollowUp) })),
    ),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'le_paused', checked: l.paused ? true : null }), 'Pause this lead (never contacted while paused)'),
    h('label', {}, 'Notes', h('textarea', { id: 'le_notes', rows: 3 }, l.notes || '')),
    h('div', { class: 'btns' },
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Save', onclick: async () => {
        const g = (id) => $(`#le_${id}`).value;
        const r = await api('PATCH_LEAD', { id: l.id, patch: { firstName: g('first'), lastName: g('last'), jobTitle: g('title'), company: g('company'), location: g('loc'), industry: g('ind'), connectionStatus: g('conn'), messageStatus: g('msg'), nextFollowUp: g('next') ? new Date(g('next')).toISOString() : '', paused: $('#le_paused').checked, notes: g('notes') } });
        toast(r.ok ? 'Lead saved.' : r.message, !r.ok);
        expandedLead = null;
        await loadLeads();
        scheduleRefresh(0);
      } }),
      h('a', { class: 'btn btn-sm', href: l.profileUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open profile ↗' }),
      h('button', { class: 'btn btn-sm btn-stop', type: 'button', text: 'Delete', onclick: async () => {
        if (!confirm(`Delete ${fullName(l)} from your local list?`)) return;
        selected.delete(l.id); saveSelection(); expandedLead = null;
        await api('DELETE_LEADS', { ids: [l.id] });
        await loadLeads(); scheduleRefresh(0);
      } })
    )
  );
  return box;
}

function saveSelection() { try { localStorage.setItem('lp_sel', JSON.stringify([...selected])); } catch (_) { /* optional */ } }

function renderCsvFields() {
  const wrap = $('#csvFields');
  wrap.replaceChildren();
  const chosen = new Set(S.settings.exportFields);
  for (const f of S.csvFields) {
    wrap.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', value: f.key, checked: chosen.has(f.key) ? true : null, onchange: saveExportFields }), f.label));
  }
}
async function saveExportFields() {
  const fields = $$('#csvFields input:checked').map((i) => i.value);
  await api('SAVE_SETTINGS', { patch: { exportFields: fields } });
}

async function onExport() {
  const fields = $$('#csvFields input:checked').map((i) => i.value);
  if (!fields.length) { toast('Tick at least one field to export.', true); return; }
  const scope = $('#csvScope').value;
  let leadIds;
  if (scope === 'selected') { if (!selected.size) { toast('No leads are selected.', true); return; } leadIds = [...selected]; }
  if (scope === 'filtered') leadIds = leads.filter(leadFilterFn).map((l) => l.id);
  const r = await api('EXPORT_CSV', { fields, leadIds, neutralize: $('#csvNeutral').checked });
  if (!r.ok) { toast(r.message || 'Export failed.', true); return; }
  const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' }); // csv string already starts with the UTF-8 BOM
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: r.filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(`Exported ${r.count} lead(s).`);
  scheduleRefresh(0);
}

/* ───────────────────────────── posts ───────────────────────────── */

function currentPostTarget() {
  const company = S.settings.accountMode === 'company';
  const page = S.settings.companyPages.find((p) => p.id === S.settings.activeCompanyId);
  return { target: company ? 'company' : 'personal', page: company ? page : null, name: company ? (page ? `Company Page “${page.name}”` : null) : 'your Personal Profile' };
}

function renderPostsHeader() {
  const t = currentPostTarget();
  $('#postAs').textContent = t.name ? `Posting as ${t.name}.` : 'No administered Company Page selected — add one in Settings → Company Pages.';
  $('#postAs').classList.toggle('ok', !!t.name);
  $('#postSchedHint').textContent = S.settings.scheduledPublishing
    ? 'Scheduled publishing is ON: due posts are published automatically through the attached tab.'
    : 'Scheduled publishing is OFF: a due post waits for you to press Publish.';
  const sel = $('#postTpl');
  const prev = sel.value;
  sel.replaceChildren();
  for (const t2 of S.settings.templates.filter((x) => x.kind === 'post')) sel.append(h('option', { value: t2.id, text: t2.name }));
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function loadPosts() {
  const r = await api('GET_POSTS');
  if (r.ok) { posts = r.posts; renderPosts(); }
}

let previewTimer = null;
function updatePostPreview() {
  const text = $('#postText').value;
  $('#postCount').textContent = `${text.length}/3000`;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const t = currentPostTarget();
    const r = await api('RENDER_POST', { text, companyId: t.page ? t.page.id : null });
    const box = $('#postPreview');
    box.replaceChildren();
    if (!r.ok) return;
    if (!text.trim()) { box.append(h('span', { class: 'muted', text: 'Your post preview appears here.' })); return; }
    // Highlight unresolved placeholders; everything is inserted as text.
    const parts = r.text.split(/(\{\{[^}]*\}\})/);
    for (const p of parts) box.append(/^\{\{/.test(p) ? h('mark', { text: p }) : document.createTextNode(p));
    if (r.missing.length) box.append(h('div', { class: 'hint', text: `Fill in: ${r.missing.map((m) => `{{${m}}}`).join(', ')} before publishing.` }));
  }, 250);
}

function newPost() {
  editingPostId = null;
  $('#postText').value = '';
  $('#postWhen').value = '';
  updatePostPreview();
}

async function savePost() {
  const t = currentPostTarget();
  const when = $('#postWhen').value;
  const r = await api('SAVE_POST', { post: { id: editingPostId, target: t.target, companyId: t.page ? t.page.id : null, text: $('#postText').value, scheduledFor: when ? new Date(when).toISOString() : '' } });
  if (!r.ok) { toast(r.message, true); return null; }
  editingPostId = r.post.id;
  toast(when ? 'Post scheduled locally.' : 'Draft saved.');
  await loadPosts();
  scheduleRefresh(0);
  return r.post;
}

async function publishNow() {
  const t = currentPostTarget();
  if (!t.name) { toast('Select an administered Company Page first.', true); return; }
  const saved = await savePost();
  if (!saved) return;
  const ok = confirm(`Publish this post as ${t.name}?\n\nIt will go live on LinkedIn right away.\n\n———\n${$('#postText').value.slice(0, 400)}${$('#postText').value.length > 400 ? '…' : ''}`);
  if (!ok) return;
  const btn = $('#postPublish');
  btn.disabled = true;
  btn.textContent = 'Publishing…';
  const r = await api('PUBLISH_POST', { id: saved.id, text: $('#postText').value });
  btn.disabled = false;
  btn.textContent = 'Publish now…';
  if (r.ok) { toast(r.verified === false ? 'Posted — please verify on LinkedIn.' : 'Published.'); newPost(); }
  else toast(r.message || 'Not published.', true);
  await loadPosts();
  scheduleRefresh(0);
}

function renderPosts() {
  const ul = $('#postList');
  ul.replaceChildren();
  if (!posts.length) ul.append(h('li', { class: 'muted', text: 'No posts yet.' }));
  const label = { draft: 'Draft', scheduled: 'Scheduled', published: 'Published', observed: 'Observed on LinkedIn', needs_check: 'Check on LinkedIn' };
  for (const p of posts.slice(0, 40)) {
    const due = p.status === 'scheduled' && p.scheduledFor && Date.parse(p.scheduledFor) <= Date.now();
    const e = p.engagement;
    ul.append(h('li', {},
      h('div', { class: 'chips', style: 'margin-left:0' },
        chipFor(label[p.status] || p.status, p.status === 'published' ? 'ok' : p.status === 'needs_check' ? 'bad' : due ? 'warn' : ''),
        chipFor(p.target === 'company' ? 'Company Page' : 'Personal'),
        p.scheduledFor && p.status !== 'published' ? chipFor(`${due ? 'Due' : 'For'} ${timeFmt(Date.parse(p.scheduledFor))}`, due ? 'warn' : '') : null,
        p.publishedAt ? chipFor(timeFmt(Date.parse(p.publishedAt))) : null
      ),
      h('div', { class: 'post-text', text: p.text }),
      p.note ? h('div', { class: 'hint', text: p.note }) : null,
      e ? h('div', { class: 'hint', text: `👍 ${e.reactions ?? '–'} · 💬 ${e.comments ?? '–'} · 🔁 ${e.reposts ?? '–'} · read ${timeFmt(Date.parse(e.capturedAt))}` }) : null,
      h('div', { class: 'row-actions', style: 'margin-left:0' },
        p.status !== 'published' && p.status !== 'observed' ? h('button', { class: 'btn btn-sm', type: 'button', text: 'Edit', onclick: () => { editingPostId = p.id; $('#postText').value = p.text; $('#postWhen').value = localInputValue(p.scheduledFor); updatePostPreview(); window.scrollTo({ top: 0 }); } }) : null,
        h('button', { class: 'btn btn-sm btn-stop', type: 'button', text: 'Delete', onclick: async () => { if (confirm('Delete this post from the local history?')) { await api('DELETE_POST', { id: p.id }); loadPosts(); } } })
      )
    ));
  }
}

/* ───────────────────────────── settings ───────────────────────────── */

function fillSettings() {
  if (!S) return;
  settingsFilled = true;
  const s = S.settings;
  const set = (id, v) => { const el = $(id); if (el) el.value = v == null ? '' : v; };
  set('#s_titles', s.targeting.titles); set('#s_industry', s.targeting.industry); set('#s_location', s.targeting.location);
  set('#s_companySize', s.targeting.companySize); set('#s_keywords', s.targeting.keywords);
  for (const k of ['connections', 'messages', 'followUps', 'posts']) { const el = $(`#s_limit_${k}`); el.value = s.limits[k]; el.max = S.hardCaps[k]; }
  set('#s_cdMin', s.pacing.cooldownMinSec); set('#s_cdMax', s.pacing.cooldownMaxSec); set('#s_gap', s.pacing.profileGapSec);
  $('#capHint').textContent = `Hard ceilings: ${S.hardCaps.connections} connection requests, ${S.hardCaps.messages} messages, ${S.hardCaps.followUps} follow-ups, ${S.hardCaps.posts} posts per day. Lower is safer.`;
  $('#s_auto').checked = s.autoMode.enabled; $('#s_autoAck').checked = s.autoMode.enabled; set('#s_autoMax', s.autoMode.maxPerRun);
  $('#s_sched').checked = s.scheduledPublishing; $('#s_schedAck').checked = s.scheduledPublishing;
  renderFollowupRows();
  renderTemplatePicker();
  renderCompanyList();
  renderCsvFields();
}

function renderFollowupRows() {
  const box = $('#fuRows');
  box.replaceChildren();
  const fu = S.settings.followUps;
  const fuTpls = S.settings.templates.filter((t) => t.kind === 'followup');
  for (let i = 0; i < 3; i++) {
    const row = fu[i] || { day: [2, 5, 10][i], label: ['Follow-up', 'Value message', 'Final follow-up'][i], templateId: fuTpls[0] && fuTpls[0].id };
    box.append(h('div', { class: 'grid2', 'data-fu': String(i) },
      h('label', {}, `Step ${i + 1}: day`, h('input', { type: 'number', min: '1', max: '90', class: 'fu-day', value: row.day })),
      h('label', {}, 'Template', h('select', { class: 'fu-tpl' }, fuTpls.map((t) => h('option', { value: t.id, text: t.name, selected: t.id === row.templateId ? true : null })))),
    ));
  }
}

function collectFollowups() {
  return $$('#fuRows [data-fu]').map((row, i) => ({
    day: Number($('.fu-day', row).value),
    label: ['Follow-up', 'Value message', 'Final follow-up'][i],
    templateId: $('.fu-tpl', row).value,
  }));
}

async function saveSection(kind) {
  let patch;
  const num = (id) => Number($(id).value);
  if (kind === 'targeting') patch = { targeting: { titles: $('#s_titles').value, industry: $('#s_industry').value, location: $('#s_location').value, companySize: $('#s_companySize').value, keywords: $('#s_keywords').value } };
  else if (kind === 'limits') patch = { limits: { connections: num('#s_limit_connections'), messages: num('#s_limit_messages'), followUps: num('#s_limit_followUps'), posts: num('#s_limit_posts') }, pacing: { cooldownMinSec: num('#s_cdMin'), cooldownMaxSec: num('#s_cdMax'), profileGapSec: num('#s_gap') } };
  else if (kind === 'mode') {
    if ($('#s_auto').checked && !$('#s_autoAck').checked) { toast('Tick the acknowledgement to enable Conservative Auto Mode.', true); return; }
    patch = { autoMode: { enabled: $('#s_auto').checked && $('#s_autoAck').checked, maxPerRun: num('#s_autoMax') } };
  } else if (kind === 'followups') patch = { followUps: collectFollowups() };
  else if (kind === 'publishing') {
    if ($('#s_sched').checked && !$('#s_schedAck').checked) { toast('Tick the authorisation box to enable scheduled publishing.', true); return; }
    patch = { scheduledPublishing: $('#s_sched').checked && $('#s_schedAck').checked };
  }
  const r = await api('SAVE_SETTINGS', { patch });
  if (!r.ok) { toast(r.message, true); return; }
  toast('Saved.');
  settingsFilled = false;
  await refresh();
}

/* templates editor */
function renderTemplatePicker() {
  const sel = $('#tplPick');
  sel.replaceChildren();
  const names = { connect: 'Connect', message: 'Message', followup: 'Follow-up', post: 'Post' };
  for (const t of S.settings.templates) sel.append(h('option', { value: t.id, text: `${names[t.kind]} · ${t.name}` }));
  if (!tplEditing || !S.settings.templates.some((t) => t.id === tplEditing.id)) tplEditing = S.settings.templates[0] ? { ...S.settings.templates[0] } : null;
  if (tplEditing) { sel.value = tplEditing.id; loadTemplateIntoForm(); }
  const chips = $('#varChips');
  chips.replaceChildren();
  for (const v of ['firstName', 'lastName', 'company', 'jobTitle', 'location', 'industry', 'date', 'companyName']) {
    chips.append(h('button', { type: 'button', text: `{{${v}}}`, title: 'Insert at cursor', onclick: () => insertAtCursor($('#tplBody'), `{{${v}}}`) }));
  }
}

function insertAtCursor(el, text) {
  const s = el.selectionStart ?? el.value.length;
  const e = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, s) + text + el.value.slice(e);
  el.focus();
  el.selectionStart = el.selectionEnd = s + text.length;
  updateTemplatePreview();
}

function loadTemplateIntoForm() {
  $('#tplName').value = tplEditing.name;
  $('#tplKind').value = tplEditing.kind;
  $('#tplBody').value = tplEditing.body;
  updateTemplatePreview();
}

let tplTimer = null;
function updateTemplatePreview() {
  const body = $('#tplBody').value;
  const kind = $('#tplKind').value;
  clearTimeout(tplTimer);
  tplTimer = setTimeout(async () => {
    const r = await api('PREVIEW_TEMPLATE', { body });
    if (!r.ok) return;
    const box = $('#tplPreview');
    box.replaceChildren();
    for (const p of r.text.split(/(\{\{[^}]*\}\})/)) box.append(/^\{\{/.test(p) ? h('mark', { text: p }) : document.createTextNode(p));
    const c = $('#tplCount');
    const over = kind === 'connect' && r.length > S.connectNoteMax;
    c.textContent = kind === 'connect' ? `${r.length}/${S.connectNoteMax} characters after filling variables` : `${r.length} characters`;
    c.classList.toggle('bad', over);
    if (kind !== 'post' && !r.hasLeadVars) box.append(h('div', { class: 'hint', text: '⚠ No lead variable — everyone would get identical text. Add {{firstName}} etc.' }));
  }, 250);
}

async function saveTemplate() {
  if (!tplEditing) return;
  const t = { id: tplEditing.id, name: $('#tplName').value || 'Untitled template', kind: $('#tplKind').value, body: $('#tplBody').value };
  const list = S.settings.templates.some((x) => x.id === t.id) ? S.settings.templates.map((x) => (x.id === t.id ? t : x)) : [...S.settings.templates, t];
  const r = await api('SAVE_SETTINGS', { patch: { templates: list } });
  toast(r.ok ? 'Template saved.' : r.message, !r.ok);
  tplEditing = t;
  settingsFilled = false;
  await refresh();
}

async function deleteTemplate() {
  if (!tplEditing || !confirm(`Delete template “${tplEditing.name}”?`)) return;
  const list = S.settings.templates.filter((x) => x.id !== tplEditing.id);
  if (!list.length) { toast('Keep at least one template.', true); return; }
  const r = await api('SAVE_SETTINGS', { patch: { templates: list } });
  toast(r.ok ? 'Template deleted.' : r.message, !r.ok);
  tplEditing = null;
  settingsFilled = false;
  await refresh();
}

function renderCompanyList() {
  const ul = $('#cpList');
  ul.replaceChildren();
  if (!S.settings.companyPages.length) ul.append(h('li', { class: 'muted', text: 'No Company Pages added yet.' }));
  for (const p of S.settings.companyPages) {
    ul.append(h('li', {},
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'cp', checked: p.id === S.settings.activeCompanyId ? true : null, onchange: async () => { await api('SAVE_SETTINGS', { patch: { activeCompanyId: p.id } }); scheduleRefresh(0); } }), p.name),
      h('button', { class: 'btn btn-sm btn-stop', type: 'button', text: 'Remove', onclick: async () => { await api('SAVE_SETTINGS', { patch: { companyPages: S.settings.companyPages.filter((x) => x.id !== p.id) } }); settingsFilled = false; scheduleRefresh(0); } })
    ));
  }
}

/* ───────────────────────────── tabs / theme / wiring ───────────────────────────── */

function selectTab(name) {
  for (const t of $$('[role="tab"]')) {
    const on = t.id === `tab-${name}`;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
  }
  try { localStorage.setItem('lp_tab', name); } catch (_) { /* optional */ }
  if (name === 'leads') loadLeads();
  if (name === 'posts') { loadPosts(); updatePostPreview(); }
}

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  try { localStorage.setItem('lp_theme', mode); } catch (_) { /* optional */ }
}

function wire() {
  // tabs with arrow-key support
  $$('[role="tab"]').forEach((t, i, all) => {
    t.addEventListener('click', () => selectTab(t.id.replace('tab-', '')));
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const n = all[(i + d + all.length) % all.length];
      n.focus();
      selectTab(n.id.replace('tab-', ''));
    });
  });

  $('#themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    const dark = cur === 'dark' || (cur === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    applyTheme(dark ? 'light' : 'dark');
  });

  $$('.segmented [role="radio"]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('SAVE_SETTINGS', { patch: { accountMode: b.dataset.mode } });
    if (!r.ok) toast(r.message, true);
    scheduleRefresh(0);
  }));
  $('#companySelect').addEventListener('change', async (e) => { await api('SAVE_SETTINGS', { patch: { activeCompanyId: e.target.value } }); scheduleRefresh(0); });

  $('#startBtn').addEventListener('click', onStart);
  $('#pauseBtn').addEventListener('click', () => act('PAUSE', {}, 'Paused.'));
  $('#stopBtn').addEventListener('click', () => act('STOP', {}, 'Stopped.'));
  $('#attachBtn').addEventListener('click', async () => { const r = await act('BIND_TAB', {}, 'Tab attached.'); if (!r.ok) return; });
  $('#actionSel').addEventListener('change', () => { if (S) renderRun(); });
  $$('input[name="src"]').forEach((r) => r.addEventListener('change', () => {}));

  $('#apText').addEventListener('input', onDraftInput);
  $('#apSend').addEventListener('click', onApprove);
  $('#apRegen').addEventListener('click', async () => { apDirty = false; apKey = ''; await act('REGENERATE_DRAFT', {}, 'Draft regenerated from the template.'); });
  $('#apSkip').addEventListener('click', () => act('SKIP_CURRENT', {}, 'Skipped.'));

  $('#logProblems').addEventListener('change', renderLog);
  $('#logMore').addEventListener('click', () => { logLimit += 40; renderLog(); });

  // leads
  $('#collectBtn').addEventListener('click', async () => {
    const btn = $('#collectBtn');
    btn.disabled = true;
    const r = await api('COLLECT_LEADS');
    btn.disabled = false;
    if (r.ok) toast(r.note || `${r.found} visible · ${r.added} new · ${r.updated} updated · ${r.duplicates} already known${r.skipped ? ` · ${r.skipped} unreadable` : ''}`);
    else toast(r.message || 'Could not collect leads.', true);
    await loadLeads();
    scheduleRefresh(0);
  });
  $('#openSearchBtn').addEventListener('click', async () => { const r = await act('OPEN_SEARCH', {}, 'Search opened in the attached tab.'); if (r.ok) window.close(); });
  $('#leadFilter').addEventListener('input', () => { leadLimit = 40; renderLeads(); });
  $('#leadStatus').addEventListener('change', () => { leadLimit = 40; renderLeads(); });
  $('#selAllBtn').addEventListener('click', () => { leads.filter(leadFilterFn).forEach((l) => selected.add(l.id)); saveSelection(); renderLeads(); renderRun(); });
  $('#selNoneBtn').addEventListener('click', () => { selected.clear(); saveSelection(); renderLeads(); renderRun(); });
  $('#leadMore').addEventListener('click', () => { leadLimit += 40; renderLeads(); });
  $('#nlAdd').addEventListener('click', async () => {
    const r = await api('ADD_LEAD', { lead: { profileUrl: $('#nlUrl').value, firstName: $('#nlFirst').value, lastName: $('#nlLast').value, jobTitle: $('#nlTitle').value, company: $('#nlCompany').value } });
    toast(r.ok ? (r.added ? 'Lead added.' : 'That profile was already in your list.') : r.message, !r.ok);
    if (r.ok) { ['#nlUrl', '#nlFirst', '#nlLast', '#nlTitle', '#nlCompany'].forEach((s) => { $(s).value = ''; }); await loadLeads(); scheduleRefresh(0); }
  });
  $('#exportBtn').addEventListener('click', onExport);

  // posts
  $('#postText').addEventListener('input', updatePostPreview);
  $('#postApply').addEventListener('click', () => {
    const t = S.settings.templates.find((x) => x.id === $('#postTpl').value);
    if (t) { $('#postText').value = t.body; updatePostPreview(); }
  });
  $('#postSave').addEventListener('click', savePost);
  $('#postPublish').addEventListener('click', publishNow);
  $('#postNew').addEventListener('click', newPost);
  $('#engageBtn').addEventListener('click', async () => {
    const r = await api('COLLECT_ENGAGEMENT');
    toast(r.ok ? `Read ${r.found} post(s): ${r.matched} matched, ${r.added} new.` : r.message, !r.ok);
    await loadPosts();
    scheduleRefresh(0);
  });

  // settings
  $$('[data-save]').forEach((b) => b.addEventListener('click', () => saveSection(b.dataset.save)));
  $$('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
    const what = b.dataset.reset;
    if (!confirm(`This permanently removes your local ${what === 'log' ? 'activity log' : what === 'posts' ? 'post history' : 'lead list'}. Continue?`)) return;
    const r = await api('RESET_DATA', { what });
    toast(r.ok ? 'Done.' : r.message, !r.ok);
    selected.clear(); saveSelection();
    scheduleRefresh(0);
  }));
  $('#tplPick').addEventListener('change', () => { tplEditing = { ...S.settings.templates.find((t) => t.id === $('#tplPick').value) }; loadTemplateIntoForm(); });
  $('#tplBody').addEventListener('input', updateTemplatePreview);
  $('#tplKind').addEventListener('change', updateTemplatePreview);
  $('#tplSave').addEventListener('click', saveTemplate);
  $('#tplNew').addEventListener('click', () => {
    tplEditing = { id: `tpl-${Date.now().toString(36)}`, name: 'New template', kind: 'message', body: 'Hi {{firstName}}, ' };
    const sel = $('#tplPick');
    sel.append(h('option', { value: tplEditing.id, text: 'New template' }));
    sel.value = tplEditing.id;
    loadTemplateIntoForm();
  });
  $('#tplDelete').addEventListener('click', deleteTemplate);
  $('#cpAdd').addEventListener('click', async () => {
    const r = await api('ADD_COMPANY_FROM_TAB');
    toast(r.ok ? `Added “${r.page.name}”.` : r.message, !r.ok);
    settingsFilled = false;
    scheduleRefresh(0);
  });

  // live updates from the service worker
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.lp_leads && !$('#panel-leads').hidden) { if ($('#leadList').contains(document.activeElement)) staleLeads = true; }
    if (changes.lp_settings && !$('#panel-settings').contains(document.activeElement)) settingsFilled = false;
    scheduleRefresh(200);
  });
  $('#leadList').addEventListener('focusout', () => { setTimeout(() => { if (staleLeads && !$('#leadList').contains(document.activeElement)) loadLeads(); }, 50); });

  // countdown tick while a cooldown is showing
  setInterval(() => { if (S && S.job.state === 'running' && S.job.phase === 'cooldown') $('#stateDetail').textContent = jobDetail(S.job); }, 1000);
}

async function init() {
  try { applyTheme(localStorage.getItem('lp_theme') || 'auto'); } catch (_) { applyTheme('auto'); }
  try { selected = new Set(JSON.parse(localStorage.getItem('lp_sel') || '[]')); } catch (_) { selected = new Set(); }
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (t) activeTab = { id: t.id, windowId: t.windowId, url: t.url || '', title: t.title || '' };
  } catch (_) { /* no tab info */ }
  wire();
  // If nothing is attached yet and the active tab is LinkedIn, attach it (the user just opened the popup on it).
  if (activeTab && /^https:\/\/www\.linkedin\.com\//.test(activeTab.url)) await api('BIND_TAB', { onlyIfNone: true });
  let first = 'dashboard';
  try { first = localStorage.getItem('lp_tab') || 'dashboard'; } catch (_) { /* optional */ }
  await refresh();
  selectTab(['dashboard', 'leads', 'posts', 'settings'].includes(first) ? first : 'dashboard');
}

init();
