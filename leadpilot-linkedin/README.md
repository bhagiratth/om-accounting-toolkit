# LeadPilot LinkedIn

A **compliance-first** Chrome extension (Manifest V3, plain JavaScript, **no build step, no npm, no libraries**) that
assists with LinkedIn lead generation for both your **Personal Profile** and a **Company Page** you administer.

It is an *assistant*, not a spam bot. It drafts personalised text, asks you to approve it, and then performs the action
through the **visible LinkedIn page you already have open**. It stops the moment LinkedIn shows a warning.

> **Please read:** LinkedIn's User Agreement restricts automated activity and scraping tools, and it can limit accounts
> at its own discretion — even for low volumes. LeadPilot is deliberately conservative (review-before-send, small daily
> budgets, instant stop on any warning), which lowers risk but cannot remove it. Use it on your own account, keep
> volumes low, and make sure you are comfortable with LinkedIn's terms.

---

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest. Permissions: `storage`, `alarms`, `scripting`; host access only to `https://www.linkedin.com/*`. |
| `background.js` | Service worker. Owns job state, limits, queue, follow-up scheduling, lead DB, activity log, CSV, tab binding, crash recovery. |
| `content.js` | Runs on linkedin.com. Reads the visible page and clicks/types in the visible UI when told to. Never decides *whether* to act. |
| `popup.html` / `popup.css` / `popup.js` | The ~400 px dashboard (light + dark, keyboard accessible). |
| `icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png` | Toolbar / extensions-page icons (Chrome needs PNG in the manifest). A gradient tile with a white paper plane, matching the popup header. |
| `icons/icon.svg` | Editable source artwork for the PNGs. |
| `README.md` | This file. |

To change the icon, edit `icons/icon.svg` and re-export it to the four PNG sizes (any SVG-to-PNG tool works, e.g. Inkscape or
a browser screenshot of the SVG at 16 / 32 / 48 / 128 px with a transparent background), then reload the extension.

---

## 1. Installation

1. Get the folder: clone the repo, or unzip the zip you were given (right-click → **Extract All…** on Windows; double-click on macOS).
2. Open the extracted folder and check that you can see **`manifest.json` directly inside it**, next to `background.js`, `popup.html` and `icons/`. That is the folder to load. (If you see a single folder with the same name inside, open it and use that one.)
3. Open `chrome://extensions`.
4. Switch **Developer mode** on (top-right).
5. Click **Load unpacked** and select that folder. Chrome saying *"Manifest file is missing or unreadable"* means you picked a folder that does not contain `manifest.json` (usually the outer one, or the zip itself).
6. Pin the extension (puzzle-piece menu → pin) so the popup is one click away. The popup footer (Settings tab) shows the installed version.

There is nothing to install or compile.

**First run:** open linkedin.com in the tab you want to use, click the LeadPilot icon (the **Getting started** card on the Dashboard shows the next step), and try one lead in Review Before Send mode. If something does not work, see *Diagnostics* below.

## 2. How to reload after code changes

* Edited `popup.*`: just close and re-open the popup.
* Edited `background.js` or `manifest.json`: `chrome://extensions` → click the ↻ reload icon on the LeadPilot card.
* Edited `content.js`: reload the extension **and** refresh (F5) the LinkedIn tab. (LeadPilot also tries to re-inject
  the script into already-open tabs on demand, but refreshing is the reliable way.)
* A syntax error shows up on the extension card as **Errors**; click it for details. The service worker console is
  under **Inspect views → service worker**.

## 3. LinkedIn login requirements

* You must already be **signed in to linkedin.com in Chrome**. LeadPilot never sees or stores your password and never
  logs in for you.
* If LinkedIn shows a sign-in page, the run **pauses** with *Login required*. Sign in yourself, then press **Resume**.
* The interface is assumed to be **English**.

### How tabs are used

LeadPilot only ever drives **one tab: the one you attach** (open linkedin.com → click the extension → **Attach this
tab**). It never opens hidden tabs or windows, never rotates accounts, and never touches non-LinkedIn tabs. When you
start a run it navigates *that* tab to each lead's profile in turn (the same as you clicking a profile link). If you close
the tab the run pauses.

## 4. Personal Profile setup

1. In the popup header choose **Personal Profile**.
2. **Settings → Targeting**: titles (e.g. *Founder, CEO, CFO, Ecommerce Manager*), industry, location, company size,
   keywords. Titles/keywords/industry/location are put into the LinkedIn search for you; apply location, industry and
   company-size filters in LinkedIn's own filter bar.
