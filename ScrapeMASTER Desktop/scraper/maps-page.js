'use strict';
/* Page-side functions for the Google Maps website (google.com/maps/search/...). Each function is serialized with
 * toString() and evaluated INSIDE the Maps page by driver.js, so they must be self-contained (no outer variables).
 *
 * Every selector below was checked on the live site (Oct 2026) and is marked SELECTOR / ASSUMPTION so it is easy to fix
 * when Google changes the markup:
 *   result list   div[role="feed"] holding a[href*="/maps/place/"] cards (the href carries the place's cid and lat/lng)
 *   detail panel  h1.DUwDvf (name), button[data-item-id="address"], button[data-item-id^="phone:tel:"],
 *                 a[data-item-id="authority"] (website), button.DkEaL (category), div.F7nice (rating + reviews)
 *   closing it    button[aria-label="Close"] in the left panel (a plain JS .click() does NOT open a card: Maps wants
 *                 real mouse events, so the driver clicks with webContents.sendInputEvent)
 */

// What the results list looks like right now.
function mapsList() {
  var feed = document.querySelector('div[role="feed"]');                          // SELECTOR
  var cards = Array.prototype.slice.call(document.querySelectorAll('a[href*="/maps/place/"]'));   // SELECTOR
  var body = document.body ? document.body.innerText : '';
  return {
    feed: !!feed,
    count: cards.length,
    end: /You've reached the end of the list/i.test(body),                        // ASSUMPTION: English UI (hl=en)
    noResults: /Google Maps can't find|No results found/i.test(body),             // ASSUMPTION
    sorry: /\/sorry\//.test(location.href) || /unusual traffic/i.test(body.slice(0, 2000)),
    consent: /consent\.google\./.test(location.href),
    detailOpen: !!document.querySelector('h1.DUwDvf'),                            // SELECTOR
    cards: cards.map(function (a) { return { label: a.getAttribute('aria-label') || '', href: a.href }; })
  };
}

// Where to click to open card i (viewport coordinates), after scrolling it into view.
function mapsCardPoint(i) {
  var cards = Array.prototype.slice.call(document.querySelectorAll('a[href*="/maps/place/"]'));
  var a = cards[i];
  if (!a) return null;
  a.scrollIntoView({ block: 'center' });
  var r = a.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + r.height / 2), label: a.getAttribute('aria-label') || '' };
}

// Has the detail panel for `label` finished loading? (name matches and the address/phone block is there)
function mapsDetailReady(label) {
  var h = document.querySelector('h1.DUwDvf');
  if (!h) return false;
  var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ''); };
  var a = norm(h.innerText), b = norm(label);
  if (b && a !== b && a.indexOf(b) < 0 && b.indexOf(a) < 0) return false;
  return !!(document.querySelector('button[data-item-id="address"]') || document.querySelector('button[data-item-id^="phone"]') ||
            document.querySelector('a[data-item-id="authority"]'));
}

// Everything the open detail panel shows.
function mapsReadDetail() {
  var txt = function (e) { return e ? String(e.innerText || '').replace(/\s+/g, ' ').trim() : ''; };
  var lab = function (e, re) { return e ? String(e.getAttribute('aria-label') || '').replace(re, '').trim() : ''; };
  var phoneBtn = document.querySelector('button[data-item-id^="phone:tel:"]');     // SELECTOR: id carries the digits
  var site = document.querySelector('a[data-item-id="authority"]');                // SELECTOR
  var addr = document.querySelector('button[data-item-id="address"]');             // SELECTOR
  var cat = '';
  Array.prototype.slice.call(document.querySelectorAll('button.DkEaL')).forEach(function (b) {   // SELECTOR
    var t = txt(b);
    if (!cat && t && !/^add (website|phone|hours|a)/i.test(t)) cat = t;
  });
  var rating = null, reviews = null;
  var rv = document.querySelector('div.F7nice');                                   // SELECTOR: "4.9(72)" / "4.9 (1,729)"
  if (rv) {
    var m = /(\d(?:\.\d)?)\s*\(?\s*([\d,]+)?\s*\)?/.exec(txt(rv));
    if (m) { rating = parseFloat(m[1]); if (m[2]) reviews = parseInt(m[2].replace(/,/g, ''), 10); }
  }
  var hours = '';
  Array.prototype.slice.call(document.querySelectorAll('table')).forEach(function (t) {
    var s = txt(t);
    if (!hours && /monday|tuesday|sunday|saturday/i.test(s)) {
      hours = Array.prototype.slice.call(t.querySelectorAll('tr')).map(function (r) { return txt(r); }).filter(Boolean).join('; ');
    }
  });
  var phone = '';
  if (phoneBtn) phone = String(phoneBtn.getAttribute('data-item-id') || '').replace(/^phone:tel:/, '') || lab(phoneBtn, /^Phone:\s*/i);
  return {
    name: txt(document.querySelector('h1.DUwDvf')),
    phone: phone,
    website: site ? site.href : '',
    address: lab(addr, /^Address:\s*/i),
    category: cat,
    rating: rating,
    reviews: reviews,
    hours: hours.slice(0, 400),
    url: location.href
  };
}

// Where to click to close the open detail panel (the X at the top of the left panel).
function mapsClosePoint() {
  var btns = Array.prototype.slice.call(document.querySelectorAll('button[aria-label="Close"]')).filter(function (b) {   // SELECTOR
    var r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left < 560;
  });
  btns.sort(function (a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });
  var b = btns[0];
  if (!b) return null;
  var r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

// Scroll the results list to its end so Maps loads the next batch; returns how many cards exist now.
function mapsScrollFeed() {
  var f = document.querySelector('div[role="feed"]');                              // SELECTOR
  if (!f) return -1;
  f.scrollTop = f.scrollHeight;
  return document.querySelectorAll('a[href*="/maps/place/"]').length;
}

// Centre of the results list, to aim real mouse-wheel events at it (the list loads the next batch when scrolled to its end).
function mapsFeedPoint() {
  var f = document.querySelector('div[role="feed"]');                              // SELECTOR
  if (!f) return null;
  var r = f.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

// Place data hidden in a card's link: ".../data=!4m7!3m6!1s0x3bc2bf881e459a07:0xafc040a99b72f7c5!8m2!3d18.5158!4d73.8418"
function parseMapsHref(href) {
  var out = {};
  var c = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(href);
  if (c) out.cid = c[1];
  var la = /!3d(-?\d+\.\d+)/.exec(href), lo = /!4d(-?\d+\.\d+)/.exec(href);
  if (la && lo) { out.lat = la[1]; out.lng = lo[1]; }
  return out;
}

module.exports = { mapsList, mapsCardPoint, mapsDetailReady, mapsReadDetail, mapsClosePoint, mapsScrollFeed, mapsFeedPoint, parseMapsHref };
