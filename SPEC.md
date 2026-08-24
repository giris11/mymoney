# BUILD PROMPT — Personal Finance PWA (working name: "MyMoney")

**Instruction 0:** Before doing anything else, save this entire document verbatim as `SPEC.md` in the project root. It is the single source of truth for this project. In every future session, read `SPEC.md` first. Then follow the Working Agreement in section 11.

---

## 1. What you are building and why

A complete, production-quality personal finance web app for me (Girish). It replaces MoneyWiz, which I currently use. Goal: match MoneyWiz's features (except live bank connections, which I do not want) and add improvements — with **zero running costs, forever**. No servers, no subscriptions, no paid services of any kind.

It must be a "proper" app on two fronts:

- **Desktop:** a polished website layout like MoneyWiz's — sidebar with account groups and balances, main transaction register, reports.
- **Phone:** an installable PWA — I open it on my iPhone, tap "Add to Home Screen", and it behaves like a native app: own icon, full screen, works fully offline.

## 2. Hard constraints — never violate these

1. **No backend. No server. No database in the cloud. No user accounts or login.** The app is a static site; all data lives on the user's device.
2. **Zero fees:** no paid APIs, no paid services, no dependencies with usage costs. Free/open-source libraries only.
3. **No analytics, no telemetry, no tracking, no external requests** — with one exception: the optional currency-rate module in Phase 2 (see 8.2), which must degrade gracefully when offline or blocked.
4. **No AI/Claude runtime dependencies inside the app.** The built app must run identically with no Anthropic services involved.
5. **Offline-first.** After first load, everything works with no internet.
6. **Data loss is unacceptable.** Versioned schema migrations, import preview + undo, backup nudges, persistent-storage request. Details in sections 7 and 9.
7. **Deployable as a static site** to GitHub Pages (subpath-safe) and runnable locally with `npm run dev`. No feature may assume a server exists.

## 3. Stack (use this; ask before adding anything else)

- **Vite + React + TypeScript**
- **Dexie** (IndexedDB wrapper) for storage — never localStorage for records
- **vite-plugin-pwa** for manifest + service worker (offline, installable)
- **Recharts** for charts
- **PapaParse** for CSV parsing
- **dayjs** for dates
- **@tanstack/react-virtual** for the transaction list
- Styling: Tailwind CSS (or plain CSS modules if you judge better — decide once, record in `DECISIONS.md`)
- Testing: **Vitest**
- Bundle everything; system font stack; no CDN loads at runtime.

## 4. UX and layout

- **Desktop (≥1024px):** left sidebar — net worth at top, account groups with per-account balances, nav (Dashboard, Transactions, Budgets, Reports, Settings). Main area: transaction register with inline filters. Transaction detail in a side panel or modal.
- **Mobile:** bottom tab bar — Dashboard, Transactions, Budgets, Reports, More. Floating quick-add button.
- **Quick add:** logging an expense takes ~3 seconds — amount, category, payee (autocompleted), done. Date defaults to today.
- **Onboarding wizard on first run:** choose base currency (default **GBP**), create first accounts (or pick from templates), offer MoneyWiz import immediately.
- Dark and light mode (follow system, manual override).
- en-GB formats: dd/mm/yyyy, £ symbol placement.
- Include a "load sample data" option (clearly labelled, one-tap removal) so the UI can be demoed and tested.

## 5. Data model (Dexie tables; adjust field names to taste, keep the semantics)

- **accounts**: id, name, type (`current` | `savings` | `credit_card` | `cash` | `loan` | `investment`), currency, openingBalance, colour, groupId, sortOrder, archived. Loan accounts: principal, rate, term → amortisation view (Phase 2).
- **accountGroups**: id, name, sortOrder.
- **transactions**: id, accountId, date, amount (see section 6), currency, payeeId, categoryId, tags[], notes, status (`cleared` | `pending`), splits[] ({categoryId, amount, notes} — must sum exactly to parent amount), transferGroupId (nullable), importBatchId (nullable), dedupeHash, attachmentIds[] (Phase 3), createdAt, updatedAt.
- **Transfers** are two linked transactions sharing a transferGroupId, one per account; editing either syncs the other; cross-currency transfers store both actual amounts explicitly (never derive one from a rate).
- **categories**: id, name, parentId (multi-level tree), kind (`income` | `expense`), icon/colour, archived. Seed a sensible default tree; fully editable.
- **payees**: id, name, defaultCategoryId (learned — see 7.4).
- **tags**: id, name.
- **budgets**: id, name, categoryIds[], amount, period (`weekly` | `monthly` | `yearly`), startDate, rollover (Phase 2), archived.
- **scheduled** (Phase 2): id, template transaction fields, recurrence rule (daily/weekly/monthly/yearly + interval + end condition), nextDueDate, mode (`auto_post` | `remind`).
- **goals** (Phase 2): id, name, targetAmount, currency, targetDate, linkedAccountIds[], manualContributions[].
- **holdings** (Phase 3): id, accountId, symbol, name, units, costBasis, manualPrice, priceUpdatedAt.
- **fxRates**: base, quote, rate, asOf, source (`manual` | `auto`).
- **importBatches**: id, source, fileName, rowCount, importedAt — every import is undoable as a unit.
- **settings**: baseCurrency, theme, lock/encryption config, lastBackupAt, schemaVersion.
- **attachments** (Phase 3): id, blob (compressed image), transactionId.