3. **Settings → Daily activity budget**: keep the defaults (10 connection requests, 15 messages, 15 follow-ups per day)
   or go lower.
4. **Settings → Message templates**: review the starter templates and edit them to sound like you.
5. Leave **Approval mode** on the default, **Review Before Send**.

## 5. Company Page setup

1. Open the **admin view** of your Company Page in the tab you attached (you must be an admin of that page).
2. **Settings → Company Pages → Add the Page open in the attached tab**. LeadPilot refuses pages that are not in the admin
   view, so only administered Pages can be used.
3. In the popup header choose **Company Page** and pick the Page from the drop-down.

In Company Page mode LeadPilot offers **posting, local scheduling/drafts, post history and engagement tracking only**.
**Connection requests, messages and follow-ups are disabled** — a Company Page never sends personal outreach and
LeadPilot never impersonates a person. Before any Page post is published the composer's author is read; if it is not the
selected Page, nothing is posted.

## 6. Lead-search workflow

**Search → Review → Connect → Message → Follow-up → Track status**

1. **Leads → Open LinkedIn search** opens a people search built from your targeting in the attached tab. Adjust filters
   in LinkedIn as you normally would, and browse the results yourself.
2. On a people-search results page press **Collect from this page**. LeadPilot reads only the result cards that are
   **visible** there (name, headline → job title/company, location, connection degree, profile URL). It does not scroll,
   page through results, or open profiles to collect.
3. Leads are de-duplicated by **normalised profile URL** (`https://www.linkedin.com/in/<slug>/`, lower-cased for comparison,
   no query string). The profile URL that is opened (and exported) keeps the slug's **original case**, because LinkedIn's opaque
   ids (`ACoAA…`) are case-sensitive. "LinkedIn Member" (hidden-name) cards are skipped.
4. Review them in the **Leads** tab: filter, tick the ones you want, edit any field, add notes, mark
   *Replied / Do Not Contact / Converted*, or **Pause** a lead.
5. Industry is not visible on result cards; it is pre-filled from your *Target industry* setting and is editable.
6. Search results never contain e-mail addresses, so the **Email** field starts empty. You can type one yourself, or fill
   it in bulk from LinkedIn's own data export — see *E-mail addresses (optional)* below.

## 7. Connection workflow (Personal Profile, with your confirmation)

1. Dashboard → **Run**: Action = *Connection requests*, pick a template, choose *All eligible* or *Selected leads*,
   press **Start**. (Or press **Review & connect…** on a lead row.)
2. LeadPilot opens the lead's profile in the attached tab, reads the visible profile (name, headline, company,
   location, connection state) and refreshes the lead.
3. If you are already connected, or an invitation is pending, the lead is skipped and its status corrected.
4. Otherwise the **review card** appears: the lead, the **personalised draft** (`{{firstName}}`, `{{lastName}}`,
   `{{company}}`, `{{jobTitle}}`, plus `{{location}}`, `{{industry}}`), warnings, and an editable text box. Notes are
   limited to 300 characters; an empty note means "send without a note".
5. **You click Send.** Only then does LeadPilot click *Connect → Add a note → Send* in the visible LinkedIn dialog.
6. The lead becomes *Pending*, **Day 0** is recorded and the first follow-up is scheduled. LeadPilot waits the cooldown
   before it prepares the next lead.

Variables that cannot be filled are left visible as `{{company}}` and **Send stays disabled** until you fix the text.
Templates are never sent identically "blind": the Settings preview and the review card both show the final text, and
Conservative Auto Mode requires every template to contain a lead-specific variable.

## 8. Messaging workflow (existing connections only)

1. Action = *Message new connections*. Eligible leads are **1st-degree connections who have not been messaged yet**.
2. LeadPilot opens the profile, clicks the visible **Message** button and checks that the message box that opened is
   headed with **that person's name** — it will not type into someone else's conversation.
3. It reads the visible thread: if the person has already **replied**, the lead is marked *Replied* and skipped.
4. You review/edit the draft and press **Send**; LeadPilot types it in the box and presses LinkedIn's Send button.

LeadPilot never sends InMail and never messages people who are not confirmed 1st-degree connections.

## 9. Follow-up workflow

**Settings → Follow-up schedule** (defaults):

| Day | Step | Template |
|---|---|---|
| 0 | Connection request (or first message) | — |
| 2 | Follow-up | *Day 2 — gentle follow-up* |
| 5 | Value message | *Day 5 — value message* |
| 10 | Final follow-up | *Day 10 — final follow-up* |

