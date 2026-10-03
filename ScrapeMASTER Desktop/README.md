# ScrapeMASTER Desktop

The Windows desktop version of the ScrapeMASTER Chrome extension (`../ScrapeMASTER`). Same job: search many keywords across India (state → city → pincode), collect **Name, Phone (real mobile or "Not found"), Email** from Google's Local Finder, de-duplicate everything, export one CSV. The extension stays as it is; this app is built on the same scraping, email and drill-down logic.

## Install / run

- **Installer:** `dist\ScrapeMASTER Setup 1.0.0.exe` (≈111 MB). It is not code-signed, so Windows SmartScreen may warn: *More info → Run anyway*.
- **From source:** `npm install`, then `npm start`.
- **Rebuild the installer:** `npm run dist` (runs `npm run sync` first).
- **Tests:** `npm test` (engine, plain Node) and `npm run smoke` (real Chromium + a mock Google: scraping, drill-down, CAPTCHA auto-resume, UI load).

## How it differs from the extension

| | Extension | Desktop |
|---|---|---|
| Browser | your own Chrome (your Google login, fewest CAPTCHAs) | built-in Chromium pane on the right, own saved profile |
| Email lookup | needs the "website access" permission prompt | no prompt, no CORS limits, 6 sites at a time |
| Saving | session storage, lost when the browser restarts | every run is saved to disk; **Previous runs** lets you reopen, **Continue**, export or delete it |
| CSV | downloads folder | auto-saved to `Documents\ScrapeMASTER Leads`, plus **Export CSV** anywhere |
| CAPTCHA | solve it in the tab, click Resume | solve it in the pane; **the run resumes by itself** |

## Using it

Layout: run buttons on top, then the extraction options left to right (keywords, where, data source, number of businesses and speed, emails + Start), a progress strip, and the live data table filling the rest. **Choose states / cities / pincodes** opens a three-column picker (States | Cities | Areas).

1. Keywords (one per line) → **Where**: type places, **Pick India**, or load a **Task file**; pick **Google list** or **Google Maps** as the data source. For India: **Pick from India** (States → Cities/districts → Areas/pincodes; the deepest ticked level per branch is searched, and a "full" search is split into smaller areas automatically).
2. Choose the lead target, **Speed** (Safe is the default), optionally **Find emails**, then **Start Scraping**.
3. The **Extracted data** table at the bottom fills live as businesses are found (newest first, with a filter box); emails and extra phone numbers appear in it as the website lookups finish, which happens alongside the searching. The Google page itself is hidden. It pops up by itself when Google shows a CAPTCHA or consent page, and closes again once you have solved it and the run carries on; **Show Google** opens it any time. The page keeps its own cookies; **Sign in to Google** can reduce how often checks appear (Google sometimes refuses sign-in inside embedded browsers).
4. **Stop** keeps everything. **Continue** (also from **Previous runs → Open**) resumes the saved queue, even after closing the app.

All the rules about the 60-result cap, drill-down thresholds, pacing profiles, de-duplication, CSV format and email finding are the same as the extension; see `../ScrapeMASTER/README.md`. A run is a queue of "keyword in place" searches; the pacing numbers live in `PROFILES` in `engine/engine.js`.

## Layout

```
main.js            Electron main process: window, Google pane (WebContentsView), IPC
preload.js         the only bridge to the UI (fixed list of commands)
driver.js          drives the Google pane: load a URL, run the page scraper, report navigation
engine/engine.js   queue engine: drill-down, pacing, blocks, dedupe, CSV, email phase
engine/store.js    saves runs to %APPDATA%\ScrapeMASTER\runs (atomic, debounced)
engine/emails.js   GENERATED from the extension's background.js
scraper/page-scraper.js   GENERATED from the extension's content.js
geo-data.js        GENERATED copy of the extension's pincode data
renderer/          the UI (app.js derived from the extension popup; popup.css is a synced copy)
test/              unit.js (Node) and smoke.js (Electron + mock Google)
```

**Keeping one source of truth:** the page scraper, the email finder, the pincode data and the stylesheet are copied from `../ScrapeMASTER` by `npm run sync`. Fix a Google markup change once in the extension (`content.js`), run `npm run sync`, rebuild. The queue engine itself exists twice (extension `background.js`, desktop `engine/engine.js`); a change to the search logic has to be made in both.

## CSV columns