## 6. Money math rules — non-negotiable

- All amounts are **integers in minor units** (pence, cents). Never do float arithmetic on money. Maintain a small currency-decimals table (default 2; e.g. JPY 0).
- Signed amounts: expenses negative, income positive; account balance = openingBalance + sum of its transactions.
- Currency conversion happens **only at display/report time** using fxRates; stored records are never mutated by rate changes. Missing rate → show original currency with a clear "no rate" marker, never a wrong number.
- Rounding: half away from zero, applied once at final display. Document this in code.
- Splits validation: splits must sum exactly to the parent amount — enforce in UI and in tests.

## 7. Import system (a headline feature — get this right)

### 7.1 MoneyWiz import (Phase 1)
- I will export CSV from MoneyWiz (its export requires English headers; typical columns include Account, Description, Payee, Category, Date, Memo, Amount, Currency, Tags — **treat my real sample file as the source of truth** and build the header mapping flexibly rather than hard-coding one exact layout).
- Auto-detect MoneyWiz exports by their headers. Map multi-level categories, payees, tags, accounts (offer to create missing accounts during preview).

### 7.2 Generic CSV import (Phase 1)
- Column-mapping UI: user assigns date/amount/payee/etc. to columns; handles quoted fields, various date formats, decimal commas, debit/credit in separate columns. Save mappings per file signature for reuse.

### 7.3 Other formats (Phase 2)
- QIF, OFX, QFX, MT940 — same five formats MoneyWiz accepts.

### 7.4 Rules for every import
- **Mandatory preview screen** before anything is written: row count, new accounts/categories/payees to be created, duplicates found, per-row category suggestions.
- **Dedupe:** dedupeHash = normalised (accountId + date + amount + normalised payee/description). Exact duplicates auto-skipped with a count shown; near-duplicates (same amount, date ±1 day, similar payee) flagged for user decision — never silently dropped, never silently doubled.
- **Undo:** every import is one importBatch; "undo this import" removes it cleanly.
- **Auto-categorisation:** learn payee → category from existing data; apply suggestions during import marked as suggestions; user-editable rules list in Settings.
- Re-importing an overlapping export must be painless — that is the point of the dedupe.

## 8. Feature phases — build Phase 1 ONLY, then stop for my testing

### 8.1 Phase 1 — the daily driver (replaces MoneyWiz day-to-day)
1. Accounts: full CRUD, groups, colours, archive; net worth header.
2. Transactions: full CRUD, splits, transfers, refund handling, pending/cleared, tags, notes; virtualised register with instant search and filters (date range, account, category, payee, tag, amount range, text).
3. Categories (multi-level, seeded + editable), payees with autocomplete, tags.
4. Multi-currency with manual rates (Settings → rates table).
5. Imports: MoneyWiz CSV + generic CSV with mapping UI, preview, dedupe, undo (section 7).
6. Budgets (no rollover yet): per period, progress bars, over/under states.
7. Dashboard: net worth, this month's income vs spend, budget snapshot, recent transactions, top categories.
8. Reports (first set): net worth over time; spending by category (drill into subcategories); income vs expense by month; cash flow; spending by payee; spending by tag. Each with date-range picker.
9. Backup: one-tap export of a complete versioned JSON snapshot; full restore with confirmation; nudge if no backup in 7+ days.
10. PWA: installable, offline, correct icons/splash, subpath-safe for GitHub Pages.
11. Dark/light mode, responsive layouts, onboarding wizard, sample-data mode.

