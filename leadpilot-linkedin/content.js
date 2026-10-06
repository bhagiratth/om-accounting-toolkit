/*
 * LeadPilot LinkedIn — content script
 *
 * Runs on https://www.linkedin.com/* and does exactly two things, only when the background worker asks:
 *   1. READ what is already visible on the page the user has open (search cards, profile top card, post metrics).
 *   2. CLICK / TYPE in the visible LinkedIn UI (Connect dialog, message box, post composer) for an action
 *      the user approved. Nothing is sent from here on its own.
 *
 * Hard rules:
 *   - No LinkedIn private APIs, no network requests of its own: DOM only.
 *   - No hiding of automation, no fingerprint / UA tricks, no CAPTCHA handling. A challenge ends the run.
 *   - Short random waits (uxPause) exist only so dialogs can finish animating and a human can follow along.
 *   - Every card / profile / action is wrapped in its own try/catch; a changed element yields a named
 *     MISSING_SELECTOR error and the run stops — it is never retried in a loop.
 *
 * Markup-sensitive functions (see README "When LinkedIn changes its markup"):
 *   findResultCards · extractProfileUrl · extractName / extractProfileName · extractCompany ·
 *   extractJobTitle · findConnectButton · findMessageButton · findMessageComposer ·
 *   findMessageSendButton · findPostComposer · detectCompanyPage · detectSecurityState
 *
 * Every selector below is preceded by:
 *   // SELECTOR:   what is matched
 *   // ASSUMPTION: why we believe LinkedIn's markup looks like that (so it is obvious what to re-check)
 * Layers are tried in order: 1) semantic / ARIA  2) data attributes  3) stable LinkedIn attributes  4) narrow CSS fallback.
 * The UI is assumed to be in English.
 */
