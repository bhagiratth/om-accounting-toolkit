/* ScrapeMASTER desktop UI. Derived from the extension popup; talks to the engine through window.api
 * (preload.js). All real state lives in the main process. If index.html is opened in a plain browser
 * (no window.api) it runs in DEMO mode with canned states, so the UI can be previewed and restyled.
 */
'use strict';

const $ = id => document.getElementById(id);
const IN_APP = typeof window !== 'undefined' && !!window.api;
const LABELS = { idle: 'Idle', running: 'Running', blocked: 'Paused', done: 'Done', error: 'Error' };
const PIN_RENDER_LIMIT = 300;
const GEO = typeof INDIA_GEO !== 'undefined' ? INDIA_GEO : [];

const el = {
  pill: $('pill'), pillText: $('pillText'),
  setupCard: $('setupCard'), keywords: $('keywords'), places: $('places'), startBtn: $('startBtn'), formMsg: $('formMsg'),
  customPanel: $('customPanel'), indiaPanel: $('indiaPanel'), geoSummary: $('geoSummary'),
  findEmails: $('findEmails'),
  progressCard: $('progressCard'), queryChip: $('queryChip'), countNum: $('countNum'), targetNum: $('targetNum'),
  pct: $('pct'), bar: $('bar'), barFill: $('barFill'), taskLine: $('taskLine'), msg: $('msg'), waitLine: $('waitLine'), help: $('help'),
  resumeBtn: $('resumeBtn'), continueBtn: $('continueBtn'), stopBtn: $('stopBtn'), downloadBtn: $('downloadBtn'),
  folderBtn: $('folderBtn'), historyCard: $('historyCard'), historyList: $('historyList'),
  paneHost: $('paneHost'), paneModal: $('paneModal'), paneOpen: $('paneOpen'), paneClose: $('paneClose'),
  geoOpen: $('geoOpen'), geoPop: $('geoPop'), geoClose: $('geoClose'),
  historyBtn: $('historyBtn'), historyPop: $('historyPop'), historyClose: $('historyClose'), historyEmpty: $('historyEmpty'),
  colBtn: $('colBtn'), colPop: $('colPop'), colList: $('colList'), colClose: $('colClose'), colReset: $('colReset'), colAll: $('colAll'),
  dataHead: $('dataHead'), qState: $('qState'), qCity: $('qCity'), qPin: $('qPin'), qAdd: $('qAdd'),
  srcNote: $('srcNote'), perWrap: $('perWrap'), tasksPanel: $('tasksPanel'), tskOpen: $('tskOpen'), tskInfo: $('tskInfo'), uaeFill: $('uaeFill'),
  dock: $('dock'), dockHost: $('dockHost'),
  dataBody: $('dataBody'), dataFilter: $('dataFilter'), dataInfo: $('dataInfo'), dataEmpty: $('dataEmpty'),
  demoBar: $('demoBar')
};

const prefs = { mode: 'custom', target: 100, speed: 'safe', source: 'finder', per: 50 };
let loadedTasks = null, loadedTaskName = '';       // a .tsk file the user opened
let lastState = { status: 'idle' };
let prevStatus = '';

// ------------------------------------------------------- segmented controls
// One helper for every role="radiogroup": click + arrow keys, roving tabindex, aria-checked.
function makeSeg(root, getValue, onChange) {
  const radios = Array.from(root.querySelectorAll('[role="radio"]'));
  function set(value, focus) {
    radios.forEach(r => {
      const on = r.dataset.value === String(value);
      r.setAttribute('aria-checked', on ? 'true' : 'false');
      r.tabIndex = on ? 0 : -1;
      if (on && focus) r.focus();
    });
  }
  radios.forEach(r => r.addEventListener('click', () => { set(r.dataset.value, false); onChange(r.dataset.value); }));
  root.addEventListener('keydown', e => {
    const i = radios.findIndex(r => r.dataset.value === String(getValue()));
    let n = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % radios.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + radios.length) % radios.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = radios.length - 1;
    if (n < 0) return;
    e.preventDefault();
    set(radios[n].dataset.value, true);
    onChange(radios[n].dataset.value);
  });
  return set;
}

const setMode = makeSeg($('modeSeg'), () => prefs.mode, v => { prefs.mode = v; applyMode(); savePrefs(); });
const setTarget = makeSeg($('seg'), () => prefs.target, v => { prefs.target = Number(v); savePrefs(); });
const setSpeed = makeSeg($('speedSeg'), () => prefs.speed, v => { prefs.speed = v; savePrefs(); });
const setSource = makeSeg($('srcSeg'), () => prefs.source, v => { prefs.source = v; applyMode(); savePrefs(); });
const setPer = makeSeg($('perSeg'), () => prefs.per, v => { prefs.per = Number(v); savePrefs(); });