* A step becomes **due** when its day has passed. The popup shows **Follow-ups due**, the toolbar badge shows the count,
  and the Leads filter *Follow-up due* lists them.
* Run **Action = Follow-ups due**. If the connection request is still *Pending*, nothing is sent and the lead is retried
  in 2 days. If they accepted, you review and send the step's message as usual.
* **Never contacted again** if the lead: replied, asked not to be contacted (*Do Not Contact*), is *Converted*, or you
  **paused** the lead. These checks run when the queue is built and again right before each send.
* Each follow-up counts against the **follow-ups/day** budget.

## 10. Post publishing (Personal Profile and Company Page)

**Posts** tab:

1. Pick a post template (or write from scratch). Placeholders: `{{date}} {{weekday}} {{month}} {{year}} {{companyName}}`.
2. The **Preview** shows the final text and highlights unresolved placeholders (publishing is blocked until none remain).
3. **Save draft / schedule** stores it locally (optionally with a date/time).
4. **Publish now…** asks you to confirm, then LeadPilot opens LinkedIn's own *Start a post* box in the attached tab
   (feed for Personal; the Page's admin view for a Company Page), verifies the post author, types the text and presses
   **Post**. Personal posts need the LinkedIn feed; Company Page posts use the Page's admin view.
5. History is kept locally with status (*Draft / Scheduled / Published / Check on LinkedIn*).
6. **Engagement**: open the page that lists your posts (profile → Posts/Activity, or the Company Page posts) and press
   **Read engagement from this page**. Visible reaction/comment/repost counts are stored against the matching post.

**Nothing is published without your explicit click**, unless you deliberately enable **Settings → Post publishing →
publish scheduled posts automatically** (off by default; needs a second acknowledgement tick). Even then it uses the
attached tab, respects the daily post budget, and does nothing while automation is paused, restricted or running.

## 11. Daily-limit configuration

**Settings → Daily activity budget & pacing**

| Setting | Default | Hard ceiling |
|---|---|---|
| Connection requests / day | 10 | 30 |
| Messages / day | 15 | 50 |
| Follow-ups / day | 15 | 50 |
| Posts / day | 2 | 5 |
| Cooldown after each send | 90–240 s | minimum 30 s |
| Gap between profile views | 20 s | minimum 10 s |

* Budgets reset at local midnight and count every send attempt, including ones LinkedIn did not visibly confirm.
* The ceilings are enforced in the service worker; values above them are clamped back.
* The random part of the cooldown is ordinary UX pacing so you can follow what is happening — it is **not** a way to
  avoid detection and it never lets the daily budget be exceeded.
* **Conservative Auto Mode** (off by default; Settings → Approval mode) skips the manual click for fully-personalised
  drafts, but only within the daily budget, at most **N sends per run** (default 5), only when every variable is filled,
  and it falls back to manual review for any lead with incomplete data. It stops instantly on any LinkedIn warning.

## 12. Activity logs

Dashboard → **Activity log** lists, with time and result, everything attempted: each *Attempting …* line (with the exact
text), the outcome, skipped leads and why, collections, exports, pauses/stops and every warning. Tick **problems only**
to filter. The log keeps the last 1,000 entries locally; clear it under Settings → Data.

## 13. CSV export

**Leads → Export CSV**: tick exactly the fields you want, choose *All / Currently filtered / Selected*, press
**Download CSV**. Available fields (14): First Name, Last Name, **Email**, Profile URL, Job Title, Company, Location,
Industry, Connection Status, Message Status, Last Contacted, Next Follow-up, Source, Notes.

* RFC 4180: CRLF line endings, fields containing commas, quotes or line breaks are double-quoted, quotes doubled.
* UTF-8 with a BOM so Excel opens accents correctly.
* Columns appear in the order above, with exactly the selected fields. (If you saved a field selection before the Email
  column existed, Email is added to it once so it does not silently go missing from your exports; you can untick it.)
* By default cells that begin with `=`, `+`, `-` or `@` get a leading `'` so spreadsheet software cannot execute
  scraped text as a formula. Untick the option to export raw values.

## 14. Security / challenge handling

LeadPilot looks for problems **before and after every action** and also watches the open LinkedIn tab:

| What LinkedIn shows | LeadPilot state | What you do |
|---|---|---|
| Sign-in page / expired session | **Paused** — *Login required* | Sign in, press Resume. |
| CAPTCHA, security check, verification request | **Paused** — *CAPTCHA / security challenge* | Resolve it yourself in LinkedIn. LeadPilot never touches it. Press Resume (it re-checks first). |
| Weekly/monthly invitation limit, "unusual activity", temporary limitation | **Paused** — *Rate / activity warning* | Stop for the day, lower your limits, resume only when the notice is gone. |
| "Your account has been restricted" | **Restricted** — everything locked | Resolve with LinkedIn. Only then use **Clear restriction flag** (asks for confirmation). |
| An element LinkedIn changed | **Error** — *Missing selector / LinkedIn page changed* | The affected action/element is named; nothing is retried. See section 16. |
| Page never finished loading | **Error** — *Navigation timeout* | A slow page is a timeout, **never labelled CAPTCHA**. |
| You pressed Stop | **Idle** — *User stopped automation* | — |

Other classified errors: *LinkedIn page not reachable* (reload the tab), *Unsupported LinkedIn page*, *Recipient /
identity could not be verified*, *Interrupted (extension restarted)*.

The **❚❚ Pause Automation** button is always visible (it sticks to the top of the popup) and the toolbar badge shows the
state (`ON`, `II`, `?` = waiting for you, `ERR`, `X`). Warning text is only matched inside dialogs/toasts/alerts or
challenge URLs, so ordinary feed posts that mention the word "captcha" cannot trigger it. A generic phrase such as "try again later"
only counts together with a limit-type word, and a hidden or tiny reCAPTCHA badge is not treated as a challenge — only a visible,
challenge-sized widget is.

**Service-worker restarts:** state is persisted. If Chrome restarts the worker *while a send was in flight*, LeadPilot
marks the run **Interrupted** and does **not** retry (it cannot know whether LinkedIn received the action) — check
LinkedIn, then start again. If it restarts while only reading a profile, the lead is simply re-queued.

## 15. What the extension does NOT automate

* No CAPTCHA/verification solving or bypass, no login, no 2FA.
* No hiding of automation: no user-agent or fingerprint changes, no proxies, no IP/account/browser-identity rotation, no
  cookie handling, no request spoofing.
* No private/undocumented LinkedIn APIs and **no network requests of its own** — it only reads/clicks the page DOM.
* No hidden tabs/windows, no background crawling, no auto-scrolling or auto-paging of search results.
* No scraping of anything not visibly on the page: it never opens **Contact info**, never reads e-mail addresses or phone
  numbers from LinkedIn pages, and never looks at content behind access controls. E-mail addresses reach the lead list only
  because **you** type them or **you** import LinkedIn's own Connections.csv (see *E-mail addresses (optional)*).
* No messages to non-connections, no InMail, no group/event invitations, no "withdraw invitation", no profile views for
  the sake of views, no likes/comments/endorsements.
* No personal outreach from a Company Page; no posting without your click (except scheduled posts you deliberately
  authorised).
* No evasion of rate limits: it stops at warnings and enforces its own hard ceilings.
* No data leaves your browser: everything is in `chrome.storage.local`.

## 16. When LinkedIn changes its markup

LinkedIn changes its page markup often. LeadPilot is built so that a change produces a **named, graceful stop** rather
than silent misbehaviour: every selector in `content.js` sits in a layered finder (1 semantic/ARIA → 2 data attributes →
3 stable LinkedIn attributes → 4 narrow CSS fallbacks), each carries `// SELECTOR:` and `// ASSUMPTION:` comments, and
each card/profile/action runs in its own `try/catch`. When nothing matches you get an **Error — Missing selector** whose
*Affected element* tells you which function to update.

**Debugging:** open DevTools on the LinkedIn tab → Console → choose the **"LeadPilot LinkedIn"** execution context from the
context drop-down, then run the read-only helpers, e.g. `__leadPilotContent.findResultCards()` or
`__leadPilotContent.detectSecurityState()`. They never click or type.

All of these are in **`content.js`**:

| What broke | Function(s) to update |
|---|---|
| **Profile / card discovery** (no cards found on a search page; profile top card not found) | `findResultCards()` and the strategy list `resultCardLayers()` (helpers `resolveCards`, `cardsBySiblingBlocks`, `cardsFromAnchors`), `profileTopCard()`, `profileH1()` |
| **Name extraction** | `extractName(card, profileUrl)` for search cards, `extractProfileName()` for profile pages (the name element is found by `profileH1()`: `<h1>`, then heading roles, then the element whose text equals the name in the tab title), `cleanName()` |
| **Company extraction** | `extractCompany(card, name)` for search cards, `extractProfileCompany(top, headline)` for profile pages, `splitHeadline()` |
| **Job-title extraction** | `extractJobTitle(card, name)` (via `cardHeadline()`), `extractProfileHeadline()` / `extractProfileJobTitle()`, `splitHeadline()` |
| **Profile URL extraction** | `extractProfileUrl(card)`; URL normalisation lives in `normalizeProfileUrl()` (content.js) **and** the identical copy in `background.js` — change both |
| **Connection button detection** | `findConnectButton()`, `collectProfileActions()`, `classifyAction()`, `findConnectInMoreMenu()`, `profileConnectionState()`, `extractDegree()`; invitation dialog: `findInviteDialog()` / `dialogButton()` and the textarea layers inside `executeConnect()` |
| **Message composer detection** | `findMessageButton()`, `findMessageComposer()`, `composerContainer()`, `conversationTitle()`, `openComposerFor()`, `inspectThread()` (reply detection), `setEditableText()` |
| **Send button detection** | `findMessageSendButton()` (messages), `findPostSubmitButton()` (posts), and the `sendRe`/`dialogButton` match for the invitation *Send* inside `executeConnect()` |
| **Post composer detection** | `findPostTrigger()`, `openCompanyCreateMenu()`, `findPostComposer()`, `readComposerIdentity()` |
| **Company Page detection** | `detectCompanyPage()` |
| **CAPTCHA / security-warning detection** | `detectSecurityState()`, its `PATTERNS` table and `alertContainers()` |

Also in this group, for engagement tracking: `findPostCards()` and `collectEngagement()`.

**Workflow for a fix:** reproduce on the page → run the matching helper in DevTools to see which layer fails → add a new
layer *above* the broken one (keep the old ones as fallbacks) with its own `// SELECTOR:` / `// ASSUMPTION:` comments →
reload the extension and the tab → test with a single lead in Review Before Send mode.

If a LinkedIn UI language other than English is used, the text-matched labels (`Connect`, `Message`, `Add a note`,
`Send`, `Post`, `Start a post`, …) in `classifyAction()`, `dialogButton()` calls and the finders need translating.

---

## E-mail addresses (optional)

LinkedIn does **not** show e-mail addresses on search results, and LeadPilot deliberately does not go looking for them
(no opening of *Contact info*, no reading of hidden fields, no guessing of addresses). There are two legitimate ways
to get an address into a lead:

1. **Type it yourself** — in the lead editor (**Edit** on a lead row) or in *Add a lead manually*. It is checked, trimmed and stored in lower
   case; an entry that does not look like an address (for example `nope`, or one starting with `=`, `+` or `-`) is rejected.
2. **Import LinkedIn's own export of your connections** (recommended for bulk):
   1. On LinkedIn: **Me → Settings & Privacy → Data privacy → Get a copy of your data**, tick **Connections**, press
      **Request archive**. LinkedIn e-mails you a link (usually within minutes for Connections only; the complete archive can
      take up to a day). Download and unzip it. The file you need is **`Connections.csv`**.
   2. In LeadPilot: **Leads → Import emails from LinkedIn's connections export**, choose `Connections.csv`
      (or paste its content), optionally tick *Also add connections that are not in my lead list yet*, press **Import**.
   3. On **Windows**, Chrome closes an extension popup while the file picker is open. If that happens, press **↗** at the top of
      the popup — LeadPilot opens in a normal browser tab where the picker works — or use the paste box instead.

Once a lead has an address, the CSV export carries it in the **Email** column (right after *Last Name*).

How the import behaves:

* It reads the file **inside your browser**; nothing is uploaded and nothing is requested from LinkedIn.
* A lead is matched by **normalised profile URL**. If that fails (leads collected from search results sometimes carry an
  opaque `ACoAA…` URL while the export has the vanity URL) it falls back to **exact first name + last name + the same
  company**, and only when **exactly one** of your leads fits. It never matches by name alone, because mailing the wrong
  person is worse than missing an address.
* An address is filled in **only where the lead has none**. If you already have a different address for that lead, yours is
  kept and the row is counted under *kept their existing email*. Re-importing the same file changes nothing.
* Matched leads are marked **Connected** (the export only contains your connections). Connections that are not in your lead
  list are added only if you tick the option; they are labelled with the source *LinkedIn export <date>*.
* The file only contains an address for connections who **allowed their connections to see it**, so many rows are blank.
  That is expected — it is LinkedIn's privacy setting, not a fault. The result line counts them as *without a shared email*.
* Addresses never appear in the activity log; only counts do.

The **Leads** filter has *Has email* / *No email*, and each lead row shows `✉ address` when there is one.

**Using addresses responsibly.** Having an address is not permission to send marketing e-mail. Use it only in line with the
person's consent and the law that applies to you (for example GDPR/PECR in the EU and UK, CAN-SPAM in the US, India's DPDP
Act), identify yourself, and always give an easy way to opt out. LeadPilot never sends e-mail — it only stores addresses
and exports them with the rest of your lead data. This is general guidance, not legal advice.