**Columns… (button above the live table)** picks what the table shows and the CSV exports; the choice is remembered and can be changed after a run too. 19 fields are available; the first 8 are ticked by default:

| Default | Optional |
|---|---|
| Name, Phone, Email, Website, Address, City, State, Pincode | Category, Rating, Reviews, Hours (today), Latitude, Longitude, Google Maps link, Facebook, Instagram, LinkedIn, Twitter / X |

Address is what Google lists; City, State and Pincode are read from it (blank if the address has none); Website is the business's own site without tracking parameters. Category, Rating, Reviews, Hours, coordinates and the Maps link come from Google's page data (checked live: 10 of 10 filled); the social links come from the business's website, so they are only present when the site links to them (typically 1 in 4 or 5).

**Location quick-pick:** the places dialog also has State / City / Pincode dropdowns with an Add button, in addition to the three tick-lists.

## Phone numbers, emails and the website lookup

The **Phone** column holds the **best number found**, always without spaces and with its country code: a mobile if there is one (India `+91XXXXXXXXXX`, UAE `+9715XXXXXXXX`), otherwise the landline (`+912226395533`, `+97143354041`). **Not found** appears only when no number exists at all. Optional columns **Phone type** (Mobile / Landline) and **Other phone** (the number that was displaced, e.g. the Google landline when a mobile was found on the website) are in the Columns chooser.

Because almost every business has a website, **Find emails & phone numbers** visits it (home page, contact / about pages, sitemap) for *every* business that has one and reads the email, WhatsApp (`wa.me`) and `tel:` links, and numbers written next to words like Tel / Phone / Call. A mobile found there replaces a landline from Google. Live check, "dentist" in Dubai, 12 places: Google alone gave 2 mobiles; with the website lookup 11 of 12 had a mobile, and 9 had an email. Numbers read from a website are less certain than Google's own (a site can list a manager's or agency's number), so spot-check them before a big mailing.

## Data sources

| | **Google list** (default) | **Google Maps** |
|---|---|---|
| Speed | ~20 businesses per page load; Google hidden | opens every place (~2 s each) |
| Fields | name, address, phone, website, category, rating, reviews, hours (today), coordinates | the same, plus full weekly hours, and the phone is read from the place page itself |
| Screen | the Google page stays hidden until it shows a CAPTCHA | a small live Google panel stays visible on the right: Maps stops rendering if it is hidden or covered (checked) |
| Places per search | Google caps a search at ~60 | **Places per search** 20 / 50 / 100 / Max (~120 is Maps' own limit) |

For Maps the app scrolls the results list to collect the place links, then opens each place by its own URL (clicking a card with a script does not work on Maps, and closing the panel again is unreliable). A search that comes back full is split into districts / pincodes exactly like the list source. Maps showed no CAPTCHA in the live tests (a few dozen page loads); that says nothing about large volumes.

## Task files (.tsk) and other countries

**Task file** (third option under *Where*) loads a `.tsk` file: one search per line, `id|category|location|country|state|city|zip-or-limit`, e.g. `1|ecommerce||United Arab Emirates|Dubayy|Dubai|1000`. Each line carries its own keyword, so the keywords box is not used. Accents are folded (`Ra’s al Khaymah` → `Ras al Khaymah`), the search text becomes `city, country`, and the line's country / state / city fill the City / State / Country columns when the address doesn't say. The last field is read as a postal code if it has 5-6 digits (India), otherwise as a maximum number of results for that line (inferred from the sample file: every UAE line ends in `1000`).

For the UAE without a file, **Type place** has a *+ fill the UAE emirates* link. The India pincode lists only cover India; other countries are searched by typed places or task files. UAE numbers (`+971 5x`, `05x…`) are recognised as mobiles; `04…` and `800…` numbers are landlines.

## Developer tools

`npx electron . --real --kw="dentist" --place="Mumbai" --target=12 --emails` runs a small live run in a visible window and prints the result. `--diag`, `--diag2`, `--diag3` dump what the live Google page looks like (cards, click panel, data blob); use them first when Google's markup seems to have changed.

## Limits to know

- A fresh Chromium profile is looked at more suspiciously by Google than your everyday Chrome. If you get many CAPTCHAs, use Safe speed, sign in to Google in the pane, and keep runs moderate.
- Runs are stored as JSON files, not a database; tens of thousands of leads are fine, millions are not.
- No scheduler / daily cap yet.
- The installer uses the default Electron icon and is unsigned.