function applyMode() {
  el.customPanel.hidden = prefs.mode !== 'custom';
  el.indiaPanel.hidden = prefs.mode !== 'india';
  el.tasksPanel.hidden = prefs.mode !== 'tasks';
  const maps = prefs.source === 'maps';
  el.perWrap.hidden = !maps;
  el.srcNote.textContent = maps
    ? 'Detailed: opens every place (about 2 s each) for phone, website, hours, coordinates. Google Maps stays visible on the right.'
    : 'Fast: about 20 businesses per page; Google stays hidden.';
  el.dock.hidden = !maps;
  updatePane();
}

function savePrefs() {
  try {
    localStorage.setItem('sm-prefs', JSON.stringify(Object.assign({}, prefs, {
      keywords: el.keywords.value, places: el.places.value, findEmails: el.findEmails.checked
    })));
  } catch (e) { /* storage unavailable: fine */ }
}
['input', 'change'].forEach(ev => {
  el.keywords.addEventListener(ev, savePrefs);
  el.places.addEventListener(ev, savePrefs);
});
el.findEmails.addEventListener('change', savePrefs);

// ------------------------------------------------- India picker (3 levels)
// India > States > Cities/districts > Areas/pincodes. Ticking at a level reveals the next level.
// Per branch the DEEPEST ticked level is what gets searched; anything above it with nothing ticked
// below is covered automatically (the background splits a "full" search into smaller areas).
const sel = { states: new Set(), dists: new Set(), pins: new Set() };   // keys: "s", "s:d", "s:d:p"
const filters = { states: '', dists: '', pins: '' };
const sec = {};

function buildSection(id, title, level) {
  const root = $(id);
  root.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'ghead';
  const b = document.createElement('b'); b.textContent = title;
  const count = document.createElement('span'); count.className = 'gcount';
  const all = document.createElement('button'); all.type = 'button'; all.className = 'link'; all.textContent = 'All';
  const none = document.createElement('button'); none.type = 'button'; none.className = 'link'; none.textContent = 'None';
  head.append(b, count, all, none);
  const filter = document.createElement('input');
  filter.className = 'input small'; filter.type = 'search'; filter.placeholder = 'Filter ' + title.toLowerCase() + '...';
  filter.setAttribute('aria-label', 'Filter ' + title);
  const list = document.createElement('div'); list.className = 'glist'; list.setAttribute('role', 'group'); list.setAttribute('aria-label', title);
  root.append(head, filter, list);
  sec[level] = { root, count, list, filter };

  filter.addEventListener('input', () => { filters[level] = filter.value.trim().toLowerCase(); renderList(level); });
  all.addEventListener('click', () => { candidates(level).forEach(c => sel[level].add(c.key)); afterChange(level); renderList(level); });
  none.addEventListener('click', () => { candidates(level).forEach(c => sel[level].delete(c.key)); afterChange(level); renderList(level); });
  list.addEventListener('change', e => {
    const cb = e.target;
    if (!cb || cb.type !== 'checkbox') return;
    if (cb.checked) sel[level].add(cb.dataset.key); else sel[level].delete(cb.dataset.key);
    afterChange(level);
    updateCount(level);
  });
}

// Every item that could be listed at a level (before the text filter is applied).
function allItems(level) {
  const out = [];
  if (level === 'states') {
    GEO.forEach((st, s) => out.push({ key: String(s), label: st[0], sub: st[1].length + ' cities' }));
  } else if (level === 'dists') {
    GEO.forEach((st, s) => { if (sel.states.has(String(s))) st[1].forEach((d, di) => out.push({ key: s + ':' + di, label: d[0], sub: st[0] })); });
  } else {
    GEO.forEach((st, s) => st[1].forEach((d, di) => {
      if (sel.dists.has(s + ':' + di)) d[1].forEach((p, pi) => out.push({ key: s + ':' + di + ':' + pi, label: p[0] + (p[1] ? ' · ' + p[1] : ''), sub: d[0] }));
    }));
  }
  return out;
}

function candidates(level) {
  const f = filters[level];
  const items = allItems(level);
  return f ? items.filter(c => (c.label + ' ' + c.sub).toLowerCase().includes(f)) : items;
}

function updateCount(level) {
  sec[level].count.textContent = sel[level].size + ' / ' + allItems(level).length + ' selected';
  updateSummary();
}

function renderList(level) {
  const { list } = sec[level];
  const items = candidates(level);
  list.textContent = '';
  const frag = document.createDocumentFragment();
  items.slice(0, level === 'pins' ? PIN_RENDER_LIMIT : 2000).forEach(c => {
    const row = document.createElement('label'); row.className = 'grow';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.key = c.key; cb.checked = sel[level].has(c.key);
    const name = document.createElement('span'); name.textContent = c.label;
    const sub = document.createElement('small'); sub.textContent = c.sub;
    row.append(cb, name, sub);
    frag.appendChild(row);
  });
  list.appendChild(frag);
  if (level === 'pins' && items.length > PIN_RENDER_LIMIT) {
    const note = document.createElement('div'); note.className = 'gnote';
    note.textContent = 'Showing ' + PIN_RENDER_LIMIT + ' of ' + items.length + ' - type in the filter to narrow (All ticks every match).';
    list.appendChild(note);
  }
  if (!items.length) {
    const note = document.createElement('div'); note.className = 'gnote';
    note.textContent = level === 'dists' && !sel.states.size ? 'Tick a state first.' : level === 'pins' && !sel.dists.size ? 'Tick a city first (optional: leave empty to cover whole cities).' : 'Nothing matches.';
    list.appendChild(note);
  }
  updateCount(level);
}

