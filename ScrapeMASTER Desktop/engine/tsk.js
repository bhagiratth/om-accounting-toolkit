'use strict';
/* Task files (.tsk): one search per line, fields separated by "|":
 *
 *     id | category | location | country | state | city | zip-code-or-limit
 *   e.g.  1|ecommerce||United Arab Emirates|Dubayy|Dubai|1000
 *
 * - category  = the keyword to search
 * - location  = optional free text (street / area), usually empty
 * - country / state / city = the place; names come with accents (Abū Z̧aby), which are folded to plain letters
 * - last field = a 5-6 digit postal code when the country has them (India), otherwise a maximum number of results.
 *   (Inferred from the sample file: UAE has no postal codes and every line ends in 1000; if a line really means
 *    something else, only the per-search limit is affected.)
 */

function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')          // accents / combining marks
    .replace(/[ʻʼʾʿ‘’'`]/g, '')  // transliteration apostrophes: Ra's -> Ras
    .replace(/\s+/g, ' ').trim();
}

// -> { tasks: [{kw, place, country, state, city, zip, limit}], skipped: n }
function parseTsk(text) {
  const tasks = [];
  let skipped = 0;
  String(text == null ? '' : text).replace(/^﻿/, '').split(/\r?\n/).forEach(line => {
    if (!line.trim()) return;
    const f = line.split('|');
    if (f.length < 6) { skipped++; return; }
    const kw = fold(f[1]), location = fold(f[2]), country = fold(f[3]), state = fold(f[4]), city = fold(f[5]);
    const last = (f[6] || '').trim();
    const zip = /^\d{5,6}$/.test(last) ? last : '';
    const limit = !zip && /^\d+$/.test(last) ? Math.min(parseInt(last, 10), 5000) : 0;
    if (!kw || !(city || state || location)) { skipped++; return; }
    const area = [zip, city || state].filter(Boolean).join(' ');
    const stateBit = zip && state && state !== city ? state : '';
    const place = [location, area, stateBit, country].filter(Boolean).join(', ');
    tasks.push({ kw, place, country, state, city, zip, limit });
  });
  return { tasks, skipped };
}

module.exports = { parseTsk, fold };
