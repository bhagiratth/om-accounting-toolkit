'use strict';
/* Saves every run to disk so it survives closing the app and can be continued or exported later.
 *   <dir>/<id>.json       the whole job (leads + the remaining search queue)
 *   <dir>/<id>.meta.json  a small summary for the history list
 * Writes are debounced (a run can change several times a second) and atomic (tmp file + rename).
 */
const fs = require('fs');
const path = require('path');

const ID_RE = /^run-[A-Za-z0-9-]+$/;

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this._pending = null;
    this._timer = null;
  }

  save(job) {
    if (!job || !job.id) return;
    this._pending = job;
    if (!this._timer) this._timer = setTimeout(() => this.flush(), 2000);
  }

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    const job = this._pending;
    this._pending = null;
    if (!job || !job.id || !ID_RE.test(job.id)) return;
    try {
      this._write(job.id + '.json', JSON.stringify(job));
      this._write(job.id + '.meta.json', JSON.stringify({
        id: job.id, title: job.query, status: job.status, endReason: job.endReason,
        count: job.leads.length, withEmail: job.leads.filter(l => l.email).length,
        tasksDone: job.tasksDone, tasksLeft: job.queue.length + (job.cur ? 1 : 0),
        startedAt: job.startedAt, updatedAt: job.updatedAt
      }));
    } catch (e) {
      console.error('[store] could not save', e);
    }
  }

  _write(name, text) {
    const file = path.join(this.dir, name), tmp = file + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter(n => n.endsWith('.meta.json')); } catch (e) { return []; }
    const out = [];
    for (const n of names) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'))); } catch (e) { /* skip a damaged entry */ }
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  load(id) {
    if (!ID_RE.test(String(id))) throw new Error('Bad run id');
    return JSON.parse(fs.readFileSync(path.join(this.dir, id + '.json'), 'utf8'));
  }

  remove(id) {
    if (!ID_RE.test(String(id))) throw new Error('Bad run id');
    for (const n of [id + '.json', id + '.meta.json']) { try { fs.unlinkSync(path.join(this.dir, n)); } catch (e) { /* already gone */ } }
  }
}

module.exports = { Store };