// A change at one level drops anything below it that is no longer reachable, then refreshes the levels below.
function afterChange(level) {
  if (level === 'states') {
    for (const k of Array.from(sel.dists)) if (!sel.states.has(k.split(':')[0])) sel.dists.delete(k);
  }
  if (level === 'states' || level === 'dists') {
    for (const k of Array.from(sel.pins)) { const p = k.split(':'); if (!sel.dists.has(p[0] + ':' + p[1])) sel.pins.delete(k); }
  }
  if (level === 'states') { renderList('dists'); renderList('pins'); }
  else if (level === 'dists') renderList('pins');
  updateCount(level);
  updateSummary();
}

// Mirrors the background's buildUnits(): deepest ticked level per branch.
function pickedUnits() {
  const stateHasChild = new Set(), distHasPin = new Set();
  sel.pins.forEach(k => { const p = k.split(':'); distHasPin.add(p[0] + ':' + p[1]); stateHasChild.add(p[0]); });
  sel.dists.forEach(k => stateHasChild.add(k.split(':')[0]));
  return {
    pins: sel.pins.size,
    districts: Array.from(sel.dists).filter(k => !distHasPin.has(k)).length,
    states: Array.from(sel.states).filter(s => !stateHasChild.has(s)).length
  };
}

function keywordList() {
  const seen = new Set(), out = [];
  el.keywords.value.split(/[\n\r;,]+/).forEach(x => {
    const k = x.replace(/\s+/g, ' ').trim();
    if (k && !seen.has(k.toLowerCase())) { seen.add(k.toLowerCase()); out.push(k); }
  });
  return out;
}

function updateSummary() {
  const u = pickedUnits();
  const kw = Math.max(1, keywordList().length);
  const total = (u.pins + u.districts + u.states) * kw;
  const parts = [];
  if (u.states) parts.push('<b>' + u.states + '</b> whole state' + (u.states > 1 ? 's' : ''));
  if (u.districts) parts.push('<b>' + u.districts + '</b> whole cit' + (u.districts > 1 ? 'ies' : 'y'));
  if (u.pins) parts.push('<b>' + u.pins + '</b> pincode' + (u.pins > 1 ? 's' : ''));
  // Only numbers are interpolated into the markup, never user text.
  el.geoSummary.innerHTML = parts.length
    ? parts.join(' + ') + ' &times; ' + kw + ' keyword' + (kw > 1 ? 's' : '') + ' = <b>' + total +
      '</b> start searches. Whole states / cities are split into smaller areas automatically when Google shows a full list (40+).'
    : 'Tick at least one state. Leave cities / areas empty to cover the whole state automatically.';
}
el.keywords.addEventListener('input', updateSummary);

function initGeo() {
  initQuickPick();
  buildSection('geoStates', 'States', 'states');
  buildSection('geoDists', 'Cities / districts', 'dists');
  buildSection('geoPins', 'Areas / pincodes', 'pins');
  renderList('states');
  afterChange('states');
}

function geoPayload() {
  return {
    mode: 'india',
    states: Array.from(sel.states).map(Number),
    districts: Array.from(sel.dists).map(k => k.split(':').map(Number)),
    pins: Array.from(sel.pins).map(k => k.split(':').map(Number))
  };
}

function placeLabel() {
  if (prefs.mode === 'tasks') return loadedTaskName.replace(/\.[^.]+$/, '');
  if (prefs.mode === 'india') {
    const names = Array.from(sel.states).map(s => GEO[Number(s)][0]);
    return names.length === 1 ? names[0] : names.length ? 'India' : '';
  }
  const list = el.places.value.split(/[\n\r;]+/).map(x => x.trim()).filter(Boolean);
  return list.length ? list[0] + (list.length > 1 ? '+more' : '') : '';
}

// ------------------------------------------------------------------ render
function fmtSecs(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60) + ' s' : s + ' s';
}