(() => {
  'use strict';

  // The script can be injected twice (static manifest + on-demand by the worker); keep it idempotent.
  // A copy orphaned by an extension reload (its chrome.runtime is gone) must not block a fresh one.
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  if (window.__leadPilotContent && window.__leadPilotContent.alive && window.__leadPilotContent.alive()) return;
  const CS_VERSION = '1.0.1';
  window.__leadPilotContent = { version: CS_VERSION, alive }; // finder functions are attached at the bottom for DevTools debugging

  /* ───────────────────────────── generic helpers ───────────────────────────── */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  // UX pacing ONLY: lets modals finish animating and keeps the page readable for the user watching it.
  // It is not used to disguise automation and does not change how many actions are allowed.
  const uxPause = (min = 500, max = 1200) => sleep(rand(min, max));

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const textOf = (el) => (el ? clean(el.innerText !== undefined ? el.innerText : el.textContent) : '');
  const linesOf = (el) =>
    el
      ? String(el.innerText !== undefined ? el.innerText : el.textContent || '')
          .split(/\n+/)
          .map(clean)
          .filter(Boolean)
      : [];

  const norm = (s) =>
    clean(s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  function qs(root, sel) {
    try { return (root || document).querySelector(sel); } catch (_) { return null; }
  }
  function qsa(root, sel) {
    try { return Array.from((root || document).querySelectorAll(sel)); } catch (_) { return []; }
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    } catch (_) {
      return false;
    }
  }
  const isDisabled = (el) => !el || el.disabled === true || el.getAttribute('aria-disabled') === 'true';

  /** First non-empty result of the given strategies; each strategy is isolated so one broken layer cannot throw. */
  function pick(strategies) {
    for (const fn of strategies) {
      try {
        const v = fn();
        if (v) return v;
      } catch (_) { /* try the next layer */ }
    }
    return null;
  }

  async function waitFor(fn, timeout = 10000, interval = 200) {
    const end = Date.now() + timeout;
    for (;;) {
      let v = null;
      try { v = fn(); } catch (_) { v = null; }
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(interval);
    }
  }

  class LPError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.code = code;
      this.extra = extra || {};
    }
  }

  function clickEl(el, what) {
    if (!el || !el.isConnected) throw new LPError('MISSING_SELECTOR', `${what} disappeared before it could be clicked.`, { selector: what });
    if (isDisabled(el)) throw new LPError('PAGE_CHANGED', `${what} is disabled.`, { selector: what });
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { /* ignore */ }
    el.click();
  }

  const accName = (el) => clean(el.getAttribute('aria-label') || '') || textOf(el);

  function normalizeProfileUrl(raw) {
    try {
      const u = new URL(String(raw || '').trim(), 'https://www.linkedin.com');
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/in\/([^/?#]+)/i);
      if (!m) return null;
      let slug;
      try { slug = decodeURIComponent(m[1]); } catch (_) { slug = m[1]; }
      slug = slug.trim().toLowerCase();
      return slug ? `https://www.linkedin.com/in/${encodeURIComponent(slug)}/` : null;
    } catch (_) {
      return null;
    }
  }

  function pageType(path = location.pathname) {
    if (/^\/(checkpoint|uas|login|authwall|signup)(\/|$)/i.test(path)) return 'auth';
    if (/^\/search\/results\/people/i.test(path)) return 'search_people';
    if (/^\/search\//i.test(path)) return 'search_other';
    if (/^\/in\/[^/]+/i.test(path)) return 'profile';
    if (/^\/feed(\/|$)/i.test(path)) return 'feed';
    if (/^\/company\/[^/]+/i.test(path)) return 'company';
    if (/^\/messaging(\/|$)/i.test(path)) return 'messaging';
    return 'other';
  }

  function assertPage(...types) {
    const t = pageType();
    if (!types.includes(t)) {
      throw new LPError('WRONG_PAGE', `This action needs a LinkedIn ${types.join(' / ').replace(/_/g, ' ')} page, but the tab shows a "${t.replace(/_/g, ' ')}" page.`);
    }
  }

  /* ───────────────────────────── security / warning detection ───────────────────────────── */

  // Patterns are matched ONLY against alert-like containers (dialogs, toasts, alert regions) or challenge URLs,
  // never against ordinary feed / profile text, so a post that merely mentions "captcha" cannot stop a run.
  const PATTERNS = {
    restricted: [
      /your account (has been|is|was) (temporarily )?(restricted|suspended|locked|limited)/i,
      /we('|’)ve (temporarily )?(restricted|limited|suspended) your account/i,
      /account (has been )?(temporarily )?(restricted|suspended|locked)/i,
      /temporarily restricted/i,
      /restricted your account/i,
    ],
    captcha: [
      /captcha/i,
      /(quick )?security (check|verification)/i,
      /verify (that )?you('|’)re (a )?(human|real person)/i,
      /confirm (that )?you('|’)re (a )?(human|real person)/i,
      /complete this (security )?(check|puzzle)/i,
      /verify your identity/i,
      /we need to verify/i,
      /verification (code|required)/i,
      /let('|’)s do a quick/i,
    ],
    rate: [
      /unusual activity/i,
      /(weekly|monthly|daily) (invitation|connection|personali[sz]ed invitation)s? limit/i,
      /(invitation|connection) limit/i,
      /limit for personali[sz]ed/i,
      /reached (the |your )?(weekly |monthly |daily )?(invitation |connection |sending )?limit/i,
      /too many (requests|invitations|messages|attempts)/i,
      /you('|’)re (sending|doing) (this )?too (fast|many)/i,
      /temporar(y|ily) (limit|limited|unable|restrict)/i,
    ],
  };

  // Generic phrases such as "try again later" also appear in harmless error toasts, so they only count
  // when the same message also contains a limit-type word.
  const RATE_WEAK = /(slow down|try again later)/i;
  const RATE_CONTEXT = /(limit|restrict|unusual|too many|temporar|suspicious)/i;

  /** First pattern of `group` that matches `t` (or null). */
  function matchGroup(group, t) {
    for (const re of PATTERNS[group]) if (re.test(t)) return re;
    if (group === 'rate' && RATE_WEAK.test(t) && RATE_CONTEXT.test(t)) return RATE_WEAK;
    return null;
  }

  function alertContainers() {
    // SELECTOR: [role="dialog"], [role="alertdialog"], [role="alert"], .artdeco-modal, .artdeco-toast-item, .artdeco-inline-feedback
    // ASSUMPTION: LinkedIn shows warnings, limits and challenges inside modals, toasts or alert regions — not inside normal feed content.
    return qsa(document, '[role="dialog"], [role="alertdialog"], [role="alert"], .artdeco-modal, .artdeco-toast-item, .artdeco-inline-feedback').filter(
      (el) => el.isConnected
    );
  }

  /** Text of a container without anything the user typed (composer / textarea), so drafts never trigger a false alarm. */
  function scanText(el) {
    try {
      const c = el.cloneNode(true);
      // SELECTOR: [contenteditable], textarea, input, [role="textbox"] (removed from a CLONE before text is scanned)
      // ASSUMPTION: anything the user typed lives in these controls, so excluding them avoids false alarms on drafts.
      qsa(c, '[contenteditable], textarea, input, [role="textbox"]').forEach((n) => n.remove());
      return clean(c.textContent);
    } catch (_) {
      return textOf(el);
    }
  }

  /**
   * Classify what LinkedIn is showing right now.
   * returns { status: 'ok' | 'login_required' | 'security_challenge' | 'restricted' | 'rate_warning', evidence, where }
   */
  function detectSecurityState() {
    const path = location.pathname;

    // URL layer — LinkedIn routes login / challenges to dedicated paths.
    // SELECTOR: location.pathname  /checkpoint/lg|rm, /uas/login, /login, /authwall, /signup
    // ASSUMPTION: these paths are used for sign-in walls.
    if (/^\/checkpoint\/(lg|rm)\b/i.test(path) || /^\/(uas\/login|login|authwall|signup)(\/|$)/i.test(path)) {
      return { status: 'login_required', evidence: 'LinkedIn is asking you to sign in', where: path };
    }
    // SELECTOR: location.pathname /checkpoint/…
    // ASSUMPTION: every other /checkpoint/ page is an identity / security challenge.
    if (/^\/checkpoint\//i.test(path)) {
      return { status: 'security_challenge', evidence: 'LinkedIn opened a security checkpoint page', where: path };
    }

    // DOM login wall (logged-out or expired session).
    // SELECTOR: form.login__form, input[name="session_key"], .authwall-join-form, [class*="authwall"]
    // ASSUMPTION: these exist only on the sign-in form / auth-wall overlays, not for signed-in members.
    if (qs(document, 'form.login__form, input[name="session_key"], .authwall-join-form, form[data-id="sign-in-form"], [class*="authwall"]')) {
      return { status: 'login_required', evidence: 'A sign-in form is displayed', where: 'dom' };
    }

    // Embedded challenge widgets — only when actually shown: a hidden helper node or the small invisible-reCAPTCHA
    // badge that many sites load in the background is not a challenge.
    // SELECTOR: iframe[src*="captcha" i], iframe[src*="arkose" i], iframe[src*="funcaptcha" i], #captcha-internal, [id*="captcha" i]  (visible, >=150x100px, not .grecaptcha-badge)
    // ASSUMPTION: a real challenge is a large visible widget whose id or src mentions captcha / arkose.
    const widget = qsa(document, 'iframe[src*="captcha" i], iframe[src*="arkose" i], iframe[src*="funcaptcha" i], #captcha-internal, [id*="captcha" i]').find((el) => {
      if (el.closest('.grecaptcha-badge') || !isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 150 && r.height >= 100;
    });
    if (widget) return { status: 'security_challenge', evidence: 'A CAPTCHA / security widget is displayed', where: 'dom' };

    // Text of alert-like containers only. Order matters: restriction > challenge > rate/activity warning.
    for (const group of ['restricted', 'captcha', 'rate']) {
      for (const c of alertContainers()) {
        const t = scanText(c);
        if (!t || t.length > 3000) continue;
        const re = matchGroup(group, t);
        if (re) {
          const i = Math.max(0, t.search(re) - 40);
          return {
            status: group === 'restricted' ? 'restricted' : group === 'captcha' ? 'security_challenge' : 'rate_warning',
            evidence: t.slice(i, i + 200),
            where: c.getAttribute('role') || c.className || 'alert',
          };
        }
      }
    }
    return { status: 'ok' };
  }

  const FINDING_CODE = {
    login_required: 'LOGIN_REQUIRED',
    security_challenge: 'CAPTCHA_SECURITY',
    restricted: 'ACCOUNT_RESTRICTED',
    rate_warning: 'RATE_WARNING',
  };

  /** Throw the matching classified error if LinkedIn is showing anything we must not act through. */
  async function guardSafety(extra) {
    const f = detectSecurityState();
    if (f.status !== 'ok') throw new LPError(FINDING_CODE[f.status], f.evidence || f.status, extra);
  }

  /* Passive watcher: tells the worker when a warning appears even while no action is running. */
  function startWatcher() {
    let timer = null;
    let lastSig = '';
    let obs = null;
    const run = () => {
      timer = null;
      try {
        const f = detectSecurityState();
        if (f.status === 'ok') { lastSig = ''; return; }
        const sig = `${f.status}|${f.evidence}`;
        if (sig === lastSig) return;
        lastSig = sig;
        const p = chrome.runtime.sendMessage({ type: 'SAFETY_ALERT', finding: f, url: location.href });
        if (p && p.catch) p.catch(() => {});
      } catch (e) {
        if (obs && /context invalidated/i.test(String(e && e.message))) obs.disconnect(); // extension was reloaded
      }
    };
    obs = new MutationObserver(() => { if (!timer) timer = setTimeout(run, 1500); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(run, 2000);
  }

  /* ───────────────────────────── name / headline parsing ───────────────────────────── */

  function cleanName(raw) {
    return clean(raw)
      .replace(/\s*[•·]\s*(1st|2nd|3rd\+?).*$/i, '')
      .replace(/\(.*?\)/g, '')
      .replace(/,.*$/, '')
      .replace(/\s+[-–—|]\s+.*$/, '')
      .replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const isHiddenName = (n) => /^linkedin member$/i.test(clean(n));
  const validName = (n) => n.length >= 2 && n.length <= 80 && !/\d/.test(n) && !isHiddenName(n);

  function splitName(full) {
    const t = clean(full).split(' ').filter(Boolean);
    return { firstName: t[0] || '', lastName: t.slice(1).join(' ') };
  }

  function nameTokens(n) {
    const t = norm(n).split(' ').filter(Boolean);
    return t.length ? { first: t[0], last: t.length > 1 ? t[t.length - 1] : '' } : { first: '', last: '' };
  }
  /** Lenient: first token must match; the last token must match too when both sides have a full last name. */
  function namesMatch(expected, actual) {
    const a = nameTokens(expected);
    const b = nameTokens(actual);
    if (!a.first || !b.first) return false;
    if (a.first !== b.first) return false;
    if (a.last.length > 1 && b.last.length > 1) return a.last === b.last || b.last.startsWith(a.last) || a.last.startsWith(b.last);
    return true;
  }
  /** Strict-ish check that a header text mentions the person (first and last token both present). */
  function textMentionsName(text, name) {
    const t = ` ${norm(text)} `;
    const n = nameTokens(name);
    if (!n.first || !t.includes(` ${n.first} `)) return false;
    return !n.last || t.includes(` ${n.last} `);
  }

  /** "Founder & CEO at Acme | Speaker" → { title: "Founder & CEO", company: "Acme" } */
  function splitHeadline(h) {
    h = clean(h);
    if (!h) return { title: '', company: '' };
    let title = h;
    let company = '';
    const m = h.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
    if (m) { title = m[1]; company = m[2]; }
    title = title.split(/\s[|•·]\s/)[0];
    company = company.split(/\s[|•·–—-]\s/)[0];
    return { title: clean(title).slice(0, 150), company: clean(company).slice(0, 150) };
  }

  const NOISE_LINES = [
    /^[•·]$/,
    /^[•·]?\s*(1st|2nd|3rd\+?)(\s+degree connection)?$/i,
    /^(connect|message|follow|following|pending|save|send inmail|view profile|view full profile|more)$/i,
    /mutual connections?/i,
    /^status is /i,
    /^view .*(profile|graphic)/i,
    /^(current|past|summary|skills):/i,
    /^provides services/i,
    /^\d[\d,.]*\+?\s*(followers?|connections?)$/i,
    /^premium$/i,
  ];

  function cardLines(card, name) {
    const nn = norm(name);
    return linesOf(card).filter((l) => {
      if (NOISE_LINES.some((re) => re.test(l))) return false;
      if (nn && norm(l) === nn) return false;
      if (nn && norm(l).startsWith(nn) && /profile|status/.test(norm(l))) return false;
      return true;
    });
  }

  /* ───────────────────────────── search results: card discovery & extraction ───────────────────────────── */

  const slugOfUrl = (u) => (u ? (u.match(/\/in\/([^/]+)\//) || [])[1] || '' : '');

  function profileAnchors(root) {
    // SELECTOR: a[href*="/in/"]
    // ASSUMPTION: every person on a results page is linked via an anchor to /in/<slug>.
    return qsa(root, 'a[href*="/in/"]');
  }

  function primarySlug(node) {
    for (const a of profileAnchors(node)) {
      const u = normalizeProfileUrl(a.href);
      if (u) return slugOfUrl(u);
    }
    return '';
  }

  /** Keep candidate nodes that hold exactly one person; drop wrappers around several cards and duplicates. */
  function resolveCards(nodes) {
    const cands = nodes.map((n) => ({ n, slug: primarySlug(n) })).filter((c) => c.slug && isVisible(c.n));
    const kept = cands.filter((c) => !cands.some((o) => o !== c && c.n.contains(o.n) && o.slug !== c.slug));
    const seen = new Set();
    const out = [];
    for (const c of kept) {
      if (seen.has(c.slug)) continue;
      seen.add(c.slug);
      out.push(c.n);
    }
    return out;
  }

  function cardsFromAnchors(main) {
    const out = [];
    const seen = new Set();
    for (const a of profileAnchors(main)) {
      const u = normalizeProfileUrl(a.href);
      const slug = u && slugOfUrl(u);
      if (!slug || seen.has(slug)) continue;
      let node = a;
      while (node.parentElement && node.parentElement !== main) {
        const p = node.parentElement;
        const slugs = new Set(profileAnchors(p).map((x) => slugOfUrl(normalizeProfileUrl(x.href))).filter(Boolean));
        if (slugs.size > 1) break;
        node = p;
      }
      if (linesOf(node).length >= 2) { seen.add(slug); out.push(node); }
    }
    return out;
  }

  /**
   * Structure-based discovery for markup we have no selectors for (hashed class names, no <li> / role=listitem):
   * search results are repeated sibling blocks that each contain a profile link. Find the element whose children
   * hold the most such blocks (belonging to different people) and treat every block as a card.
   */
  function cardsBySiblingBlocks(main) {
    const anchors = profileAnchors(main);
    if (anchors.length < 2) return [];
    const parents = new Set();
    for (const a of anchors) {
      for (let n = a.parentElement; n; n = n.parentElement) {
        parents.add(n);
        if (n === main) break;
      }
    }
    const depthOf = (el) => { let d = 0; for (let n = el; n; n = n.parentElement) d++; return d; };
    let best = null;
    for (const p of parents) {
      const blocks = Array.from(p.children).filter((c) => isVisible(c) && profileAnchors(c).length);
      if (blocks.length < 2) continue;
      const people = new Set(blocks.map(primarySlug).filter(Boolean));
      if (people.size < 2) continue;
      const depth = depthOf(p);
      if (!best || people.size > best.score || (people.size === best.score && depth < best.depth)) best = { blocks, score: people.size, depth };
    }
    return best ? best.blocks : [];
  }

  /**
   * The discovery strategies, in the order they are tried: [name, finder]. Kept as a list so the diagnostics report
   * can show how many cards each strategy sees on the real page.
   */
  function resultCardLayers(main) {
    return [
      // SELECTOR: main [role="listitem"], main li   (each filtered to nodes containing a /in/ profile link)
      // ASSUMPTION: result rows are exposed as ARIA list items or <li> elements inside <main>.
      ['list items', () => resolveCards(qsa(main, '[role="listitem"], li'))],
      // SELECTOR: [data-chameleon-result-urn]
      // ASSUMPTION: each search result root carries this data attribute (value is the person's URN).
      ['data-chameleon-result-urn', () => resolveCards(qsa(main, '[data-chameleon-result-urn]'))],
      // SELECTOR: li.reusable-search__result-container, div.entity-result
      // ASSUMPTION: legacy-but-stable LinkedIn classes still mark a result container.
      ['legacy result classes', () => resolveCards(qsa(main, 'li.reusable-search__result-container, div.entity-result'))],
      // SELECTOR: the element whose direct children are the most blocks that each contain a different person's /in/ link
      // ASSUMPTION: even with obfuscated class names, results are repeated sibling blocks (one per person).
      ['repeated sibling blocks', () => resolveCards(cardsBySiblingBlocks(main))],
      // SELECTOR: a[href*="/in/"] climbed to the largest ancestor that still contains only that one profile link
      // ASSUMPTION: a card is the biggest block around one person's link that does not include another person.
      ['anchor climb', () => resolveCards(cardsFromAnchors(main))],
    ];
  }

  /** PROFILE / CARD DISCOVERY — update here when LinkedIn changes the search-results markup. */
  function findResultCards() {
    // SELECTOR: main
    // ASSUMPTION: LinkedIn wraps page content in a single <main>; if absent we search the whole body.
    const main = qs(document, 'main') || document.body;
    const layers = resultCardLayers(main);
    for (let i = 0; i < layers.length; i++) {
      try {
        const cards = layers[i][1]();
        if (cards && cards.length) return { cards, layer: i, layerName: layers[i][0] };
      } catch (_) { /* next layer */ }
    }
    return { cards: [], layer: -1, layerName: '' };
  }

  /** PROFILE URL EXTRACTION (search card). */
  function extractProfileUrl(card) {
    return pick([
      // SELECTOR: a[href*="/in/"]  (first anchor in the card)
      // ASSUMPTION: the first profile link in a card is the person themselves; later ones are mutual connections.
      () => profileAnchors(card).map((a) => normalizeProfileUrl(a.href)).find(Boolean),
      // SELECTOR: [data-chameleon-result-urn] ancestor/descendant link
      // ASSUMPTION: if the card root has the data attribute, a link to the profile is nested inside it.
      () => {
        const root = card.matches('[data-chameleon-result-urn]') ? card : qs(card, '[data-chameleon-result-urn]');
        return root ? profileAnchors(root).map((a) => normalizeProfileUrl(a.href)).find(Boolean) : null;
      },
    ]);
  }

  /** NAME EXTRACTION (search card). Returns '' when the name is hidden (e.g. "LinkedIn Member"). */
  function extractName(card, profileUrl) {
    const anchors = profileAnchors(card).filter((a) => normalizeProfileUrl(a.href) === profileUrl);
    const strategies = [
      // SELECTOR: a[href*="/in/"] span[aria-hidden="true"]
      // ASSUMPTION: the visible name is an aria-hidden span next to a visually-hidden duplicate for screen readers.
      () => anchors.flatMap((a) => qsa(a, 'span[aria-hidden="true"]')).map(textOf).find(Boolean),
      // SELECTOR: [data-anonymize="person-name"]
      // ASSUMPTION: LinkedIn tags names with data-anonymize for its own privacy tooling.
      () => textOf(qs(card, '[data-anonymize="person-name"]')),
      // SELECTOR: a[href*="/in/"][aria-label]
      // ASSUMPTION: the profile link's aria-label reads "View Jane Doe’s profile".
      () =>
        anchors
          .map((a) => a.getAttribute('aria-label') || '')
          .map((x) => x.replace(/^view\s+/i, '').replace(/[’']s\s+(graphic\s+)?(link|profile).*$/i, ''))
          .find(Boolean),
      // SELECTOR: a[href*="/in/"] img[alt]
      // ASSUMPTION: the avatar's alt text is the person's name.
      () => anchors.map((a) => (qs(a, 'img') || {}).alt).find(Boolean),
      // SELECTOR: first non-noise line of the card text
      // ASSUMPTION: the name is the first meaningful line in the card.
      () => cardLines(card, '')[0],
    ];
    for (const s of strategies) {
      try {
        const raw = s();
        if (raw && isHiddenName(clean(raw))) return '';
        const n = cleanName(raw);
        if (n && validName(n)) return n;
      } catch (_) { /* next */ }
    }
    return '';
  }

  /** Headline text of a search card (title + company usually live here). */
  function cardHeadline(card, name) {
    return pick([
      // SELECTOR: [data-anonymize="headline"], [data-anonymize="job-title"]
      // ASSUMPTION: headline carries a data-anonymize attribute.
      () => textOf(qs(card, '[data-anonymize="headline"], [data-anonymize="job-title"]')),
      // SELECTOR: .entity-result__primary-subtitle
      // ASSUMPTION: stable class for the headline line in classic result cards.
      () => textOf(qs(card, '.entity-result__primary-subtitle')),
      // SELECTOR: second meaningful text line of the card (after the name)
      // ASSUMPTION: order in the card is name → headline → location.
      () => cardLines(card, name)[0],
    ]) || '';
  }

  /** JOB TITLE EXTRACTION (search card). */
  function extractJobTitle(card, name) {
    return splitHeadline(cardHeadline(card, name)).title;
  }

  /** COMPANY EXTRACTION (search card). */
  function extractCompany(card, name) {
    return (
      pick([
        // SELECTOR: [data-anonymize="company-name"]
        // ASSUMPTION: company name tagged with data-anonymize.
        () => textOf(qs(card, '[data-anonymize="company-name"]')),
        // SELECTOR: "Current: <title> at <company>" summary line in the card text
        // ASSUMPTION: LinkedIn adds a "Current:" line for the member's present role.
        () => {
          const l = linesOf(card).find((x) => /^current:/i.test(x));
          return l ? splitHeadline(l.replace(/^current:\s*/i, '')).company : '';
        },
        // SELECTOR: headline text split on " at " / " @ "
        // ASSUMPTION: most members write "Role at Company" in their headline.
        () => splitHeadline(cardHeadline(card, name)).company,
      ]) || ''
    );
  }

  function extractCardLocation(card, name) {
    return (
      pick([
        // SELECTOR: [data-anonymize="location"]
        // ASSUMPTION: location tagged with data-anonymize.
        () => textOf(qs(card, '[data-anonymize="location"]')),
        // SELECTOR: .entity-result__secondary-subtitle
        // ASSUMPTION: stable class for the location line in classic cards.
        () => textOf(qs(card, '.entity-result__secondary-subtitle')),
        // SELECTOR: line after the headline in the card text
        // ASSUMPTION: location is the line directly after the headline.
        () => cardLines(card, name)[1],
      ]) || ''
    );
  }

  function cardDegree(card) {
    // SELECTOR: text lines such as "• 2nd" / "1st degree connection"
    // ASSUMPTION: the connection degree is shown as a short badge line near the name.
    for (const l of linesOf(card)) {
      const m = l.match(/^[•·]?\s*(1st|2nd|3rd\+?)(\s+degree connection)?$/i);
      if (m) return m[1].toLowerCase().replace('+', '');
    }
    return null;
  }

  function cardConnectionStatus(card, degree) {
    const lines = linesOf(card).map((l) => l.toLowerCase());
    if (degree === '1st') return 'Connected';
    if (lines.includes('pending')) return 'Pending';
    if (lines.includes('connect')) return 'Not Connected';
    if (degree === '2nd' || degree === '3rd') return 'Not Connected';
    return 'Unknown';
  }

  async function collectLeads(msg) {
    assertPage('search_people');
    await guardSafety();
    // Wait for results to render.
    // SELECTOR: main (text only, to recognise the empty-results message)
    // ASSUMPTION: an empty search shows "No results found" inside <main>.
    const ready = await waitFor(() => findResultCards().cards.length || (/no results found/i.test(textOf(qs(document, 'main'))) ? -1 : 0), 12000);
    if (ready === -1) return { ok: true, leads: [], failures: [], note: 'LinkedIn reports no results for this search.' };
    const { cards, layer } = findResultCards();
    if (!cards.length) {
      await guardSafety();
      throw new LPError('MISSING_SELECTOR', 'No result cards were found on this search page. LinkedIn may have changed the results markup (update findResultCards).', { selector: 'search result cards' });
    }
    const leads = [];
    const failures = [];
    cards.slice(0, 50).forEach((card, index) => {
      // One broken card must never break the whole page.
      try {
        const profileUrl = extractProfileUrl(card);
        if (!profileUrl) { failures.push({ index, reason: 'no profile link found in the card' }); return; }
        const name = extractName(card, profileUrl);
        if (!name) { failures.push({ index, reason: 'name not visible (private "LinkedIn Member" or changed markup)' }); return; }
        const { firstName, lastName } = splitName(name);
        const degree = cardDegree(card);
        leads.push({
          firstName,
          lastName,
          profileUrl,
          jobTitle: extractJobTitle(card, name),
          company: extractCompany(card, name),
          location: extractCardLocation(card, name),
          industry: clean(msg.industry || ''), // not shown on cards; pre-filled from your target industry, editable later
          connectionStatus: cardConnectionStatus(card, degree),
        });
      } catch (e) {
        failures.push({ index, reason: `unexpected error: ${e && e.message}` });
      }
    });
    await guardSafety();
    return { ok: true, leads, failures, layer };
  }

  /* ───────────────────────────── profile page ───────────────────────────── */

  function profileH1() {
    return pick([
      // SELECTOR: main h1
      // ASSUMPTION: the member's name is the page's <h1> inside <main>.
      () => { const e = qs(document, 'main h1'); return e && isVisible(e) ? e : null; },
      // SELECTOR: h1
      // ASSUMPTION: fallback — the first visible <h1> on the page.
      () => qsa(document, 'h1').find(isVisible),
    ]);
  }

  /** NAME EXTRACTION (profile page). */
  function extractProfileName() {
    const raw = pick([
      // SELECTOR: main h1
      // ASSUMPTION: see profileH1.
      () => textOf(profileH1()),
      // SELECTOR: meta[property="og:title"]
      // ASSUMPTION: Open Graph title reads "Jane Doe - Founder - Acme | LinkedIn".
      () => (qs(document, 'meta[property="og:title"]') || {}).content,
      // SELECTOR: document.title
      // ASSUMPTION: tab title starts with the member's name, e.g. "Jane Doe | LinkedIn".
      () => document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*LinkedIn.*$/i, ''),
    ]);
    return cleanName(raw);
  }

  function profileTopCard() {
    const h1 = profileH1();
    return pick([
      // SELECTOR: h1.closest("section")
      // ASSUMPTION: the name, headline, location and action buttons share one <section> (the top card).
      () => h1 && h1.closest('section'),
      // SELECTOR: section.pv-top-card, [class*="top-card"]
      // ASSUMPTION: older / alternate class names for the top card.
      () => qs(document, 'section.pv-top-card, [class*="pv-top-card"]'),
      // SELECTOR: main section:first-of-type
      // ASSUMPTION: the top card is the first section in <main>.
      () => qs(document, 'main section'),
    ]);
  }

  function extractProfileHeadline(top, name) {
    return (
      pick([
        // SELECTOR: [data-anonymize="headline"]
        // ASSUMPTION: headline tagged with data-anonymize.
        () => textOf(qs(top, '[data-anonymize="headline"]')),
        // SELECTOR: div.text-body-medium.break-words
        // ASSUMPTION: stable utility classes on the headline line of the top card.
        () => textOf(qs(top, 'div.text-body-medium.break-words, .text-body-medium')),
        // SELECTOR: line after the name in the top-card text
        // ASSUMPTION: headline is the first meaningful line after the name.
        () => cardLines(top, name)[0],
      ]) || ''
    );
  }

  /** JOB TITLE EXTRACTION (profile page): derived from the visible headline. */
  function extractProfileJobTitle(headline) {
    return splitHeadline(headline).title;
  }

  /** COMPANY EXTRACTION (profile page). */
  function extractProfileCompany(top, headline) {
    return (
      pick([
        // SELECTOR: button[aria-label^="Current company"], a[aria-label^="Current company"]
        // ASSUMPTION: the top card has a "Current company: Acme. Click to skip to experience card" button.
        () => {
          const el = qs(top, 'button[aria-label^="Current company"], a[aria-label^="Current company"]');
          const m = el && (el.getAttribute('aria-label') || '').match(/Current company:\s*(.+?)\.?\s*(Click|$)/i);
          return m ? clean(m[1]) : '';
        },
        // SELECTOR: [data-anonymize="company-name"]
        // ASSUMPTION: company tagged with data-anonymize.
        () => textOf(qs(top, '[data-anonymize="company-name"]')),
        // SELECTOR: headline split on " at " / " @ "
        // ASSUMPTION: members usually write "Role at Company".
        () => splitHeadline(headline).company,
      ]) || ''
    );
  }

  function extractProfileLocation(top, name, headline) {
    return (
      pick([
        // SELECTOR: [data-anonymize="location"]
        // ASSUMPTION: location tagged with data-anonymize.
        () => textOf(qs(top, '[data-anonymize="location"]')),
        // SELECTOR: span.text-body-small.inline.t-black--light.break-words
        // ASSUMPTION: stable utility classes on the location line.
        () => textOf(qs(top, 'span.text-body-small.inline.t-black--light.break-words')),
        // SELECTOR: first text line with a comma after the headline
        // ASSUMPTION: location reads "City, Region, Country".
        () => cardLines(top, name).find((l) => l !== headline && /,/.test(l) && l.length < 90),
      ]) || ''
    );
  }

  function extractDegree(top) {
    const d = pick([
      // SELECTOR: span.dist-value
      // ASSUMPTION: stable class for the "1st/2nd/3rd" distance badge next to the name.
      () => textOf(qs(top, 'span.dist-value')),
      // SELECTOR: [aria-label*="degree connection" i]
      // ASSUMPTION: the badge or a nearby element has an accessible "… degree connection" label.
      () => (qs(top, '[aria-label*="degree connection" i]') || {}).ariaLabel,
      // SELECTOR: "· 1st" in the top-card text
      // ASSUMPTION: degree is rendered as a short "· 2nd" label beside the name.
      () => (textOf(top).slice(0, 400).match(/[·•]\s*(1st|2nd|3rd\+?)/i) || [])[1],
    ]);
    const m = d && String(d).match(/(1st|2nd|3rd)/i);
    return m ? m[1].toLowerCase() : null;
  }

  /** Classify one clickable element in the profile header. */
  function classifyAction(el) {
    const label = clean(el.getAttribute('aria-label') || '');
    const text = textOf(el);
    const href = el.getAttribute('href') || '';
    if (/\/preload\/custom-invite\//i.test(href) || /^invite .+ to connect/i.test(label) || /^connect$/i.test(text)) return 'connect';
    if (/^pending/i.test(label) || /^pending$/i.test(text) || /withdraw invitation/i.test(label)) return 'pending';
    if (/^message\b/i.test(label) || /^message$/i.test(text) || /\/messaging\/compose\//i.test(href)) return 'message';
    if ((/^follow\b/i.test(label) && !/following/i.test(label)) || /^follow$/i.test(text)) return 'follow';
    if (/^more( actions)?$/i.test(label) || /^more$/i.test(text)) return 'more';
    return null;
  }

  /** CONNECTION / MESSAGE BUTTON DETECTION — returns [{ kind, el }] for the profile header. */
  function collectProfileActions(top) {
    // SELECTOR: main (fallback scope when the top card was not found)
    // ASSUMPTION: the profile actions are somewhere inside <main>.
    const scope = top || qs(document, 'main') || document.body;
    // SELECTOR: button, a[role="button"], div[role="button"], a[href*="/preload/custom-invite/"], a[href*="/messaging/compose/"]
    // ASSUMPTION: Connect / Message / Follow / Pending / More are buttons (or role=button / invite links) inside the top card.
    const els = qsa(scope, 'button, a[role="button"], div[role="button"], a[href*="/preload/custom-invite/"], a[href*="/messaging/compose/"]');
    const out = [];
    for (const el of els) {
      try {
        if (!isVisible(el)) continue;
        const kind = classifyAction(el);
        if (kind) out.push({ kind, el });
      } catch (_) { /* skip this element */ }
    }
    // Prefer real <button>s over links when both exist for the same kind.
    out.sort((a, b) => (a.el.tagName === 'BUTTON' ? 0 : 1) - (b.el.tagName === 'BUTTON' ? 0 : 1));
    return out;
  }

  /** CONNECTION BUTTON DETECTION (public entry used by prepare/execute). */
  function findConnectButton(top) {
    const a = collectProfileActions(top).find((x) => x.kind === 'connect');
    return a ? a.el : null;
  }

  /** MESSAGE BUTTON DETECTION. */
  function findMessageButton(top) {
    const a = collectProfileActions(top).find((x) => x.kind === 'message');
    return a ? a.el : null;
  }

  function profileConnectionState(top, degree) {
    const acts = collectProfileActions(top);
    const has = (k) => acts.some((a) => a.kind === k);
    if (has('pending')) return 'pending';
    if (degree === '1st') return 'connected';
    if (has('connect')) return 'connect';
    if (has('more') && (degree === '2nd' || degree === '3rd')) return 'connect_via_menu';
    return acts.length ? 'unavailable' : 'unknown';
  }

  async function waitForProfile() {
    const h1 = await waitFor(profileH1, 15000);
    if (h1) {
      if (/doesn.t exist|not available|page not found|profile unavailable/i.test(textOf(h1))) return { unavailable: true };
      return { h1 };
    }
    await guardSafety();
    throw new LPError('NAV_TIMEOUT', 'The profile did not finish rendering within 15 seconds (no CAPTCHA or warning was detected).', { selector: 'profile name (h1)' });
  }

  function verifyIdentity(expectedUrl, expectedName) {
    const here = normalizeProfileUrl(location.href);
    // SELECTOR: link[rel="canonical"]
    // ASSUMPTION: profile pages declare their canonical /in/<slug>/ URL, which may differ from a URN-style URL we visited.
    const canonical = normalizeProfileUrl((qs(document, 'link[rel="canonical"]') || {}).href);
    if (expectedUrl && (here === expectedUrl || canonical === expectedUrl)) return;
    const actual = extractProfileName();
    if (expectedName && actual && namesMatch(expectedName, actual)) return;
    throw new LPError('IDENTITY_MISMATCH', `The open profile ("${actual || 'unknown'}") does not match the lead ("${expectedName || expectedUrl}"). Nothing was done.`);
  }

  async function prepareProfile(msg) {
    assertPage('profile');
    await guardSafety();
    const ready = await waitForProfile();
    if (ready.unavailable) return { ok: true, profileUnavailable: true };
    verifyIdentity(msg.expectedUrl, msg.expectedName);

    const name = extractProfileName();
    if (!name) throw new LPError('MISSING_SELECTOR', 'Could not read the profile name (update extractProfileName).', { selector: 'profile name' });
    const top = profileTopCard();
    if (!top) throw new LPError('MISSING_SELECTOR', 'Could not find the profile top card (update profileTopCard).', { selector: 'profile top card' });

    const headline = extractProfileHeadline(top, name);
    const degree = extractDegree(top);
    const acts = collectProfileActions(top);
    if (!acts.length) {
      await guardSafety();
      throw new LPError('MISSING_SELECTOR', 'No Connect / Message / Follow buttons were found in the profile header (update collectProfileActions).', { selector: 'profile action buttons' });
    }
    const state = profileConnectionState(top, degree);
    const { firstName, lastName } = splitName(name);
    const profile = {
      name, firstName, lastName, headline,
      jobTitle: extractProfileJobTitle(headline),
      company: extractProfileCompany(top, headline),
      location: extractProfileLocation(top, name, headline),
    };

    let thread = null;
    if (msg.action !== 'connect' && state === 'connected') {
      const comp = await openComposerFor(name);
      thread = await inspectThread(comp, name);
    }
    await guardSafety();
    return { ok: true, profile, connection: { state, degree }, thread };
  }

  /* ───────────────────────────── connection request ───────────────────────────── */

  function visibleDialogs() {
    // SELECTOR: [role="dialog"], .artdeco-modal
    // ASSUMPTION: LinkedIn modals are role=dialog / artdeco-modal.
    return qsa(document, '[role="dialog"], .artdeco-modal').filter(isVisible);
  }

  function dialogButton(dialog, re) {
    // SELECTOR: button, [role="button"] inside the dialog, matched by aria-label or visible text
    // ASSUMPTION: dialog actions are labelled in English ("Add a note", "Send without a note", "Send").
    return qsa(dialog, 'button, [role="button"]').find((b) => isVisible(b) && (re.test(clean(b.getAttribute('aria-label') || '')) || re.test(textOf(b))));
  }

  function findInviteDialog() {
    return visibleDialogs().find((d) => dialogButton(d, /^(add a note|send without a note|send invitation|send now|send)$/i));
  }

  async function findConnectInMoreMenu(actions) {
    const more = actions.find((a) => a.kind === 'more');
    if (!more) return null;
    clickEl(more.el, 'More actions button');
    await uxPause(300, 700);
    // SELECTOR: [role="menu"], .artdeco-dropdown__content, .artdeco-dropdown__content-inner
    // ASSUMPTION: the "More" menu renders as a role=menu / artdeco dropdown.
    const menu = await waitFor(() => qsa(document, '[role="menu"], .artdeco-dropdown__content-inner, .artdeco-dropdown__content').find(isVisible), 4000);
    if (!menu) return null;
    // SELECTOR: [role="menuitem"], [role="button"], li, button, a, div[aria-label] inside the menu
    // ASSUMPTION: the Connect entry is an item whose text is "Connect" or whose aria-label is "Invite <name> to connect".
    const item = qsa(menu, '[role="menuitem"], [role="button"], li, button, a, div[aria-label]').find(
      (el) => isVisible(el) && (classifyAction(el) === 'connect' || /^connect$/i.test(textOf(el)))
    );
    if (!item) {
      try { clickEl(more.el, 'More actions button'); } catch (_) { /* menu already closed */ }
      return null;
    }
    return item;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function executeConnect(msg) {
    assertPage('profile');
    await guardSafety();
    const ready = await waitForProfile();
    if (ready.unavailable) throw new LPError('ACTION_UNAVAILABLE', 'This profile is unavailable.');
    verifyIdentity(msg.expectedUrl, msg.expectedName);

    const top = profileTopCard();
    if (!top) throw new LPError('MISSING_SELECTOR', 'Profile top card not found.', { selector: 'profile top card' });
    const degree = extractDegree(top);
    if (degree === '1st') throw new LPError('ACTION_UNAVAILABLE', 'Already a 1st-degree connection.');
    let actions = collectProfileActions(top);
    if (actions.some((a) => a.kind === 'pending')) throw new LPError('ACTION_UNAVAILABLE', 'An invitation is already pending.');

    let btn = findConnectButton(top);
    if (!btn) btn = await findConnectInMoreMenu(actions);
    if (!btn) throw new LPError('ACTION_UNAVAILABLE', 'LinkedIn does not offer a Connect option for this profile.');

    await uxPause();
    clickEl(btn, 'Connect button');
    const dialog = await waitFor(findInviteDialog, 8000);
    await guardSafety(); // a "limit reached" / challenge dialog appears here
    if (!dialog) throw new LPError('MISSING_SELECTOR', 'The invitation dialog did not appear after clicking Connect (update findConnectButton / findInviteDialog).', { selector: 'invitation dialog' });

    // SELECTOR: input[type="email"] inside the dialog
    // ASSUMPTION: when LinkedIn requires the invitee's email it shows an email field — we must not guess it.
    if (qs(dialog, 'input[type="email"]')) throw new LPError('PAGE_CHANGED', 'LinkedIn is asking for this person’s email address before it allows a request. Stopped — connect manually if you know them.', { selector: 'invitation dialog (email required)' });

    const note = String(msg.text || '');
    if (note) {
      let area = pick([
        // SELECTOR: textarea[name="message"]
        // ASSUMPTION: the note box is a textarea named "message".
        () => qs(dialog, 'textarea[name="message"]'),
        // SELECTOR: #custom-message
        // ASSUMPTION: LinkedIn's id for the note textarea.
        () => qs(dialog, '#custom-message'),
        // SELECTOR: textarea inside the dialog
        // ASSUMPTION: the dialog has one textarea once "Add a note" is open.
        () => qs(dialog, 'textarea'),
      ]);
      if (!area) {
        const add = dialogButton(dialog, /^add a note$/i);
        if (!add) throw new LPError('MISSING_SELECTOR', 'The "Add a note" button is missing — LinkedIn may have limited personalised notes. Nothing was sent.', { selector: 'Add a note button' });
        await uxPause(400, 900);
        clickEl(add, 'Add a note button');
        area = await waitFor(() => qs(dialog, 'textarea'), 5000);
        await guardSafety();
        if (!area) throw new LPError('MISSING_SELECTOR', 'The note text box did not appear (update the textarea selectors in executeConnect).', { selector: 'invitation note textarea' });
      }
      area.focus();
      setNativeValue(area, note);
      if (area.value !== note) throw new LPError('PAGE_CHANGED', 'Could not type the note into LinkedIn’s text box.', { selector: 'invitation note textarea' });
    }

    // SEND BUTTON DETECTION (invitation)
    const sendRe = note ? /^(send invitation|send now|send)$/i : /^(send without a note|send now|send invitation|send)$/i;
    const send = await waitFor(() => { const b = dialogButton(dialog, sendRe); return b && !isDisabled(b) ? b : null; }, 5000);
    if (!send) throw new LPError('MISSING_SELECTOR', 'The Send button in the invitation dialog was not found or stayed disabled (update dialogButton / executeConnect).', { selector: 'invitation Send button' });

    await uxPause(600, 1400);
    clickEl(send, 'Send invitation button');

    const closed = await waitFor(() => !dialog.isConnected || !isVisible(dialog), 10000);
    try { await guardSafety({ clicked: true }); } catch (e) { e.extra.clicked = true; throw e; }
    if (!closed) throw new LPError('PAGE_CHANGED', 'The invitation dialog stayed open after clicking Send — LinkedIn may not have accepted it. Please check manually.', { clicked: true, selector: 'invitation dialog' });

    const verified = !!(await waitFor(() => collectProfileActions(profileTopCard()).some((a) => a.kind === 'pending'), 5000));
    return { ok: true, clicked: true, verified };
  }

  /* ───────────────────────────── messaging ───────────────────────────── */

  /** MESSAGE COMPOSER DETECTION — every visible message editor with its container. */
  function findMessageComposer() {
    const out = [];
    const seen = new Set();
    const layers = [
      // SELECTOR: [role="textbox"][contenteditable="true"][aria-label*="message" i]
      // ASSUMPTION: the message box is a role=textbox contenteditable labelled "Write a message…".
      () => qsa(document, '[role="textbox"][contenteditable="true"][aria-label*="message" i]'),
      // SELECTOR: div.msg-form__contenteditable[contenteditable="true"]
      // ASSUMPTION: stable LinkedIn class on the message editor.
      () => qsa(document, 'div.msg-form__contenteditable[contenteditable="true"]'),
      // SELECTOR: form[class*="msg-form"] [contenteditable="true"]
      // ASSUMPTION: the editor sits inside a form whose class contains "msg-form".
      () => qsa(document, 'form[class*="msg-form"] [contenteditable="true"]'),
    ];
    for (const fn of layers) {
      try {
        for (const el of fn()) {
          if (isVisible(el) && !seen.has(el)) { seen.add(el); out.push({ editor: el, container: composerContainer(el) }); }
        }
      } catch (_) { /* next layer */ }
    }
    return out;
  }

  function composerContainer(editor) {
    // SELECTOR: closest(.msg-overlay-conversation-bubble, [class*="msg-overlay-conversation-bubble"], [class*="msg-convo-wrapper"], [role="dialog"], aside)
    // ASSUMPTION: the editor lives in a conversation bubble / thread wrapper that also contains the header and message list.
    const c = editor.closest('.msg-overlay-conversation-bubble, [class*="msg-overlay-conversation-bubble"], [class*="msg-convo-wrapper"], [role="dialog"], aside');
    if (c) return c;
    let n = editor;
    for (let i = 0; i < 6 && n.parentElement; i++) n = n.parentElement;
    return n;
  }

  function conversationTitle(container) {
    return (
      pick([
        // SELECTOR: [class*="msg-overlay-bubble-header__title"], [class*="msg-overlay-bubble-header"] h2
        // ASSUMPTION: the bubble header shows the other person's name.
        () => textOf(qs(container, '[class*="msg-overlay-bubble-header__title"], [class*="msg-overlay-bubble-header"] h2')),
        // SELECTOR: [class*="msg-entity-lockup__entity-title"]
        // ASSUMPTION: full messaging thread header uses the entity-lockup title.
        () => textOf(qs(container, '[class*="msg-entity-lockup__entity-title"], [class*="entity-lockup__entity-title"]')),
        // SELECTOR: container[aria-label], header h2/h3
        // ASSUMPTION: fallback — accessible label or a heading in the header names the conversation.
        () => container.getAttribute('aria-label') || textOf(qs(container, 'header h2, header h3, header')),
      ]) || ''
    );
  }

  /**
   * Find (or open) the composer for THIS person. Typing into the wrong conversation is the worst
   * possible failure, so the header must mention the profile's name or we stop.
   */
  async function openComposerFor(name) {
    const matching = () => findMessageComposer().find((c) => textMentionsName(conversationTitle(c.container), name));
    let comp = matching();
    if (comp) return comp;

    const top = profileTopCard();
    const btn = findMessageButton(top);
    if (!btn) throw new LPError('MISSING_SELECTOR', 'The Message button was not found on the profile (update findMessageButton).', { selector: 'Message button' });
    await uxPause();
    clickEl(btn, 'Message button');
    comp = await waitFor(matching, 9000);
    if (comp) return comp;

    await guardSafety();
    if (findMessageComposer().length) {
      throw new LPError('IDENTITY_MISMATCH', `A message box opened, but its header does not show "${name}". Nothing was typed — close other chats and retry.`, { selector: 'message composer header' });
    }
    throw new LPError('MISSING_SELECTOR', 'The message box did not open after clicking Message (update findMessageComposer).', { selector: 'message composer' });
  }

  /** Best-effort read of the visible thread: has this person replied? ('replied' | 'no_reply' | 'unknown') */
  async function inspectThread(comp, name) {
    // SELECTOR: .msg-s-message-group  (exact class token)
    // ASSUMPTION: each run of consecutive messages from one sender is a .msg-s-message-group showing the sender's name.
    const groups = await waitFor(() => { const g = qsa(comp.container, '.msg-s-message-group'); return g.length ? g : null; }, 2500);
    if (!groups) return { status: 'unknown' };
    let readable = false;
    for (const g of groups) {
      try {
        // SELECTOR: .msg-s-message-group__name, [class*="message-group__name"], .msg-s-message-group__profile-link
        // ASSUMPTION: the sender's name is shown at the top of each group.
        const n = textOf(qs(g, '.msg-s-message-group__name, [class*="message-group__name"], .msg-s-message-group__profile-link'));
        if (!n) continue;
        readable = true;
        if (namesMatch(name, n)) return { status: 'replied' };
      } catch (_) { /* skip group */ }
    }
    return { status: readable ? 'no_reply' : 'unknown' };
  }

  /** Put text in a contenteditable box using normal editing commands so LinkedIn's editor registers it. */
  function setEditableText(el, text) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete');
    const lines = String(text).split('\n');
    lines.forEach((ln, i) => {
      if (i > 0) document.execCommand('insertParagraph');
      if (ln) document.execCommand('insertText', false, ln);
    });
    const want = norm(text).slice(0, 30);
    if (norm(textOf(el)).includes(want)) return true;
    // Fallback for editors that ignore execCommand.
    el.textContent = '';
    lines.forEach((ln) => { const p = document.createElement('p'); p.textContent = ln; el.appendChild(p); });
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return norm(textOf(el)).includes(want);
  }

  /** SEND BUTTON DETECTION (message composer). */
  function findMessageSendButton(container) {
    return pick([
      // SELECTOR: form button[type="submit"] whose text is "Send"
      // ASSUMPTION: the composer is a <form> with a submit button labelled "Send".
      () => qsa(container, 'form button[type="submit"]').find((b) => isVisible(b) && /^send$/i.test(accName(b))),
      // SELECTOR: button.msg-form__send-button
      // ASSUMPTION: stable class of the composer's send button.
      () => qsa(container, 'button.msg-form__send-button').find(isVisible),
      // SELECTOR: any button in the container labelled exactly "Send"
      // ASSUMPTION: last-resort match on the accessible name.
      () => qsa(container, 'button').find((b) => isVisible(b) && /^send$/i.test(accName(b))),
    ]);
  }

  async function executeMessage(msg) {
    assertPage('profile');
    await guardSafety();
    const ready = await waitForProfile();
    if (ready.unavailable) throw new LPError('ACTION_UNAVAILABLE', 'This profile is unavailable.');
    verifyIdentity(msg.expectedUrl, msg.expectedName);

    const name = extractProfileName();
    const top = profileTopCard();
    if (extractDegree(top) !== '1st') throw new LPError('ACTION_UNAVAILABLE', 'Not a confirmed 1st-degree connection — messages go to existing connections only.');

    const comp = await openComposerFor(name);
    const thread = await inspectThread(comp, name);
    if (thread.status === 'replied') throw new LPError('ACTION_UNAVAILABLE', 'They have already replied in this conversation.', { replied: true });

    await uxPause();
    if (!setEditableText(comp.editor, msg.text)) throw new LPError('PAGE_CHANGED', 'Could not type the message into LinkedIn’s message box (update setEditableText / findMessageComposer).', { selector: 'message composer' });
    await uxPause(600, 1400);

    const send = await waitFor(() => { const b = findMessageSendButton(comp.container); return b && !isDisabled(b) ? b : null; }, 6000);
    if (!send) throw new LPError('MISSING_SELECTOR', 'The Send button in the message box was not found or stayed disabled (update findMessageSendButton). The text was left in the box, unsent.', { selector: 'message Send button' });
    clickEl(send, 'Send message button');

    const sent = await waitFor(() => !norm(textOf(comp.editor)) || !comp.editor.isConnected, 8000);
    try { await guardSafety({ clicked: true }); } catch (e) { e.extra.clicked = true; throw e; }
    return { ok: true, clicked: true, verified: !!sent };
  }

  /* ───────────────────────────── company page + posts ───────────────────────────── */

  /** COMPANY PAGE DETECTION */
  function detectCompanyPage() {
    const m = location.pathname.match(/^\/company\/([^/]+)/i);
    if (!m) return { isCompanyPage: false };
    const slug = decodeURIComponent(m[1]);
    const name = cleanName(
      pick([
        // SELECTOR: .org-top-card-summary__title, main h1
        // ASSUMPTION: the page name is the main heading of the company header.
        () => textOf(qs(document, '.org-top-card-summary__title, main h1')),
        // SELECTOR: meta[property="og:title"]
        // ASSUMPTION: Open Graph title is "Company | LinkedIn".
        () => ((qs(document, 'meta[property="og:title"]') || {}).content || '').replace(/\s*\|\s*LinkedIn.*$/i, ''),
        // SELECTOR: document.title
        // ASSUMPTION: tab title is "Company | LinkedIn".
        () => document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*LinkedIn.*$/i, ''),
      ]) || ''
    ).replace(/\s*[-–—]\s*admin.*$/i, '');
    const isAdminView = !!pick([
      // SELECTOR: location.pathname contains /admin/
      // ASSUMPTION: the admin view lives under /company/<id>/admin/.
      () => /\/admin(\/|$)/i.test(location.pathname),
      // SELECTOR: button / link whose text is "Admin tools", "Admin view" or "Manage page"
      // ASSUMPTION: the public view shows an admin menu only to page admins.
      () => qsa(document, 'button, a').some((el) => /^(admin tools|admin view|manage page)$/i.test(textOf(el))),
      // SELECTOR: [data-test-id*="admin" i]
      // ASSUMPTION: admin-only widgets carry a data-test-id containing "admin".
      () => qs(document, '[data-test-id*="admin" i]'),
    ]);
    return { isCompanyPage: true, slug, name, isAdminView, adminUrl: `https://www.linkedin.com/company/${encodeURIComponent(slug)}/admin/` };
  }

  function findPostTrigger() {
    return pick([
      // SELECTOR: button / role=button whose accessible name starts with "Start a post"
      // ASSUMPTION: the feed and the Company Page admin both show a launcher labelled "Start a post".
      () => qsa(document, 'button, [role="button"]').find((el) => isVisible(el) && /^start a post/i.test(accName(el))),
      // SELECTOR: button.share-box-feed-entry__trigger
      // ASSUMPTION: stable class on the feed's post launcher.
      () => qsa(document, 'button.share-box-feed-entry__trigger').find(isVisible),
    ]);
  }

  async function openCompanyCreateMenu() {
    // SELECTOR: button / role=button whose text is "Create"
    // ASSUMPTION: admin pages hide "Start a post" under a "Create" menu.
    const create = await waitFor(() => qsa(document, 'button, [role="button"]').find((el) => isVisible(el) && /^create$/i.test(accName(el))), 6000);
    if (!create) return null;
    clickEl(create, 'Create button');
    await uxPause(300, 800);
    // SELECTOR: menu item whose text contains "Start a post" / "Create a post" / "Post"
    // ASSUMPTION: the Create menu lists a post entry.
    return waitFor(
      () => qsa(document, '[role="menuitem"], [role="menu"] li, [role="menu"] button, .artdeco-dropdown__content li, .artdeco-dropdown__content button, .artdeco-dropdown__content a').find((el) => isVisible(el) && /(start|create) a post|^post$/i.test(textOf(el))),
      4000
    );
  }

  /** POST COMPOSER DETECTION — the open composer dialog and its editor. */
  function findPostComposer() {
    const dialogs = visibleDialogs();
    for (const d of dialogs) {
      const editor = pick([
        // SELECTOR: [role="textbox"][contenteditable="true"] inside a dialog
        // ASSUMPTION: the post editor is a role=textbox contenteditable ("Text editor for creating content").
        () => qsa(d, '[role="textbox"][contenteditable="true"]').find(isVisible),
        // SELECTOR: .ql-editor[contenteditable="true"]
        // ASSUMPTION: LinkedIn's editor is Quill-based and uses the ql-editor class.
        () => qsa(d, '.ql-editor[contenteditable="true"]').find(isVisible),
        // SELECTOR: div[contenteditable="true"] inside a dialog
        // ASSUMPTION: last resort — the only rich-text box in the dialog.
        () => qsa(d, 'div[contenteditable="true"]').find(isVisible),
      ]);
      if (editor) return { dialog: d, editor };
    }
    return null;
  }

  function readComposerIdentity(dialog) {
    return (
      pick([
        // SELECTOR: [class*="share-creator-inline"], [class*="share-box-header"], [class*="share-actor"]
        // ASSUMPTION: the composer header names the author ("Post as …" / the member or page name).
        () => scanText(qs(dialog, '[class*="share-creator-inline"], [class*="share-box-header"], [class*="share-actor"]') || document.createElement('i')),
        // SELECTOR: dialog h2 / [role="heading"]
        // ASSUMPTION: the dialog heading includes the author name.
        () => textOf(qs(dialog, 'h2, [role="heading"]')),
        // SELECTOR: first lines of the dialog text (editor excluded)
        // ASSUMPTION: the author's name appears at the very top of the composer.
        () => scanText(dialog).slice(0, 160),
      ]) || ''
    );
  }

  function findPostSubmitButton(dialog) {
    return pick([
      // SELECTOR: button.share-actions__primary-action
      // ASSUMPTION: stable class on the composer's primary Post button.
      () => qsa(dialog, 'button.share-actions__primary-action').find((b) => isVisible(b) && /^post$/i.test(accName(b))),
      // SELECTOR: button labelled exactly "Post"
      // ASSUMPTION: the submit button's accessible name is "Post" (not "Schedule post").
      () => qsa(dialog, 'button').find((b) => isVisible(b) && /^post$/i.test(accName(b))),
    ]);
  }

  async function publishPost(msg) {
    await guardSafety();
    const { target, text, companyName } = msg;
    const others = (msg.otherPageNames || []).filter(Boolean);

    if (target === 'personal') {
      if (pageType() !== 'feed') throw new LPError('WRONG_PAGE', 'Open your LinkedIn feed (linkedin.com/feed) to post from your Personal Profile.');
    } else {
      const c = detectCompanyPage();
      if (!c.isCompanyPage || !c.isAdminView) throw new LPError('WRONG_PAGE', 'Open the ADMIN view of your Company Page to post as the Page.');
      if (companyName && c.name && !norm(c.name).includes(norm(companyName)) && !norm(companyName).includes(norm(c.name))) {
        throw new LPError('IDENTITY_MISMATCH', `The open Company Page is "${c.name}", but the post is for "${companyName}". Nothing was posted.`);
      }
    }

    let trigger = await waitFor(findPostTrigger, target === 'company' ? 2500 : 8000); // Company admin pages usually hide it under "Create"
    if (!trigger && target === 'company') trigger = await openCompanyCreateMenu();
    await guardSafety();
    if (!trigger) throw new LPError('MISSING_SELECTOR', 'The "Start a post" button was not found (update findPostTrigger / openCompanyCreateMenu).', { selector: 'Start a post button' });
    await uxPause();
    clickEl(trigger, 'Start a post button');

    const comp = await waitFor(findPostComposer, 10000);
    await guardSafety();
    if (!comp) throw new LPError('MISSING_SELECTOR', 'The post composer did not open (update findPostComposer).', { selector: 'post composer' });

    // Authorship check BEFORE typing: never publish as the wrong identity.
    const identity = readComposerIdentity(comp.dialog);
    if (target === 'company') {
      if (!identity || !norm(identity).includes(norm(companyName))) {
        throw new LPError('IDENTITY_MISMATCH', `The composer does not show "${companyName}" as the author${identity ? ` (it shows "${identity.slice(0, 80)}")` : ''}. Nothing was posted.`, { selector: 'composer author' });
      }
    } else if (identity && others.some((n) => norm(identity).includes(norm(n)))) {
      throw new LPError('IDENTITY_MISMATCH', 'The composer is set to post as a Company Page, but you chose Personal Profile. Nothing was posted.', { selector: 'composer author' });
    }

    await uxPause();
    if (!setEditableText(comp.editor, text)) throw new LPError('PAGE_CHANGED', 'Could not type the post text into LinkedIn’s editor (update findPostComposer / setEditableText).', { selector: 'post editor' });
    await uxPause(800, 1600);

    const submit = await waitFor(() => { const b = findPostSubmitButton(comp.dialog); return b && !isDisabled(b) ? b : null; }, 8000);
    if (!submit) throw new LPError('MISSING_SELECTOR', 'The Post button was not found or stayed disabled (update findPostSubmitButton). The text was left in the composer, unpublished.', { selector: 'Post button' });
    clickEl(submit, 'Post button');

    const closed = await waitFor(() => !comp.dialog.isConnected || !isVisible(comp.dialog), 15000);
    try { await guardSafety({ clicked: true }); } catch (e) { e.extra.clicked = true; throw e; }
    if (!closed) throw new LPError('PAGE_CHANGED', 'The composer stayed open after clicking Post — it may not have been published. Please check LinkedIn.', { clicked: true, selector: 'post composer' });
    return { ok: true, clicked: true, verified: true, identity: target === 'company' ? companyName : identity || 'Personal Profile' };
  }

  /* ───────────────────────────── engagement (visible metrics only) ───────────────────────────── */

  function parseCount(s) {
    if (!s) return null;
    const m = String(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([kKmM])?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (m[2]) n *= /k/i.test(m[2]) ? 1000 : 1000000;
    return Math.round(n);
  }

  function findPostCards() {
    const layers = [
      // SELECTOR: [data-urn^="urn:li:activity"], [data-id^="urn:li:activity"]
      // ASSUMPTION: feed posts carry their activity URN in a data attribute.
      () => qsa(document, '[data-urn^="urn:li:activity"], [data-id^="urn:li:activity"]'),
      // SELECTOR: div.feed-shared-update-v2
      // ASSUMPTION: stable class of a feed update container.
      () => qsa(document, 'div.feed-shared-update-v2'),
      // SELECTOR: main [role="article"]
      // ASSUMPTION: posts are exposed as ARIA articles.
      () => qsa(document, 'main [role="article"]'),
    ];
    for (const fn of layers) {
      try { const r = fn().filter(isVisible); if (r.length) return r; } catch (_) { /* next */ }
    }
    return [];
  }

  async function collectEngagement() {
    const pt = pageType();
    if (pt === 'feed' || !['profile', 'company'].includes(pt)) {
      throw new LPError('WRONG_PAGE', 'Open the list of YOUR posts (your profile’s "Posts / Activity" page, or your Company Page posts) — the home feed also shows other people’s posts.');
    }
    await guardSafety();
    await waitFor(() => findPostCards().length, 8000);
    const cards = findPostCards();
    if (!cards.length) throw new LPError('MISSING_SELECTOR', 'No posts were found on this page (update findPostCards).', { selector: 'post cards' });
    const items = [];
    for (const card of cards.slice(0, 25)) {
      try {
        const urn = card.getAttribute('data-urn') || card.getAttribute('data-id') || '';
        const snippet = clean(
          pick([
            // SELECTOR: .update-components-text, .feed-shared-update-v2__description, .feed-shared-text
            // ASSUMPTION: the post body sits in one of these text containers.
            () => textOf(qs(card, '.update-components-text, .feed-shared-update-v2__description, .feed-shared-text')),
            // SELECTOR: span[dir="ltr"]
            // ASSUMPTION: fallback — the first left-to-right text span is the post body.
            () => textOf(qs(card, 'span[dir="ltr"]')),
          ]) || ''
        ).slice(0, 200);
        const full = textOf(card);
        const metric = (labelRe, selectors) => {
          // SELECTOR: counts buttons — [aria-label*="reaction"], [aria-label*="comment"], [aria-label*="repost"]
          // ASSUMPTION: the social counts bar exposes "123 reactions", "12 comments", "3 reposts" in aria-labels or text.
          for (const sel of selectors) {
            const el = qs(card, sel);
            const n = el && parseCount((el.getAttribute('aria-label') || '') + ' ' + textOf(el));
            if (n != null) return n;
          }
          const m = full.match(new RegExp(`(\\d[\\d,.]*\\s*[kKmM]?)\\s*${labelRe}`, 'i'));
          return m ? parseCount(m[1]) : null;
        };
        items.push({
          urn,
          snippet,
          reactions: metric('reactions?', ['.social-details-social-counts__reactions-count', 'button[aria-label*="reaction" i]']),
          comments: metric('comments?', ['button[aria-label*="comment" i]', '.social-details-social-counts__comments']),
          reposts: metric('reposts?', ['button[aria-label*="repost" i]']),
        });
      } catch (_) { /* skip this post */ }
    }
    return { ok: true, items, target: pt === 'company' ? 'company' : 'personal' };
  }

  /* ───────────────────────────── diagnostics (read-only) ───────────────────────────── */

  // The report is meant to be pasted to whoever maintains the selectors. It describes the STRUCTURE of the page
  // (tags, roles, class names, which finder matched what) and never copies page text: every text node, label, alt text
  // and link is reduced to a length or a pattern. Only generic LinkedIn UI words ("Connect", "Message", "2nd"…) stay readable.
  // Nothing here clicks, types or navigates.
  const SAFE_TEXT = /^(?:[•·]\s*)?(?:connect|message|follow|following|pending|more|more actions|send|send now|send invitation|save|view profile|1st|2nd|3rd\+?|add a note|send without a note|start a post|withdraw|admin tools|admin view|manage page|resources)$/i;
  const UI_WORDS = new Set(
    ('invite to connect message follow following pending withdraw invitation sent more actions click skip send save view profile ' +
      'current company experience card add a note without 1st 2nd 3rd degree connection status is online reachable').split(' ')
  );
  const KNOWN_PATH_SEGMENTS = new Set(['in', 'preload', 'custom-invite', 'messaging', 'compose', 'thread', 'search', 'results', 'people', 'company', 'feed', 'admin', 'posts', 'recent-activity', 'all', 'details', 'overlay', 'contact-info']);

  const shapeText = (t) => {
    t = clean(t);
    if (!t) return '';
    return SAFE_TEXT.test(t) ? t : `[${t.length}ch]`;
  };
  const shapeLabel = (t) =>
    clean(t)
      .split(' ')
      .map((w) => (UI_WORDS.has(w.toLowerCase().replace(/[^a-z0-9+]/g, '')) ? w : '·'))
      .join(' ')
      .slice(0, 80);

  function shapeHref(h) {
    try {
      const u = new URL(h, location.href);
      const segs = u.pathname.split('/').filter(Boolean).map((x) => (KNOWN_PATH_SEGMENTS.has(x) ? x : '…'));
      return `${u.hostname === location.hostname ? '' : u.hostname}/${segs.join('/')}${u.search ? '?…' : ''}`;
    } catch (_) {
      return '[href]';
    }
  }

  function redactPath(path) {
    return String(path)
      .replace(/^(\/in\/)[^/]+/i, '$1<profile>')
      .replace(/^(\/company\/)[^/]+/i, '$1<page>')
      .replace(/^(\/messaging\/thread\/)[^/]+/i, '$1<thread>')
      .replace(/^(\/school\/)[^/]+/i, '$1<school>');
  }

  function describeEl(el) {
    if (!el) return null;
    const label = el.getAttribute('aria-label');
    const href = el.getAttribute('href');
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      label: label ? shapeLabel(label) : undefined,
      text: shapeText(textOf(el)) || undefined,
      href: href ? shapeHref(href) : undefined,
      disabled: isDisabled(el) || undefined,
      visible: isVisible(el),
    };
  }

  const KEEP_ATTRS = new Set(['role', 'type', 'aria-hidden', 'aria-expanded', 'aria-haspopup', 'aria-disabled', 'contenteditable', 'tabindex', 'target', 'rel', 'disabled']);

  /** Indented tag outline of `root` with all content removed (see the note above). */
  function skeleton(root, maxDepth = 5, maxNodes = 80) {
    if (!root) return '';
    const lines = [];
    let count = 0;
    const walk = (el, depth) => {
      if (count >= maxNodes) return;
      count++;
      const attrs = [];
      for (const a of Array.from(el.attributes)) {
        const n = a.name;
        if (KEEP_ATTRS.has(n)) attrs.push(`${n}=${a.value}`);
        else if (n === 'class') attrs.push(`class="${a.value.split(/\s+/).filter(Boolean).slice(0, 4).join(' ')}"`);
        else if (n === 'href') attrs.push(`href=${shapeHref(a.value)}`);
        else if (n === 'aria-label') attrs.push(`aria-label="${shapeLabel(a.value)}"`);
        else if (n === 'alt' || n === 'title' || n === 'placeholder') attrs.push(`${n}=[${a.value.length}ch]`);
        else if (/^data-(view-name|test-id|anonymize|control-name|tracking-control-name)$/.test(n)) attrs.push(`${n}=${a.value.slice(0, 40)}`);
        else if (n.startsWith('data-') || n === 'componentkey' || n === 'id') attrs.push(n); // name only: the values may be ids / URNs
      }
      const own = Array.from(el.childNodes)
        .filter((x) => x.nodeType === 3)
        .map((x) => x.textContent)
        .join(' ');
      const t = shapeText(own);
      const pad = '  '.repeat(depth);
      lines.push(`${pad}<${el.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>${t ? ' ' + t : ''}`);
      if (depth >= maxDepth) {
        if (el.children.length) lines.push(`${pad}  … ${el.children.length} child element(s) not shown`);
        return;
      }
      const kids = Array.from(el.children);
      for (const c of kids.slice(0, 12)) walk(c, depth + 1);
      if (kids.length > 12) lines.push(`${pad}  … +${kids.length - 12} more`);
    };
    walk(root, 0);
    if (count >= maxNodes) lines.push('… (truncated)');
    return lines.join('\n');
  }

  function diagnoseSearch(main) {
    const layers = resultCardLayers(main).map(([name, fn]) => {
      let n = -1;
      try { n = fn().length; } catch (_) { /* counted as -1 = threw */ }
      return { name, cards: n };
    });
    const { cards, layerName } = findResultCards();
    const links = profileAnchors(main);
    const out = {
      profileLinks: links.length,
      distinctProfiles: new Set(links.map((a) => slugOfUrl(normalizeProfileUrl(a.href))).filter(Boolean)).size,
      layers,
      layerUsed: layerName || null,
      cardCount: cards.length,
      emptyResultsMessage: /no results found/i.test(textOf(main)),
      sample: [],
    };
    for (const card of cards.slice(0, 2)) {
      try {
        const url = extractProfileUrl(card);
        const name = url ? extractName(card, url) : '';
        const degree = cardDegree(card);
        out.sample.push({
          urlFound: !!url,
          nameFound: !!name,
          nameLength: name.length,
          jobTitleLength: extractJobTitle(card, name).length,
          companyLength: extractCompany(card, name).length,
          locationLength: extractCardLocation(card, name).length,
          degree,
          connectionStatus: cardConnectionStatus(card, degree),
          lines: linesOf(card).slice(0, 14).map(shapeText),
          skeleton: skeleton(card, 6, 70),
        });
      } catch (e) {
        out.sample.push({ error: String((e && e.message) || e).slice(0, 160) });
      }
    }
    return out;
  }

  function diagnoseProfile() {
    const h1 = profileH1();
    const top = profileTopCard();
    const name = extractProfileName();
    const headline = top ? extractProfileHeadline(top, name) : '';
    const degree = top ? extractDegree(top) : null;
    return {
      h1: describeEl(h1),
      nameFound: !!name,
      topCardFound: !!top,
      headlineLength: headline.length,
      jobTitleLength: extractProfileJobTitle(headline).length,
      companyLength: top ? extractProfileCompany(top, headline).length : 0,
      locationLength: top ? extractProfileLocation(top, name, headline).length : 0,
      degree,
      connectionState: top ? profileConnectionState(top, degree) : null,
      classifiedActions: top ? collectProfileActions(top).map((a) => ({ kind: a.kind, ...describeEl(a.el) })) : [],
      controlsInTopCard: top ? qsa(top, 'button, a, [role="button"]').filter(isVisible).slice(0, 25).map(describeEl) : [],
      topCardSkeleton: skeleton(top, 5, 90),
    };
  }

  async function diagnose() {
    const pt = pageType();
    const main = qs(document, 'main');
    const finding = detectSecurityState();
    const report = {
      contentScript: { version: CS_VERSION },
      page: {
        host: location.hostname,
        path: redactPath(location.pathname),
        type: pt,
        readyState: document.readyState,
        language: document.documentElement.lang || '',
        hasMain: !!main,
        h1Count: qsa(document, 'h1').length,
        globalNav: !!qs(document, '#global-nav, nav.global-nav, header[role="banner"]'),
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      },
      security: {
        status: finding.status,
        where: String(finding.where || '').slice(0, 60) || undefined,
        evidence: finding.evidence ? String(finding.evidence).slice(0, 160) : undefined,
      },
      alertContainers: alertContainers().slice(0, 6).map((c) => {
        const t = scanText(c);
        return {
          tag: c.tagName.toLowerCase(),
          role: c.getAttribute('role') || '',
          visible: isVisible(c),
          textLength: t.length,
          matches: ['restricted', 'captcha', 'rate'].filter((g) => matchGroup(g, t)),
        };
      }),
      messageComposers: findMessageComposer().length,
    };
    try {
      if (pt === 'search_people') report.search = diagnoseSearch(main || document.body);
      else if (pt === 'profile') report.profile = diagnoseProfile();
      else if (pt === 'feed') report.feed = { postTrigger: describeEl(findPostTrigger()), composerOpen: !!findPostComposer() };
      else if (pt === 'company') {
        const c = detectCompanyPage();
        report.company = { isAdminView: c.isAdminView, nameFound: !!c.name, postTrigger: describeEl(findPostTrigger()) };
      }
    } catch (e) {
      report.error = String((e && e.message) || e).slice(0, 200);
    }
    return { ok: true, report };
  }

  /* ───────────────────────────── message router ───────────────────────────── */

  let busy = false;

  const HANDLERS = {
    PING: async () => ({ ok: true, version: CS_VERSION, pageType: pageType(), url: location.href }),
    SCAN_SAFETY: async () => ({ ok: true, finding: detectSecurityState() }),
    DETECT_COMPANY: async () => ({ ok: true, company: detectCompanyPage() }),
    DIAGNOSE: diagnose,
    COLLECT_LEADS: collectLeads,
    PREPARE_PROFILE: prepareProfile,
    EXECUTE_ACTION: (m) => (m.action === 'connect' ? executeConnect(m) : executeMessage(m)),
    PUBLISH_POST: publishPost,
    COLLECT_ENGAGEMENT: collectEngagement,
  };
  const PASSIVE = new Set(['PING', 'SCAN_SAFETY', 'DETECT_COMPANY', 'DIAGNOSE']);

  function errorResponse(e) {
    if (e instanceof LPError) return { ok: false, code: e.code, message: e.message, ...e.extra };
    return { ok: false, code: 'PAGE_CHANGED', message: `Unexpected page error: ${e && e.message ? e.message : e}` };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return false;
    const handler = HANDLERS[msg.type];
    if (!handler) return false;
    if (!PASSIVE.has(msg.type)) {
      if (busy) { sendResponse({ ok: false, code: 'PAGE_CHANGED', message: 'The page is still busy with the previous action.' }); return false; }
      busy = true;
    }
    Promise.resolve()
      .then(() => handler(msg))
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse(errorResponse(e)))
      .finally(() => { if (!PASSIVE.has(msg.type)) busy = false; });
    return true;
  });

  // Read-only handles for maintenance: DevTools → Console → choose the "LeadPilot LinkedIn" context, then e.g.
  //   __leadPilotContent.findResultCards()   or   __leadPilotContent.detectSecurityState()
  // None of these click, type or send anything.
  Object.assign(window.__leadPilotContent, {
    pageType, findResultCards, extractProfileUrl, extractName, extractProfileName, extractJobTitle, extractCompany,
    extractProfileHeadline, extractProfileCompany, profileTopCard, collectProfileActions, findConnectButton, findMessageButton,
    findMessageComposer, findMessageSendButton, findPostTrigger, findPostComposer, detectCompanyPage, detectSecurityState,
    diagnose, skeleton,
  });

  startWatcher();
})();
