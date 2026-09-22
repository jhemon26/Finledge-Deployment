# readit.md — Finledge, A to Z

**Audience: an AI agent picking this project up cold.** Read this fully before touching anything.
It exists so you don't have to re-derive the architecture, and so you don't break a live app while doing it.

Last updated: **2026-08-19**, after the write-window / month-bar work described in [§10](#10-what-was-done-in-this-session-2026-08-19).

---

## 1. The one thing that will bite you first

**There are two copies of this app on disk, and a copy is not a deploy.**

| Path | Role | Served to users? |
|---|---|---|
| `/opt/finledge-deployment/` | dev / staging — **a git repo**, branch `main` | **no** |
| `/var/www/spending-app/` | **production** | **yes** — pm2 process `finledge`, port 3005 |

> Superseded on 2026-08-19: this section used to say there was no git repo and that dev lived at
> `/opt/finledge/`. Both are now wrong — `/opt/finledge/` no longer exists.

Editing the staging tree changes nothing for users. Deploying is a **manual file copy** (see [§8](#8-deploy-procedure)).

**The invariant that makes this safe: `HEAD` in the staging repo is kept byte-identical to production.**
So `git diff` in `/opt/finledge-deployment` is a truthful preview of exactly what prod would receive, and
`git status` being clean means prod and staging agree. Commit right after each deploy to keep it true.
Verify rather than trust it:

```bash
for f in backend/server.js frontend/app.js frontend/index.html frontend/styles.css; do
  git show HEAD:$f | diff -q - /var/www/spending-app/$f
done
```

Git history is a real fallback now, but it does **not** cover the database — so still
**back up prod before overwriting it**.

Also: the app is live with real users. Treat every prod write as irreversible.

---

## 2. What the app is

Finledge is a **self-hosted, room-based monthly spending tracker**. A small group (flatmates, family, a couple) shares a *room*; everyone logs what they spent; the app totals it, charts it, and works out who owes who.

- **Room** = the shared ledger. Identified by a code like `FIN-1133`, protected by a room password.
- **Member** = a person in the room, identified by name + 4-digit PIN. One member is the **host**.
- **Expense** = one spend: description, amount, category, date, optional place. Always attributed to the signed-in member who created it.
- Everything is scoped to **one calendar month at a time** (see [§9](#9-what-was-done-in-this-session-2026-08-17)).

Currency is **GBP**, hardcoded (`£`) in both `money()` helpers (backend `server.js`, frontend `app.js`).

---

## 3. Stack and file map

Plain Node + vanilla browser JS. **No build step, no framework, no bundler, no test suite.** Editing a file *is* deploying it (after the copy).

```
backend/
  server.js            ~900 lines — the entire API, WebSocket hub, and static file server
  db.js                ~95 lines — SQLite schema, opened WAL, idempotent migrations
  ecosystem.config.js  pm2 config (name/port/DB_PATH)
  package.json         express, better-sqlite3, bcryptjs, ws, cors
frontend/
  index.html           ~700 lines — all markup + every SVG <symbol> in one inline sprite
  app.js               ~1880 lines — one IIFE, a single `state` object, no framework
  styles.css           ~835 lines — design tokens at the top, then components
  manifest.json, icon-192.svg, icon-512.svg   — PWA bits
```

**`server.js` serves the frontend itself** (`express.static('../frontend')` + a catch-all that returns `index.html`). There is no nginx-level split to worry about; the SPA fallback regex `^(?!\/api\/|\/ws).*` deliberately excludes the API and the socket.

---

## 4. Data model (`backend/db.js`)

SQLite, WAL mode, `foreign_keys = ON`. Tables:

| Table | Notes |
|---|---|
| `rooms` | `id` TEXT PK (`FIN-####`), `name`, `password_hash` (bcrypt), `created_at` |
| `members` | `room_id`, `name`, `pin_hash` (bcrypt), `is_host`, `avatar`, `last_seen_at`. `UNIQUE(room_id, name COLLATE NOCASE)` |
| `sessions` | `token` PK (32 random bytes hex) → `member_id`, `room_id`. **Never expire.** |
| `expenses` | `room_id`, `member_id`, `description`, `amount` REAL, `category` TEXT, `date` TEXT `YYYY-MM-DD`, `location`, `created_at`, `updated_at` |
| `activity_logs` | append-only human-readable audit line per action |
| `categories` | **per-room**, host-editable: `group_name`, `name`, `icon`, `color`, `sort_order` |

### Things to know about the schema

- **`expenses.category` stores the category *name* as text, not a foreign key.** Renaming a category rewrites matching expense rows (`server.js`, in `PUT /api/categories/:id`) so history stays consistent. Deleting a category leaves old expenses labelled with the dead name — that is intentional.
- **`expenses.date` is a plain `YYYY-MM-DD` string.** All month logic is `substr(date,1,7)` string comparison. This sorts and compares correctly and is the single reason the month feature is cheap. Don't switch it to a timestamp.
- Migrations are **idempotent `ALTER TABLE` in a try/catch** that swallows only `duplicate column` (see bottom of `db.js`). Add new columns the same way — the prod DB is never rebuilt.
- New categories are **seeded per room** from `DEFAULT_CATEGORIES`, and there is a **backfill at boot** for any room with no categories. Safe to re-run.
- **Nothing is ever deleted by a background job.** No cron, no purge, no retention sweep. Rows die only when a user deletes them.

---

## 5. API surface (all under `/api`, JSON)

Auth is `Authorization: Bearer <token>` (or `?token=` for the WebSocket). `authenticate` middleware attaches `req.member`, `req.roomId`, and bumps `last_seen_at`. `requireHost` gates host-only routes.

| Method | Route | Notes |
|---|---|---|
| POST | `/rooms/create` | creates room + host + session, seeds categories |
| POST | `/rooms/join` | joins existing room, or re-auths an existing member by PIN |
| GET | `/session` | who am I |
| POST | `/session/logout` | deletes the session row |
| GET | `/room` | room info + `totalLifetimeSpend` (**all-time, deliberately not month-scoped**) |
| GET | `/members` | everyone in the room |
| PATCH | `/member/avatar` | change own avatar |
| GET | `/meta` | avatar keys, icon library, colour keys (**unauthenticated**) |
| GET/POST/PUT/DELETE | `/categories[/:id]` | read for all; write is **host only** |
| GET | `/expenses` | filters: `month`, `category`, `memberId`, `q` |
| POST/PUT/DELETE | `/expenses[/:id]` | see rules below |
| GET | `/activity` | last N log lines (`limit`, max 200) |
| GET | `/analytics` | **the big one — takes `?month=YYYY-MM`.** See [§9](#9-what-was-done-in-this-session-2026-08-17) |

### Invariants you must not break

- **Who paid is never taken from the client.** `POST /expenses` sets `member_id = req.member.id`, and `PUT /expenses/:id` explicitly preserves `existing.member_id`. This is what makes the activity log trustworthy. Do not add a `paidBy` field to the request body.
- **The room password is never returned.** `GET /api/room` returns `password: null` on purpose — only the bcrypt hash exists server-side. The frontend shows the password from a *client-side cache* of what the user typed at login (`state._cachedRoomPassword`), which is why a member who joined on another device sees "Ask your host".
- Every write **broadcasts over the WebSocket** and **writes an activity log line**. Keep both when adding a mutation.
- All SQL is **parameterised prepared statements**. Keep it that way.

### WebSocket

`/ws?token=…`. Server keeps `roomSockets: Map<roomId, Set<ws>>` and `broadcast(roomId, payload)` fans out. Message types: `expense_added`, `expense_updated`, `expense_deleted`, `member_joined`, `member_updated`, `categories_changed`. The client reconnects after 2.5s on close.

---

## 6. Frontend architecture (`frontend/app.js`)

One IIFE. No modules, no framework. The whole app is:

- **`state`** — a single mutable object: `token, room, member, members, categories, expenses, activity, analytics, activeMonth, availableMonths, isCurrentMonth, filters, ws, editing*`.
- **`api(path, opts)`** — thin `fetch` wrapper, injects the bearer token, throws on non-2xx with the server's `error` string.
- **`refreshX()` → `renderX()`** — that is the entire data flow. There is no reactivity: after mutating state you must call the matching render, and after a server change you call the matching refresh. Renders are full `innerHTML` rewrites of their container, then event listeners are re-attached.
- **Bootstrap order matters:** `DOMContentLoaded` → `init*()` (binds every listener once) → `loadMeta()` → `boot()` → (if a cached token validates) `enterApp()`.

`enterApp()` does: set `state.activeMonth` to the current UTC month → `refreshCategories()` → parallel `refreshMembers/Expenses/Activity/Analytics/Room` → build grids → `connectWs()`.

**Beware: every `init*()` binds listeners exactly once, on DOMContentLoaded.** If you ever cause that to run twice, every click fires twice. (I hit exactly this in a jsdom harness — see [§10](#10-how-to-test-without-touching-production).)

### Rendering conventions

- `escapeHtml()` for anything user-typed going into HTML; `svgEsc()` for SVG text nodes. **Use them** — descriptions, place names and category names are all free text.
- `avatarHtml(key, sizeClass)` and `catIconHtml(name, wrapClass)` build the tinted glyph spans. Icons are `<use href="#id">` into the sprite in `index.html` — **any new icon id must have a matching `<symbol>` there**, and `CATEGORY_ICON_LIBRARY` in `server.js` must list it or the API will reject it.
- Charts are **hand-written SVG strings** (`sparklineSvg`, `renderTrendChart`, `renderDailyChart`, `rankListHtml`). No chart library. `attachChartHover()` binds pointer events for the tooltip because touch does not have `:hover`.
- `switchView('analytics')` **re-renders analytics on every switch** — charts size off their container, which has no width while `display:none`.

---

## 7. Design system — do not drift from it

The user's standing instruction is: **do not change the structure, look, or theme.** The rules the existing code follows:

- **Tokens live at the top of `styles.css`** (`--bg, --bg2, --ink, --soft, --dim, --faint, --rule, --acc, --acc2, --warm, --panel, --r, --r-sm, --r-lg`). It is a dark theme with a violet bias — `--bg: #1b1b25`, never pure black. **Use tokens, never raw hex.**
- **One ink colour at descending alphas** carries hierarchy. Three chalk accents, used sparingly and small.
- **A tint is never a fill.** `.tint-<key>` sets a glyph colour + a 9% wash + a 26% rule. The twelve colour keys (`sunset, ocean, berry, mint, grape, citrus, coral, indigo, rose, teal, amber, violet`) are stored in the DB (`categories.color`, and the first half of `members.avatar`), so the vocabulary is fixed — **appending is safe, renaming needs a migration.**
- **Charts encode magnitude in a single hue.** Identity is carried by the tinted glyph and the text label, never by fill colour — a twelve-step chalk palette is indistinguishable under colour-vision deficiency. Don't "improve" a chart by colouring series.
- Reuse the existing component classes (`.panel`, `.panel-head`, `.panel-title`, `.panel-note`, `.panel-hint`, `.icon-btn`, `.icon-btn-sm`, `.rank-row`, `.stat-tile`, `.chart-*`) rather than inventing parallel ones.
- `.view` is a flex column with `gap: 14px` — a new top-level panel spaces itself, don't add margins.
- Layout is **mobile-first**, `.views` capped at `max-width: 560px`. Safe-area insets are already handled.

---

## 8. Deploy procedure

```bash
# 1. Diff first — config files may legitimately differ, verify don't assume
for f in backend/server.js backend/db.js backend/package.json \
         backend/ecosystem.config.js frontend/app.js frontend/index.html \
         frontend/styles.css frontend/manifest.json; do
  diff -q /opt/finledge-deployment/$f /var/www/spending-app/$f
done

# 2. Back up prod (convention: timestamped dir inside /opt/finledge-deployment).
#    Copy the DB through sqlite's backup API, never with cp: the live DB runs in
#    WAL mode and its -wal file is routinely larger than the .sqlite itself.
BK=/opt/finledge-deployment/.deploy-backup-$(date +%Y%m%d%H%M%S)
mkdir -p $BK/backend $BK/frontend
cp -p /var/www/spending-app/<each-changed-file> $BK/<same-path>
node -e "const D=require('/var/www/spending-app/backend/node_modules/better-sqlite3');
new D('/var/www/spending-app/database.sqlite',{readonly:true}).backup('$BK/database.sqlite.bak')
  .then(()=>console.log('db backed up'))"

# 3. Copy staging -> prod, only the files you actually changed. Write beside the
#    target and mv, so a request can never be served a half-written file.
cp -a /opt/finledge-deployment/<file> /var/www/spending-app/<file>.new
mv -f /var/www/spending-app/<file>.new /var/www/spending-app/<file>

# 4. Restart and smoke test
pm2 restart finledge
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3005/api/meta
```

Notes:
- **`ecosystem.config.js` and `package.json` are currently identical in both trees, but `DB_PATH` inside the pm2 env points at `/var/www/spending-app/database.sqlite`.** Never copy a dev DB over prod.
- `pm2 restart finledge` is a hard restart; there is a `SIGTERM` handler that closes the server cleanly.
- Rollback = copy the backup dir's files back and restart.
- `/opt/finledge-deployment` also contains `.deploy-backup-*` dirs from past deploys — **none of these should ever be copied to prod.**
- **After a successful deploy, commit in the staging repo**, so `HEAD` tracks prod again (see §1).
- Note prod has a second, stale `/var/www/spending-app/backend/database.sqlite`. The live DB is
  `/var/www/spending-app/database.sqlite`, per `DB_PATH` in the pm2 env. Do not touch the stale one.

---

## 9. What was done in this session (2026-08-17)

### The problem

The app calculated **continuously / all-time**. `GET /api/analytics` returned lifetime `memberTotals`, lifetime `categoryTotals`, lifetime `topLocations`, and hardcoded "this month" to the real current month. The requirement: **everything separated by month**, with past months browsable as history, kept ~1.5 years, navigable back and forward like any record-keeping app.

### The core design decision

**No expense row is ever deleted, moved, or archived.**

The request was phrased as "when August ends it clears everything and saves August in history". Because expenses already carry a `date`, that behaviour is achieved by **scoping every calculation to a selected month** instead. On 1 September the app shows £0 and an empty list for September, and August is one tap back — the behaviour asked for, but nothing is destroyed, so a bug in this feature cannot cost a user their data. The 1.5 years became an **18-month browsable window**, not a purge job.

**There is no cron job and nothing to schedule. The month "rolls over" by itself** because `currentMonthKey()` starts returning a new value and no rows are dated into it yet.

### Backend (`server.js`)

New helpers above the routes:

| Helper | Purpose |
|---|---|
| `HISTORY_MONTHS = 18` | the retention window, ~1.5 years including the current month |
| `isMonthKey(ym)` | strict `YYYY-MM` validation |
| `monthToIndex` / `indexToMonth` / `addMonths` | month arithmetic via an integer month index |
| `currentMonthKey()` | `new Date().toISOString().slice(0,7)` — **UTC**, matching the rest of the date handling |
| `browsableMonths(roomId)` | the contiguous list of months this room may navigate |
| `resolveMonth(roomId, requested)` | validates `?month=` against that list, falls back to the current month |

`browsableMonths` rules, in order:
1. Start at the room's creation month.
2. Floor that at 18 months back — this stops a room opened years ago from offering a corridor of blank months.
3. **But never above the oldest month that actually contains an expense.** Retention trims *navigation*; it must never make a row someone entered unreachable.
4. End at the current month, or later if an expense is dated into the future (the date picker allows that).
5. The list is **contiguous** — quiet months are included, so stepping back never skips one.

`GET /api/analytics?month=YYYY-MM` is now scoped end to end: `memberTotals` (month-scoped via the `LEFT JOIN` condition, so members with zero spend still appear), `topSpender`, `categoryTotals`, `topLocations`, `settleUp`, and the whole `thisMonth` block. It additionally returns **`month`, `availableMonths`, `isCurrentMonth`**.

Two subtleties worth preserving:
- **`monthly` (the 6-month trend) ends at the selected month**, not at today, so stepping back through history walks the chart with you.
- **`momChange` is computed against the previous *calendar* month by its own query**, not against the previous row of `monthly`. A room with a quiet month has a gap in that array, and comparing across the gap silently reports the wrong baseline.

`GET /api/expenses` already supported `?month=` and was left alone.

### Frontend

- `state.activeMonth` / `availableMonths` / `isCurrentMonth` are the single source of truth. **The month is navigation, not a filter** — it always has a value, it is not part of `state.filters`, and "Clear filters" leaves it alone.
- A **month switcher** (`[data-month-switcher]`) renders in **two places — Home and Analytics** — from one state, so whichever you touch, the other agrees. Built from the existing `.date-nav` prev/label/next idiom, `.icon-btn-sm`, and the `#icon-chevron` symbol rotated 180° for "prev".
- `prev` is disabled at the earliest available month, `next` at the latest. Disabled buttons are dimmed and inert, never removed, so the label doesn't shift under your thumb.
- The filter panel's month input became a **jump-to shortcut** for the same state, clamped with `min`/`max` to the available window.
- Every month-dependent label is now set from `isCurrentMonth`: hero label, transaction/daily-average sublabels, the analytics stat label, the day-by-day panel title, the category note, empty states, and the settle-up copy. The live month reads exactly as it always did; history is unmistakable.
- **Saving an expense follows it into whichever month it is dated.** Saving from a history month and not seeing the result reads as the save having failed.
- Two tour steps were updated and one added for the switcher.

### Verified

Against a **copy** of the production database on a scratch port, with expenses backdated across `2026-04, 06, 07, 08` plus a future `2026-10`, deliberately leaving `2026-05` and `2026-09` empty:

- every month's analytics totals match its expense list exactly;
- stepping is one month at a time, contiguous, through the empty months;
- arrows disable correctly at both ends; both switchers stay in sync;
- `momChange` is right across a gap month (Jul→Jun `−4.7%`) and against the real previous month (Aug `+831.23%`);
- malformed / out-of-window / injection-shaped `?month=` values (`banana`, `2026-13`, `2099-12`, `2026-08' OR 1=1--`) all fall back to the current month;
- an old room with no data offers exactly 18 months; an old room holding a 2019 expense still reaches 2019;
- adding an expense from a history month jumps to the month it landed in;
- no JS errors through the whole flow.

After the five fixes above, re-verified:

- **the settle-up invariant holds in every month** — `sum(paid)` equals the month's true table total, balances net to zero, and the transactions move exactly the debt owed;
- the *opposite* cases still behave: the live month keeps its "today" bar, a genuine first month still says "first month";
- **regression check against real production data: the new code and the current production code return byte-identical output** for every user-visible field in every real room (totals, counts, averages, largest, month-on-month, top spender, member/category/place breakdowns, settle-up balances *and* transactions, trend, daily bars). All current expenses sit in the live month, so month-scoping and all-time agree today — users see no change until September begins.

### Five bugs found and fixed in the same session

A review pass after the feature landed found five defects, all confirmed by running them, all fixed:

| # | Bug | Cause | Fix |
|---|---|---|---|
| **A** | The daily chart accented the **last day of every past month** as "today" | `isToday = i+1 === tm.daysElapsed`, and the backend sets `daysElapsed = daysInMonth` for any non-current month, so the two always matched | gate on `state.isCurrentMonth` (`app.js`, `renderDailyChart`) |
| **B** | Months whose predecessor was empty were labelled **"first month"** | the `#an-delta` fallback fired on any null `momChange` | distinguish three cases: `no spending` / `first month` (only when it really is `availableMonths[0]`) / `nothing last month` |
| **C** | Empty months reported **"−100% vs last month"** on both Home and Analytics | arithmetically true, but reads as a collapse when nothing was recorded — and is meaningless for a month that hasn't happened | `momChange` is null unless `monthTotal > 0` (`server.js`) |
| **D** | **Settle-up on a past month split it across today's members** — it told people to pay for months they had not joined | the balances query joined all current members regardless of month | `HAVING substr(m.created_at,1,7) <= :month OR paid > 0` |
| **E** | Clearing the jump-to month input left it **blank and out of sync** | `goToMonth('')` early-returned before re-rendering | re-render on the no-op paths |

**D was the serious one** — it generated real payment instructions ("Emon pays arif £2.38") for April spending, when every member in that room joined in August. The `OR paid > 0` half of the fix is load-bearing: an expense can be backdated to before its author joined, and dropping a member who paid would leave balances failing to net to zero.

### Status

**Written and verified in `/opt/finledge`. NOT deployed** — writing to `/var/www/spending-app` was blocked by a permission gate and needs the user's approval. Prod backup was already taken at `/opt/finledge/.deploy-backup-20260817170639`. To finish: [§8](#8-deploy-procedure) steps 3–4 for `backend/server.js`, `frontend/app.js`, `frontend/index.html`, `frontend/styles.css`.

---

## 10. How to test without touching production

There is **no test suite**. This is the recipe that works:

```bash
# 1. Snapshot the prod DB (do NOT open the live file read-write)
node -e "const D=require('better-sqlite3');
  new D('/var/www/spending-app/database.sqlite',{readonly:true})
    .backup('/tmp/<scratch>/test.sqlite').then(()=>process.exit(0))"

# 2. Mutate the copy freely (backdate rows, seed edge-case rooms), then:
DB_PATH=/tmp/<scratch>/test.sqlite PORT=3607 HOST=127.0.0.1 node backend/server.js &

# 3. Grab any existing session token straight out of the copy
#    SELECT token FROM sessions WHERE room_id = ? LIMIT 1
# 4. Hit the API with fetch + Authorization: Bearer <token>
```

For the **UI**, `jsdom` drives the real `index.html` + `app.js`:
- load the DOM with `url` set to the test server so relative `fetch` resolves;
- seed `localStorage.finledge_session` with a token, and `finledge_tour_seen_v1 = '1'` to skip the tour;
- stub `window.WebSocket`;
- **do not dispatch `DOMContentLoaded` yourself** — jsdom fires it, and a second one double-binds every listener and makes each click step twice.

### Cleanup rules

- Kill test servers **by port**, not by name: `ss -lptn 'sport = :3607'` → `kill <pid>`.
- **Never `pkill -f "node server.js"`** — it can match the production process depending on how it was launched. (Prod currently runs as `node /var/www/spending-app/backend/server.js`, an absolute path, which is the only reason that pattern missed it.)
- Check `pm2 list` and `ps aux | grep node` at the start of a session; past sessions have left stray dev servers on odd ports.

---

## 10b. Transaction list ordering (changed 2026-08-17, deployed)

`GET /api/expenses` orders by **`e.created_at DESC, e.id DESC`** — when the expense was *entered*, not the date it happened. A backdated receipt used to sink to wherever its date fell, which read to users as the entry having been lost; it now lands at the top where they can confirm it saved. Same-second ties fall back to `id`, so the newest row still wins.

**This is load-bearing for `renderTransactions()`.** The old renderer grouped consecutive same-date rows under a `.tx-day` heading with a per-day total. That grouping cannot survive entry-time order — a backdated row makes the same date reappear further down, printing the heading twice — so the day headings and day totals were removed and **each row now carries its own date** in a `.tx-meta-date` chip (using the existing `dayHeadingLabel()` vocabulary: Today / Yesterday / weekday / `Sat, 5 Aug`).

If you ever restore date ordering, restore the day grouping with it. The `.tx-day*` CSS rules are still in `styles.css`, unused, for exactly that reason.

## 11. Known gaps / things to be careful about

- **Deleting a category orphans its expenses, and they become uneditable.** `DELETE /api/categories/:id` (server.js:485) checks only that one category remains — never whether expenses use it. `expenses.category` is *text*, so those rows keep a name that no longer exists. `PUT /api/expenses/:id` defaults `category` to the existing value and then validates it, so **every subsequent edit returns `400 Invalid category`** — even editing just the amount. The only escape is to also send a valid category. The rows still count in all totals, and Analytics still lists the dead category with a fallback icon, but the filter dropdown cannot select it. Note `PUT /categories/:id` *does* handle this correctly (it carries the new name onto existing expenses) — only delete was missed. **Not yet fixed.**
- **Search treats `%` and `_` as LIKE wildcards.** `params.push('%' + q + '%')` (server.js:521) never escapes the user's text, so searching `%` returns every row instead of none. Cosmetic, no injection risk (statements are parameterised). **Not yet fixed.**
- **Sessions never expire and are never cleaned up.** The `sessions` table grows forever.
- **Room passwords and PINs are cached in `localStorage`/`sessionStorage`** in plaintext (`finledge_session`) so Profile can display them. That is deliberate, but it means an XSS bug is a credential leak — keep `escapeHtml` discipline absolute.
- **No rate limiting** on `/rooms/join` or `/rooms/create`. Room IDs are 4 digits (`FIN-####`).
- **`GET /api/meta` is unauthenticated** (it only returns static vocab lists).
- **Currency is hardcoded GBP** in two places.
- **`amount` is a REAL.** Money maths that must balance uses integer cents — see the largest-remainder split in the settle-up block, which exists so 3 × £6.67 doesn't silently invent a penny. Follow that pattern for any new split.
- ~~**The date picker allows any date, including the future.**~~ Fixed 2026-08-19: the picker is clamped to the write window (§12) and the server refuses out-of-window dates outright.
- **`totalLifetimeSpend`** on the Profile tab is intentionally all-time and must stay that way — it is the one figure not scoped to a month.
- Prod currently holds **10 rooms / 16 members / 34 expenses** (2026-08-19), most of them named like test rooms from earlier sessions. Small data — do not assume load-testing has happened.

---

## 12. What was done in this session (2026-08-19) — deployed

All of the below is **live in production** as of 2026-08-19 23:52 UTC.

**The write window.** A month accepts entries while it is the current month, and for **7 days after it
ends**; then it closes for good. Nothing can ever be dated in the future. Enforced server-side on
`POST`/`PUT`/`DELETE /api/expenses` — the UI mirrors the rule but is not what enforces it.

- The grace month is only reachable on days 1–7 of the following month, which is why it has to be
  tested with a pinned clock (§10) rather than by waiting.
- The refusals speak in full sentences, e.g. *"2026-06 is closed. Entries stay open for 7 days after a
  month ends — you can only add to 2026-08 now."*

**Home is now permanently the live month.** It cannot be switched. The hero always reads "This month",
and the topbar month chip is hidden there. This removes the old trap where Home silently showed a past
month and new entries appeared to vanish.

**History moved to Activity**, which carries a **month bar**: `( Previous ▸ )( Jul )( Aug ·Live )`.
*Previous* opens a month picker grouped by year, newest first, reaching back ~18 months. Analytics
follows the browsed month; Home never does.

**Browsing history expires by itself.** After ~10 minutes idle, or on returning to a backgrounded app,
the view snaps back to the live month and says so in a toast — so nobody adds an expense while parked
in June. Two clocks are used deliberately (`setTimeout` + `visibilitychange`/`focus`), because
background tabs throttle timers. See `HISTORY_IDLE_MS` in `app.js`.

**Rows in closed months render locked**: no edit or delete button, a lock icon, dimmed text.

**Fixed-height transaction cards.** Rows no longer grow with their content: one description line, one
meta line, clipped, `box-sizing: border-box` so padding cannot expand them. Home and Activity share one
renderer (`txItemNode`/`fillTxList`), so they cannot drift apart again.

**Removed:** the Profile "Viewing month" card, the month switcher everywhere, "Switch member", and the
month filter in Home's filter panel. **Fixed:** the Host tools card, whose hint overlapped the title.

### Testing (152 checks, all green)

Never run against the live DB. Everything ran against a **copy** on a scratch port (§10):

- `api-test.js` — 49 backend checks incl. every window boundary, month scoping, and injection-shaped input.
- `uitest/ui.js` — 63 checks driving the real `index.html`/`app.js`/`styles.css` under jsdom.
- `uitest/ui2.js` — 40 checks: add flow, edit flow, refusals, calendar clamping, idle auto-return.

Two jsdom traps worth knowing before you write more UI tests here:

1. **jsdom fires `DOMContentLoaded` itself.** Dispatching your own as well runs the whole `init()` twice,
   doubling every listener — which shows up as one form submit inserting **two** expenses. That is a
   test artifact, not a product bug; the app registers exactly one listener in a browser.
2. **jsdom has no `CSS` object.** `openExpenseModal` uses `CSS.escape` (pre-existing, fine in every real
   browser), so polyfill it or the edit path throws before the modal is shown.

Also: when asserting that a filter is *inert*, pass the **same `limit`** on both requests — otherwise the
default cap of 50 reads as the filter having done something. That mistake was made twice.

### Follow-up the same evening: the background seam (deployed separately)

Reported as *"the background doesn't render and blend properly"* in every section. Pre-existing, not
caused by the work above — but the taller views made it obvious. Two compounding causes:

1. `html` carried `background: var(--bg)`, so **`body`'s background stopped propagating to the canvas**
   and painted inside the body box only. That box is `height: 100%` — one viewport — while `.app` is
   that tall *plus* `padding-bottom: calc(104px + safe)`, so every page overflows it. Below the fold the
   gradients ended and flat `--bg` took over, with a hard seam between them.
2. `background-attachment: fixed` is downgraded to `scroll` on mobile Safari and Chrome, so the glow
   drifted while scrolling instead of staying put.

Fixed by painting the glow in a `position: fixed` layer (`body::before`, `z-index: -1`) instead: it is
the viewport, cannot be clipped by the document box, and behaves identically across browsers. The flat
base moved to `html`, and **`body` must stay `transparent`** — a non-positioned block's background paints
*above* negative-z-index children, so an opaque `body` would hide the glow for the first viewport. That
trap is why the first attempt at this fix was wrong.

CSS-only, so it went out as a file copy with **no pm2 restart and no disruption at all**.

### Left deliberately alone

- `.is-live` is emitted on the live month chip but has no CSS rule; the chip is already marked by its
  "Live" tag. It is a spare styling hook, not a bug.
- The `CSS.escape` call and the §11 gaps above are untouched — none were in scope.

---

## 13. What was done 2026-09-22 — deployed

Live in production as of 2026-09-22 22:00 UTC. Prod backup: `.deploy-backup-20260922215941`.

- **"Invalid Date" on every transaction (iOS/Safari)** — the detail sheet fed a `YYYY-MM-DD` into `absDate()`, which appends `Z`. Now uses `formatDateLabel()`.
- **Swipe left in History reveals Edit / Delete.** Tap opens the detail sheet, which is now **read-only**. Home rows never swipe. `openExpenseModal`/`confirmDeleteExpense` now look up rows via `findExpense()` (History rows are not in `state.expenses` — that was why Edit/Delete were dead there).
- **Monthly sharing (pause / resume).** Tables `participation_changes` (only *changes* are stored; no row = sharing) and `participation_requests`. A member asks, the host approves; the host can set anyone, including themselves. Effective from a **day**, so a month is split into **segments** (`participationSegments` → `computeMonthSplit`), each split by largest remainder across the people sharing in it; balances still net to zero. A paused member cannot add spending dated on/after the pause (server-enforced). Changes may start from the 1st of the current month onward; refused for a settled month **or one with a pending settle-up** (its stale check only watches totals). The segment roster is exactly `monthParticipants`' (joined by the month *or* paid in it).
- **Home hero:** "Transactions" stat replaced by **Sharing** (count + faces). **Analytics:** a notice ("Dan paused on 15 Sep") appears only when a month is segmented; tap to see each stretch's total and per-head. **Profile:** Monthly sharing card; Host tools gained **Hand over host** (`POST /api/room/host`, single transaction, exactly one host).
- WS types added: `participation_changed`, `host_changed`.

Tested on a **synthetic** DB built through the API (copying the live DB was blocked by a data-handling gate): 158 checks across backend, jsdom UI, fixes/handover, and a regression diff of analytics output vs the previous production code.