function render(s) {
  s = s || { status: 'idle' };
  lastState = s;
  const st = LABELS[s.status] ? s.status : 'idle';
  const active = st === 'running' || st === 'blocked';

  el.pill.dataset.state = st;
  el.pillText.textContent = LABELS[st];

  el.setupCard.classList.toggle('locked', active);    // options stay on screen, but can't be edited mid-run
  el.progressCard.dataset.state = st;
  syncPane(st);
  refreshData(false);
  el.startBtn.disabled = active;

  const count = Number(s.count) || 0;
  const goal = Number(s.target) || 0;
  let pct = 0;
  if (goal > 0) pct = Math.min(100, Math.round((count / goal) * 100));
  else if ((s.tasksDone || 0) + (s.tasksLeft || 0) > 0) pct = Math.min(100, Math.round(((s.tasksDone || 0) / ((s.tasksDone || 0) + (s.tasksLeft || 0))) * 100));
  if (st === 'done' && !goal) pct = 100;
  el.queryChip.textContent = s.query || '';
  el.queryChip.hidden = !s.query;
  el.countNum.textContent = String(count);
  el.targetNum.textContent = goal > 0 ? String(goal) : 'all';
  el.pct.textContent = pct + '%';
  el.barFill.style.width = pct + '%';
  el.bar.setAttribute('aria-valuenow', String(pct));

  const tl = [];
  if (s.tasksDone != null && (s.tasksDone || s.tasksLeft)) tl.push((s.tasksDone || 0) + ' searches done, ' + (s.tasksLeft || 0) + ' queued');
  if (s.slow && s.slow > 1.05) tl.push('slowed x' + s.slow.toFixed(1));
  el.taskLine.textContent = tl.join(' · ');
  el.taskLine.hidden = !tl.length;

  // textContent only: queries and messages are never interpreted as HTML.
  el.msg.textContent = s.message || '';
  el.help.textContent = '';
  (s.help || []).forEach(line => {
    const li = document.createElement('li');
    li.textContent = line;
    el.help.appendChild(li);
  });
  el.help.hidden = !(s.help && s.help.length);
  tickWait();

  el.resumeBtn.hidden = st !== 'blocked';
  el.continueBtn.hidden = !s.canContinue;
  el.stopBtn.hidden = !active;
  el.downloadBtn.disabled = !(s.canDownload || count > 0);
  el.folderBtn.hidden = !s.savedPath;
  if (st !== prevStatus && ['done', 'error', 'idle'].includes(st)) loadHistory();
  prevStatus = st;
}

// Countdown to the next page load / search (also explains cool-down breaks).
function tickWait() {
  const w = lastState.waitUntil;
  const left = w ? w - Date.now() : 0;
  if (lastState.status === 'running' && left > 800) {
    el.waitLine.textContent = (lastState.cooling ? 'Cooling down to stay under Google\'s limits - ' : 'Next page in ') + fmtSecs(left);
    el.waitLine.hidden = false;
  } else {
    el.waitLine.hidden = true;
  }
}
setInterval(tickWait, 1000);

function showFormMsg(text) {
  el.formMsg.textContent = text || '';
  el.formMsg.hidden = !text;
}

// ---------------------------------------------------------- messaging layer
const COMMAND = { GET_STATE: 'getState', START: 'start', STOP: 'stop', RESUME: 'resume', CONTINUE: 'continue', DOWNLOAD: 'export' };

function send(msg) {
  if (!IN_APP) return demoSend(msg);
  return window.api.invoke(COMMAND[msg.type], msg).catch(e => ({ ok: false, error: String(e && e.message || e) }));
}

async function refresh() {
  const r = await send({ type: 'GET_STATE' });
  if (r && r.state) render(r.state);
}

// ------------------------------------------------------------------- actions
el.startBtn.addEventListener('click', async () => {
  const keywords = keywordList();
  if (prefs.mode !== 'tasks' && !keywords.length) { showFormMsg('Enter at least one keyword, e.g. "dentist".'); el.keywords.focus(); return; }
  let places;
  if (prefs.mode === 'tasks') {
    if (!loadedTasks || !loadedTasks.length) { showFormMsg('Choose a .tsk task file first.'); return; }
    places = { mode: 'tasks', tasks: loadedTasks };
  } else if (prefs.mode === 'india') {
    places = geoPayload();
    if (!places.states.length) { showFormMsg('Tick at least one state in the India list.'); return; }
  } else {
    places = { mode: 'custom', list: el.places.value.split(/[\n\r;]+/).map(x => x.trim()).filter(Boolean) };
  }
  showFormMsg('');
  const wantEmails = el.findEmails.checked;
  savePrefs();
  el.startBtn.disabled = true;
  const r = await send({
    type: 'START', keywords, places, placeLabel: placeLabel(), target: prefs.target, speed: prefs.speed,
    findEmails: wantEmails, columns: prefs.columns, source: prefs.source, perTask: prefs.source === 'maps' ? prefs.per : 0
  });
  if (!r || !r.ok) { showFormMsg((r && r.error) || 'Could not start.'); el.startBtn.disabled = false; return; }
  render(r.state);
});

el.stopBtn.addEventListener('click', async () => {
  const r = await send({ type: 'STOP' });
  if (r && r.state) render(r.state);
});

el.resumeBtn.addEventListener('click', async () => {
  const r = await send({ type: 'RESUME' });
  if (r && r.state) render(r.state);
  else if (r && r.error) el.msg.textContent = r.error;
});

el.continueBtn.addEventListener('click', async () => {
  const r = await send({ type: 'CONTINUE' });
  if (r && r.state) render(r.state);
  else if (r && r.error) el.msg.textContent = r.error;
});

el.downloadBtn.addEventListener('click', async () => {
  const r = await send({ type: 'DOWNLOAD' });
  if (r && !r.ok) el.msg.textContent = r.error || 'Export failed.';
  else if (r && r.path) el.msg.textContent = 'Saved to ' + r.path;
});

