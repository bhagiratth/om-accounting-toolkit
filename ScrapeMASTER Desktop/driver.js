'use strict';
/* Drives one Electron WebContents (the live Google pane) for the engine:
 *   load(url)     navigate and wait until the page has stopped loading
 *   scrape()      run scraper/page-scraper.js inside the page; resolves to the scrape result
 *   currentUrl()  where the pane is now (the engine checks for /sorry/, consent, non-finder pages)
 *   onNavigate(cb) every navigation, so the engine notices when the user solved a CAPTCHA
 * Nothing here talks to any server except through the pane's own page loads.
 */
const fs = require('fs');
const path = require('path');
const maps = require('./scraper/maps-page');

const LOAD_TIMEOUT_MS = 25000;
const SCRAPE_TIMEOUT_MS = 30000;

class ViewDriver {
  constructor(webContents, { scraperSource } = {}) {
    this.wc = webContents;
    this.scraperSource = scraperSource || fs.readFileSync(path.join(__dirname, 'scraper', 'page-scraper.js'), 'utf8');
    this._cbs = [];
    const fire = (e, url) => { for (const cb of this._cbs) { try { cb(url); } catch (err) { /* listener errors never break navigation */ } } };
    webContents.on('did-navigate', fire);
    webContents.on('did-navigate-in-page', fire);
    webContents.on('did-redirect-navigation', (details) => fire(null, details && details.url));
  }

  onNavigate(cb) { this._cbs.push(cb); }
  currentUrl() { return this.wc.getURL(); }

  async load(url) {
    const wc = this.wc;
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('load timeout')), LOAD_TIMEOUT_MS); });
    try {
      // loadURL rejects with ERR_ABORTED when Google redirects (e.g. to /sorry/); that is not an error for us.
      await Promise.race([wc.loadURL(url).catch(() => {}), timeout]);
      if (wc.isLoading()) {
        await Promise.race([new Promise(res => wc.once('did-stop-loading', res)), timeout]);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // Wait for the pane to finish whatever it is loading (used when the user navigated it themselves).
  async settle() {
    const wc = this.wc;
    if (!wc.isLoading()) return;
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('load timeout')), LOAD_TIMEOUT_MS); });
    try { await Promise.race([new Promise(res => wc.once('did-stop-loading', res)), timeout]); } finally { clearTimeout(timer); }
  }

  async scrape() {
    let timer;
    const timeout = new Promise(res => { timer = setTimeout(() => res(null), SCRAPE_TIMEOUT_MS); });
    try {
      return await Promise.race([this.wc.executeJavaScript(this.scraperSource, true), timeout]);
    } catch (e) {
      return null;                      // page navigated away / script failed: the engine reports a timeout block
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------- Google Maps website
  // Maps is a single-page app that loads results as the list is scrolled; opening a card with a script click does not
  // work and closing the panel again is unreliable, so: scroll the list (no clicks) to collect the place links, then open
  // each place by its own URL. See scraper/maps-page.js for the selectors.
  async _call(fn, ...args) {
    try { return await this.wc.executeJavaScript('(' + fn.toString() + ')(' + args.map(a => JSON.stringify(a)).join(',') + ')'); }
    catch (e) { return null; }
  }

  // Maps keeps streaming after the page is usable, so "stopped loading" is not awaited; the caller polls for the content.
  async loadQuick(url) {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('load timeout')), LOAD_TIMEOUT_MS); });
    try { await Promise.race([this.wc.loadURL(url).catch(() => {}), timeout]); } finally { clearTimeout(timer); }
  }

  mapsList() { return this._call(maps.mapsList); }

  async mapsScroll() {
    // Maps loads the next batch only when the list is wheel-scrolled to its end by many small steps (checked live: a
    // single jump or 3 big ticks stalled at ~17 places, 12 small ticks kept loading).
    await this._call(maps.mapsScrollFeed);
    const p = await this._call(maps.mapsFeedPoint);
    if (p) for (let i = 0; i < 12; i++) {
      this.wc.sendInputEvent({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: -240, canScroll: true });
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Opens one place by URL and reads its detail panel. `ready` is false if the panel never matched the expected name,
  // in which case the data must NOT be used (it could be a previous place's).
  async mapsPlace(card) {
    await this.loadQuick(card.href);
    let ready = false;
    for (let i = 0; i < 36; i++) {
      if (await this._call(maps.mapsDetailReady, card.label)) { ready = true; break; }
      await new Promise(r => setTimeout(r, 250));
    }
    const detail = ready ? await this._call(maps.mapsReadDetail) : null;
    return { ready, url: this.currentUrl(), detail, href: maps.parseMapsHref(card.href) };
  }
}

module.exports = { ViewDriver };