---

## Diagnostics (when something does not work)

Settings → **Diagnostics** (or the **Copy diagnostics** button in a red / yellow banner, or on the *Getting started* card):

1. Open the LinkedIn page where it fails (for example a people-search results page) in the attached tab.
2. Press **Run diagnostics**, then **Copy report**, and paste the report to whoever maintains the extension.

The report contains the extension version and state, the browser version, what the content script found on the page (how many result cards each discovery strategy sees, which buttons were recognised on a profile, whether a warning was detected) and the last 20 log lines. It deliberately describes only the **structure** of the page: every text, label, alt text and link is replaced by a length or a placeholder, lead names in the log are replaced by `[lead]`, and message bodies are cut. Only generic UI words such as "Connect", "Message" or "2nd" stay readable. When a run stops because of what a page looked like (*Navigation timeout*, *Missing selector*, *LinkedIn page changed*, *Recipient could not be verified*), a snapshot of that page's structure is saved at that moment and included in the next report as `lastFailure` — so it is still there even if you have moved the tab elsewhere before copying the report. The last report is kept in `chrome.storage.local` (`lp_diag`, snapshot in `lp_failure`).

Developers can run the same checks from DevTools: choose the **"LeadPilot LinkedIn"** execution context and call `__leadPilotContent.diagnose()`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Chrome: "Manifest file is missing or unreadable" | You selected the wrong folder. Select the one that directly contains `manifest.json`. |
| Popup says no tab attached | Open linkedin.com, click the extension, press **Attach this tab**. |
| Collect from this page finds nothing | You are not on a people-search results page, the page is still loading, or LinkedIn changed its markup. Run **Diagnostics** (see above). |
| Start is greyed out | Company Page mode is selected, a restriction flag is set, or a run is already active. |
| "Daily limit reached" | Today's budget is used; change it in Settings (hard ceilings apply) or wait until tomorrow. |
| "No eligible leads" | Leads already contacted, replied, paused, converted, or *Do Not Contact*. |
| A step stopped with *Missing selector* | LinkedIn changed markup — see section 16. |
| Draft shows `{{company}}` | That lead has no company. Edit the lead or the text; Send stays disabled until fixed. |
| The popup closes when I choose `Connections.csv` (Windows) | Chrome closes extension popups while the file picker is open. Press **↗** at the top to open LeadPilot in a tab, or paste the file's content into the box instead. |
| Import says there is no header row / no "Email Address" column | You chose a different file. Use `Connections.csv` from LinkedIn's *Get a copy of your data → Connections*; keep the header line (`First Name,Last Name,URL,Email Address,…`). |
| Import added very few emails | LinkedIn only includes an address for connections who allow their connections to see it. Blank rows are normal; the result line shows how many. Leads with an opaque `ACoAA…` URL are matched by exact name + company, so a lead with no company can only be matched by URL. |

## Data

Everything lives in `chrome.storage.local` under the keys `lp_settings`, `lp_leads`, `lp_log`, `lp_job`, `lp_counters`,
`lp_posts`, `lp_tab`, `lp_diag` (last diagnostics report) and `lp_failure` (structure snapshot of the last failing page).
Remove the extension (or use Settings → Data) to delete it. Nothing is transmitted anywhere. Lead records hold 14 fields,
including the optional e-mail address.

## Version history

| Version | Changes |
|---|---|
| 1.1.0 | **Email** field on leads (validated, editable, filterable via *Has email / No email*), **Import emails from LinkedIn's Connections.csv**, Email column in the CSV export, *Open in a tab* button for the Windows file-picker problem. |
| 1.0.2 | Profile pages open reliably on the real site: case-preserving profile URLs (opaque `ACoAA…` ids), multi-layer name detection, "page not available" detection, page facts in errors, `lastFailure` snapshot in diagnostics. |
| 1.0.1 | Diagnostics report, *Getting started* card, sturdier card discovery, clearer error hints. |
| 1.0.0 | First release. |