el.folderBtn.addEventListener('click', () => { if (IN_APP) window.api.invoke('openFile'); });

// ---- task file (.tsk) and the UAE shortcut
el.tskOpen.addEventListener('click', async () => {
  if (!IN_APP) { el.tskInfo.textContent = 'Task files can be opened in the desktop app.'; return; }
  const r = await window.api.invoke('tasks:load');
  if (!r || r.canceled) return;
  if (!r.ok) { showFormMsg(r.error || 'Could not read that file.'); return; }
  showFormMsg('');
  loadedTasks = r.tasks; loadedTaskName = r.name;
  const kws = Array.from(new Set(r.tasks.map(t => t.kw)));
  const countries = Array.from(new Set(r.tasks.map(t => t.country).filter(Boolean)));
  el.tskInfo.textContent = r.name + ': ' + r.count + ' searches' + (r.skipped ? ' (' + r.skipped + ' unreadable lines skipped)' : '') +
    ' \u00b7 keywords: ' + kws.slice(0, 4).join(', ') + (kws.length > 4 ? '...' : '') + ' \u00b7 ' + (countries.slice(0, 3).join(', ') || 'no country');
});
el.uaeFill.addEventListener('click', () => {
  el.places.value = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain', 'Al Ain'].join('\n');
  savePrefs();
});

// ---- dialogs: places picker, previous runs
function openDialog(node, open) { node.hidden = !open; }
el.geoOpen.addEventListener('click', () => openDialog(el.geoPop, true));
el.geoClose.addEventListener('click', () => { openDialog(el.geoPop, false); updateSummary(); });
el.historyBtn.addEventListener('click', () => { loadHistory(); openDialog(el.historyPop, true); });
el.historyClose.addEventListener('click', () => openDialog(el.historyPop, false));
[el.geoPop, el.historyPop].forEach(p => p.addEventListener('mousedown', e => { if (e.target === p) p.hidden = true; }));
document.addEventListener('keydown', e => { if (e.key === 'Escape') { el.geoPop.hidden = true; el.historyPop.hidden = true; el.colPop.hidden = true; } });