### 8.2 Phase 2 — power features
Scheduled/recurring transactions + bills calendar + future-balance forecasting (with catch-up posting on app open); budget rollover and rebalancing; full report set toward MoneyWiz's 30+ (P&L, forecast, custom comparisons); savings goals; **subscription detective** (detect recurring merchants from history automatically; dashboard of monthly/yearly true cost, renewal dates); insights (anomaly flags like "dining 40% above your usual month", duplicate-charge detection); what-if forecast slider; remaining import formats (7.3); report export to CSV/PDF; .ics calendar export for bill reminders (no push notifications — no server); optional passcode lock + encryption at rest (WebCrypto: PBKDF2 key derivation + AES-GCM; explicit UX warning that a forgotten passphrase is unrecoverable by design; user chooses encrypted or plain backups); optional auto FX rates module using a free, no-key public source (verify current availability at build time; manual rates remain the fallback).

### 8.3 Phase 3 — extras
Investment accounts (holdings, cost basis, gains; manual price updates always; optional auto prices only if a genuinely free no-key source exists); receipt photo attachments (client-side compression, stored in IndexedDB); personal/business profile split (separate books, switchable); optional Google Drive backup sync (client-side OAuth, user's own storage, still zero fees); Playwright e2e tests; GitHub Pages deployment via Actions when I ask.

## 9. Non-functional requirements

- **Scale:** smooth with 50,000–100,000 transactions (years of history). Proper Dexie indexes (date, accountId, categoryId, payeeId); virtualised lists; aggregate efficiently. Don't prematurely optimise beyond that.
- **Durability:** call `navigator.storage.persist()` and surface its result; backup nudges (Phase 1); iOS can evict storage of unused sites — the backup system is the mitigation, so make it frictionless.
- **Migrations:** every schema change ships a versioned Dexie migration; a backup-restore round-trip must always work across versions.
- **Accessibility:** keyboard-navigable forms, labelled inputs, WCAG AA contrast in both themes, visible focus states.
- **Quality bar:** this is a finance app — correctness beats features. When in doubt, protect the data.

## 10. Testing (must pass before any phase is "done")

Vitest unit tests for, at minimum: money math (integer units, splits summation, multi-currency display, rounding); balance calculations; import parsing (MoneyWiz + generic CSV edge cases: quoted commas, date formats, decimal commas, debit/credit columns); dedupe hashing incl. near-duplicate detection; budget period maths; backup export→restore round-trip equality; recurrence engine (Phase 2). Run the full suite before declaring a phase complete.

## 11. Working Agreement — how to work with me

1. Save this doc as `SPEC.md` (Instruction 0), `git init`, commit the spec first.
2. Read the whole spec, then ask me **at most one round** of clarifying questions — only ones that change the build. Otherwise make sensible choices and log every choice in `DECISIONS.md`.
3. Plan before building (use plan mode for anything large). Build **Phase 1 only**, then STOP and hand over for my testing. Same gate between every phase.
4. Maintain `PROGRESS.md`: every spec feature with status (done / partial / not started). Update it as you go — I read it between sessions.
5. Small, meaningful git commits per feature. Never force-push. Never delete my data files.
6. After building, run `npm run dev` and tell me the local URL; when I ask, explain how to open it on my iPhone (same wifi) and how to install it as a PWA.
7. Never add: servers, cloud databases, logins, analytics, paid anything, AI calls. New dependencies beyond section 3: ask first.
8. If anything in this spec is technically wrong, or you know a materially better approach, say so before coding — don't silently deviate, and don't silently comply either.
9. If you hit the same blocker twice, stop and tell me rather than trying endless workarounds.

## 12. Definition of done — Phase 1

A fresh user can: complete onboarding (GBP base, accounts created); add/edit/delete transactions including a split and a transfer; import a real MoneyWiz CSV export via preview, with duplicates correctly detected on a deliberate second import of the same file; see dashboard, all six Phase-1 reports, and budget progress showing **correct numbers verified against a hand-calculated sample**; export a backup, wipe the app, restore it, and find everything identical; install it on an iPhone home screen and use it in airplane mode; switch dark/light mode; and `npm test` passes clean.

## 13. Assumptions already baked in (change only if I say otherwise)

- Base currency GBP; en-GB formats; English UI only.
- This app **replaces** MoneyWiz (full history imported, day-to-day logging happens here).
- Single user, no login; device sync via backup files until Phase 3's optional Drive sync.
- Hosting: local/dev now; GitHub Pages when I say deploy; the app must also work opened as plain static files.
- Working name "MyMoney" — I may rename it later; keep the name in one config constant.