// ---- Google page. It is a native view the main process places over #paneHost. It is hidden normally and
// opens by itself when Google asks for a check (CAPTCHA / consent), then closes again once the run carries on.
let paneAutoOpened = false;
function dockOn() { return prefs.source === 'maps'; }
function reportPane() {
  if (!IN_APP) return;
  const host = !el.paneModal.hidden ? el.paneHost : dockOn() ? el.dockHost : null;
  if (!host) { window.api.paneBounds({ x: 0, y: 0, width: 0, height: 0 }); return; }
  const r = host.getBoundingClientRect();
  window.api.paneBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
function updatePane() {
  if (IN_APP) window.api.invoke('pane:visible', !el.paneModal.hidden || dockOn());
  setTimeout(reportPane, 30);
}
function showPane(open) {
  el.paneModal.hidden = !open;
  updatePane();
}
if (typeof ResizeObserver !== 'undefined') { const ro = new ResizeObserver(reportPane); ro.observe(el.paneHost); ro.observe(el.dockHost); }
window.addEventListener('resize', reportPane);
el.paneOpen.addEventListener('click', () => { paneAutoOpened = false; showPane(true); });
el.paneClose.addEventListener('click', () => { paneAutoOpened = false; showPane(false); });
$('paneSignin').addEventListener('click', () => IN_APP && window.api.invoke('pane:signin'));
$('paneHome').addEventListener('click', () => IN_APP && window.api.invoke('pane:home'));
$('paneReload').addEventListener('click', () => IN_APP && window.api.invoke('pane:reload'));

function syncPane(st) {
  if (st === 'blocked' && el.paneModal.hidden) { paneAutoOpened = true; showPane(true); }
  else if (st !== 'blocked' && paneAutoOpened) { paneAutoOpened = false; showPane(false); }
}

// ---- live extracted data (newest first). The columns shown are the ones the user ticked in "Columns...".
let rowsCache = [], totalRows = 0, dataKey = '', dataBusy = false, seenRows = new Set();
let colDefs = [], colSel = [];                       // all known columns / the ticked ones (canonical order)

function cell(tr, text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  td.title = text;
  if (cls) td.className = cls;
  tr.appendChild(td);
}

function renderHead() {
  el.dataHead.textContent = '';
  const th0 = document.createElement('th'); th0.textContent = '#'; el.dataHead.appendChild(th0);
  colSel.forEach(k => {
    const d = colDefs.find(c => c.key === k);
    const th = document.createElement('th'); th.textContent = d ? d.head : k; el.dataHead.appendChild(th);
  });
}

function renderRows() {
  const f = el.dataFilter.value.trim().toLowerCase();
  const rows = f ? rowsCache.filter(r => Object.values(r.cells).join(' ').toLowerCase().includes(f)) : rowsCache;
  el.dataBody.textContent = '';
  const frag = document.createDocumentFragment();
  const nowSeen = new Set();
  rows.forEach(r => {
    const tr = document.createElement('tr');
    nowSeen.add(r.n);
    if (seenRows.size && !seenRows.has(r.n)) tr.className = 'fresh';
    cell(tr, String(r.n), 'n');
    colSel.forEach(k => {
      const v = r.cells[k] || '';
      if (k === 'phone') cell(tr, v, v === 'Not found' ? 'nf' : 'ok');
      else cell(tr, v || '—', v ? '' : 'dash');
    });
    frag.appendChild(tr);
  });
  el.dataBody.appendChild(frag);
  if (!f) seenRows = nowSeen;
  el.dataEmpty.hidden = rowsCache.length > 0;
  const withMobile = rowsCache.filter(r => r.cells.phone && r.cells.phone !== 'Not found').length;
  const withEmail = rowsCache.filter(r => r.cells.email).length;
  el.dataInfo.textContent = totalRows
    ? totalRows + ' businesses' + (totalRows > rowsCache.length ? ' (showing the newest ' + rowsCache.length + ')' : '') +
      (colSel.includes('phone') ? ' · mobile ' + withMobile : '') + (colSel.includes('email') ? ' · email ' + withEmail : '') +
      (f ? ' · ' + rows.length + ' match the filter' : '')
    : 'nothing yet';
}
el.dataFilter.addEventListener('input', renderRows);

async function refreshData(force) {
  if (dataBusy) return;
  const s = lastState || {};
  const key = [s.count, s.emailsDone, s.mobilesFound, s.status, (s.columns || []).join(',')].join('/');
  if (!force && key === dataKey) return;
  dataKey = key;
  dataBusy = true;
  try {
    const r = IN_APP ? await window.api.invoke('leads', { limit: 500 }) : demoLeads();
    if (r && r.rows) {
      const changed = r.columns.join() !== colSel.join() || !colDefs.length;
      colDefs = r.defs; colSel = r.columns;
      if (changed) renderHead();
      rowsCache = r.rows; totalRows = r.total; renderRows();
    }
  } finally { dataBusy = false; }
}
setInterval(() => refreshData(false), 1200);

// ---- "Columns..." dialog: tick what the table shows and the CSV exports
function renderColDialog() {
  el.colList.textContent = '';
  colDefs.forEach(d => {
    const row = document.createElement('label'); row.className = 'grow colrow';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.key = d.key; cb.checked = colSel.includes(d.key);
    const nm = document.createElement('span'); nm.textContent = d.head;
    row.append(cb, nm);
    el.colList.appendChild(row);
  });
}
async function applyColumns(keys) {
  prefs.columns = keys;
  savePrefs();
  if (IN_APP) await window.api.invoke('columns', keys);
  else { colSel = keys; }
  refreshData(true);
}
el.colBtn.addEventListener('click', async () => { if (!colDefs.length) await refreshData(true); renderColDialog(); el.colPop.hidden = false; });
el.colClose.addEventListener('click', () => { el.colPop.hidden = true; });
el.colPop.addEventListener('mousedown', e => { if (e.target === el.colPop) el.colPop.hidden = true; });
el.colList.addEventListener('change', () => {
  const keys = Array.from(el.colList.querySelectorAll('input:checked')).map(c => c.dataset.key);
  applyColumns(keys.length ? keys : colDefs.filter(d => d.def).map(d => d.key));
});
el.colReset.addEventListener('click', () => { applyColumns(colDefs.filter(d => d.def).map(d => d.key)); renderColDialog(); });
el.colAll.addEventListener('click', () => { applyColumns(colDefs.map(d => d.key)); renderColDialog(); });

// ---- location quick-pick: State > City > Pincode dropdowns that tick the same boxes as the three lists
function fillSelect(sel, items, placeholder) {
  sel.textContent = '';
  const o0 = document.createElement('option'); o0.value = ''; o0.textContent = placeholder; sel.appendChild(o0);
  items.forEach(it => { const o = document.createElement('option'); o.value = it.value; o.textContent = it.label; sel.appendChild(o); });
}
function initQuickPick() {
  fillSelect(el.qState, GEO.map((st, i) => ({ value: String(i), label: st[0] })), 'State');
  fillSelect(el.qCity, [], 'City'); fillSelect(el.qPin, [], 'Pincode');
  el.qCity.disabled = el.qPin.disabled = true;
  el.qState.addEventListener('change', () => {
    const s = el.qState.value;
    fillSelect(el.qCity, s === '' ? [] : GEO[Number(s)][1].map((d, i) => ({ value: String(i), label: d[0] })), 'All cities');
    fillSelect(el.qPin, [], 'All pincodes');
    el.qCity.disabled = s === ''; el.qPin.disabled = true;
  });
  el.qCity.addEventListener('change', () => {
    const s = el.qState.value, c = el.qCity.value;
    fillSelect(el.qPin, c === '' ? [] : GEO[Number(s)][1][Number(c)][1].map((p, i) => ({ value: String(i), label: p[0] + (p[1] ? ' · ' + p[1] : '') })), 'All pincodes');
    el.qPin.disabled = c === '';
  });
  el.qAdd.addEventListener('click', () => {
    const s = el.qState.value, c = el.qCity.value, p = el.qPin.value;
    if (s === '') return;
    sel.states.add(s);
    if (c !== '') sel.dists.add(s + ':' + c);
    if (c !== '' && p !== '') sel.pins.add(s + ':' + c + ':' + p);
    afterChange('states'); renderList('states'); renderList('dists'); renderList('pins'); updateSummary();
  });
}


// ---- previous runs
function fmtDate(ms) { try { return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; } }

async function loadHistory() {
  if (!IN_APP) return;
  const r = await window.api.invoke('runs:list');
  const runs = (r && r.runs) || [];
  el.historyEmpty.hidden = runs.length > 0;
  el.historyList.textContent = '';
  runs.slice(0, 30).forEach(run => {
    const row = document.createElement('div'); row.className = 'hrow';
    const t = document.createElement('div'); t.className = 't'; t.textContent = run.title || run.id; t.title = run.title || run.id;
    const m = document.createElement('div'); m.className = 'm';
    m.textContent = run.count + ' leads' + (run.withEmail ? ', ' + run.withEmail + ' emails' : '') + ' \u00b7 ' + run.status + ' \u00b7 ' + fmtDate(run.updatedAt);
    const b = document.createElement('div'); b.className = 'b';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'link'; open.textContent = 'Open';
    open.addEventListener('click', async () => { const o = await window.api.invoke('runs:open', run.id); if (o && o.state) { render(Object.assign({ _history: true }, o.state)); el.historyPop.hidden = true; refreshData(true); } else if (o && o.error) showFormMsg(o.error); });
    const del = document.createElement('button'); del.type = 'button'; del.className = 'link'; del.textContent = 'Delete';
    del.addEventListener('click', async () => { if (confirm('Delete this saved run?')) { await window.api.invoke('runs:delete', run.id); loadHistory(); } });
    b.append(open, del);
    row.append(t, m, b);
    el.historyList.appendChild(row);
  });
}

// ------------------------------------------------------------------ bootstrap
async function init() {
  initGeo();
  if (!IN_APP) { initDemo(); return; }
  try {
    const p = JSON.parse(localStorage.getItem('sm-prefs') || 'null');
    if (p) {
      if (['custom', 'india', 'tasks'].includes(p.mode)) prefs.mode = p.mode === 'tasks' ? 'custom' : p.mode;   // a task file has to be opened again
      if ([0, 50, 100, 200, 1000].includes(p.target)) prefs.target = p.target;
      if (['safe', 'balanced', 'fast'].includes(p.speed)) prefs.speed = p.speed;
      if (['finder', 'maps'].includes(p.source)) prefs.source = p.source;
      if ([20, 50, 100, 120].includes(p.per)) prefs.per = p.per;
      el.keywords.value = p.keywords || '';
      el.places.value = p.places || '';
      el.findEmails.checked = !!p.findEmails;
      if (Array.isArray(p.columns)) prefs.columns = p.columns;
    }
  } catch (e) { /* defaults */ }
  setMode(prefs.mode); setTarget(prefs.target); setSpeed(prefs.speed); setSource(prefs.source); setPer(prefs.per); applyMode(); updateSummary();
  window.api.onState(s => render(s));
  if (prefs.columns) await window.api.invoke('columns', prefs.columns);   // the saved choice also applies before a run starts
  await refresh();
  reportPane();
  loadHistory();
  refreshData(true);
  setInterval(refresh, 2000);
  if (!el.setupCard.hidden) el.keywords.focus();
}

// ----------------------------------------------------------------- demo mode
// Lets you preview/restyle the popup by opening popup.html in a normal browser tab.
const DEMO_STATES = {
  idle: { status: 'idle', target: 100, count: 0 },
  running: { status: 'running', query: 'dentist in Pune, Maharashtra', target: 1000, count: 342, canDownload: true, tasksDone: 12, tasksLeft: 48, slow: 1,
    message: 'Collected 342 / 1000 - search 13 "dentist in Pune, Maharashtra" page 2: +17 new, 3 without phone skipped, 4 duplicates ignored',
    waitUntil: Date.now() + 11000 },
  blocked: { status: 'blocked', query: 'dentist in Pune, Maharashtra', target: 1000, count: 342, canDownload: true, tasksDone: 12, tasksLeft: 48, slow: 1.6,
    message: 'Google is showing a CAPTCHA / "unusual traffic" check. Solve it in the tab yourself, then click Resume. Searching will be slower from now on.' },
  timeout: { status: 'blocked', query: 'dentist in Pune, Maharashtra', target: 1000, count: 342, canDownload: true,
    message: "The Google tab didn't report back in 25 s. This is not necessarily a CAPTCHA - it can be a slow load or a change in Google's markup.",
    help: ['Look at the Google tab. If there is a challenge, solve it, then click Resume.',
           'If the results look normal, click Resume to retry this page.',
           "If the results look empty, Google's markup may have changed - see the README's selector section."] },
  done: { status: 'done', query: 'dentist in Pune, Maharashtra', target: 1000, count: 1000, canDownload: true, tasksDone: 61, tasksLeft: 0,
    message: 'Done - reached the target of 1000 businesses with a phone number. Emails found for 437 of 1000.', savedPath: 'C:\\Users\\you\\Documents\\ScrapeMASTER Leads\\leads_demo.csv' },
  error: { status: 'error', query: 'dentist in Pune', target: 100, count: 0,
    message: 'No business listings were found on the first page.',
    help: ["If the tab shows results, Google's markup changed - see the README (card discovery / name extraction)."] }
};
let demoState = DEMO_STATES.idle;
let demoTimer = null;

function demoShow(s) { demoState = s; render(s); }
function demoSet(s) { clearInterval(demoTimer); demoShow(s); }

function demoSend(msg) {
  switch (msg.type) {
    case 'GET_STATE': return Promise.resolve({ ok: true, state: demoState });
    case 'START': {
      const goal = msg.target;
      demoSet({ status: 'running', query: msg.keywords[0], target: goal, count: 0, message: 'Opening Google Local Finder...' });
      demoTimer = setInterval(() => {
        const count = Math.min(goal || 60, demoState.count + 7);
        if (count >= (goal || 60)) {
          demoSet({ status: 'done', query: msg.keywords[0], target: goal, count, canDownload: true, message: 'Done (demo).' });
        } else {
          demoShow({ status: 'running', query: msg.keywords[0], target: goal, count, canDownload: true, tasksDone: Math.floor(count / 7), tasksLeft: 9, message: 'Collected ' + count + ' (demo)' });
        }
      }, 700);
      return Promise.resolve({ ok: true, state: demoState });
    }
    case 'STOP': demoSet(Object.assign({}, demoState, { status: 'done', canContinue: true, message: 'Stopped. Kept ' + demoState.count + ' leads - click Continue to go on.' })); return Promise.resolve({ ok: true, state: demoState });
    case 'RESUME': case 'CONTINUE': demoSet(DEMO_STATES.running); return Promise.resolve({ ok: true, state: demoState });
    case 'DOWNLOAD': el.msg.textContent = 'Demo mode - no file is produced.'; return Promise.resolve({ ok: true });
    default: return Promise.resolve({ ok: false });
  }
}

function demoLeads() {
  const names = ['Bombay Dental Centre', 'DentAesthe', 'My Smile Dental Clinic', 'Tooth Avenue Dental', 'Ceramco Dental', 'Make Me Smile', 'Dr. Vora Dental Care', 'Sparkle Dental Care'];
  const defs = [['name', 'Name', 1], ['phone', 'Phone', 1], ['email', 'Email', 1], ['website', 'Website', 1], ['address', 'Address', 1], ['city', 'City', 1], ['state', 'State', 1], ['pincode', 'Pincode', 1],
    ['category', 'Category', 0], ['rating', 'Rating', 0], ['reviews', 'Reviews', 0], ['hours', 'Hours (today)', 0], ['lat', 'Latitude', 0], ['lng', 'Longitude', 0], ['maps', 'Google Maps link', 0],
    ['facebook', 'Facebook', 0], ['instagram', 'Instagram', 0], ['linkedin', 'LinkedIn', 0], ['twitter', 'Twitter / X', 0]].map(d => ({ key: d[0], head: d[1], def: !!d[2] }));
  if (!colSel.length) colSel = defs.filter(d => d.def).map(d => d.key);
  const rows = names.map((n, i) => {
    const slug = n.toLowerCase().replace(/[^a-z]/g, '');
    const all = { name: n, phone: i % 4 === 3 ? 'Not found' : '+9198' + (10000000 + i * 1234567), email: i % 3 === 0 ? 'info@' + slug + '.in' : '', website: 'https://www.' + slug + '.in/',
      address: (i + 1) + ', Linking Rd, Khar West, Mumbai, Maharashtra ' + (400050 + i), city: 'Mumbai', state: 'Maharashtra', pincode: String(400050 + i),
      category: 'Dental clinic', rating: String(4.5 + (i % 5) / 10), reviews: String(300 + i * 97), hours: 'Open \u00b7 Closes 9 pm', lat: '19.07' + i, lng: '72.83' + i,
      maps: 'https://www.google.com/maps?cid=' + (1000000000 + i), facebook: '', instagram: i % 2 ? 'https://www.instagram.com/' + slug : '', linkedin: '', twitter: '' };
    const cells = {}; colSel.forEach(k => { cells[k] = all[k] || ''; });
    return { n: names.length - i, cells };
  });
  return { total: rows.length, rows, defs, columns: colSel.slice() };
}

function initDemo() {
  el.demoBar.hidden = false;
  document.body.classList.add('demo-mode');
  setMode(prefs.mode); setTarget(prefs.target); setSpeed(prefs.speed); setSource(prefs.source); setPer(prefs.per); applyMode(); updateSummary();
  render(DEMO_STATES.idle);
  el.demoBar.addEventListener('click', e => {
    const b = e.target.closest('[data-demo]');
    if (b) demoSet(DEMO_STATES[b.dataset.demo]);
  });
}

init();
