# DECISIONS.md

Every non-obvious choice made while building, per Working Agreement §2. Newest at the bottom of each section. Anything here can be changed — say the word.

## Environment

- **D1. Node.js was not installed on this Mac.** Installed official Node v24.19.0 LTS (darwin-arm64) from nodejs.org, SHA256-verified, into `~/.local/node` (user-local, no sudo, nothing system-wide). Added one `export PATH="$HOME/.local/node/bin:$PATH"` line to `~/.zshrc` (clearly commented) so `npm run dev` works in your terminal. Remove that line + `~/.local/node-v24.19.0-darwin-arm64` to uninstall.

## Stack & architecture

- **D2. Styling: Tailwind CSS v4** (via `@tailwindcss/vite`). Chosen over CSS modules: faster to keep two themes + responsive layouts consistent, compiles to a single static stylesheet, zero runtime cost. Theme colours are CSS variables so dark/light is one attribute flip.
- **D3. No router library.** A ~40-line hash router (`#/transactions` etc.). Hash routing is what makes the app work on GitHub Pages subpaths **and** opened as plain `file://` static files (spec §13) with zero server config.
- **D4. No state-management library.** Dexie is the single source of truth; UI subscribes via Dexie's built-in `liveQuery` wrapped in a small `useLive` hook (written in-repo, ~20 lines, `useSyncExternalStore`-style). Avoids adding `dexie-react-hooks` or Redux/Zustand.
- **D5. IDs are v4 UUID strings**, generated in-repo with no dependency.
  **Amended (2026-08-26):** `crypto.randomUUID()` alone was a latent blocker —
  it is specified as *secure-context only*, so it exists on https and
  `localhost` but is simply absent over a LAN address like
  `http://192.168.1.20:5173`, which is exactly how SPEC §11.6 says the phone
  gets the app. Every id flows through `uid()`, including the startup category
  seed, so onboarding died before rendering. It is now a ladder: `randomUUID`
  when present, else `crypto.getRandomValues` (not secure-context gated) with
  the RFC 4122 version/variant bits stamped, else `Math.random` as a last
  resort. These are local record ids, never tokens or keys — Phase 2 encryption
  must use WebCrypto directly and must never call `uid()`.
- **D6. Dates stored as `'YYYY-MM-DD'` strings** (transaction `date`), plus ISO timestamps for `createdAt`/`updatedAt`. Sortable, indexable, timezone-proof (a purchase on the 3rd stays on the 3rd regardless of DST/travel). dayjs used for period math; display format is `DD/MM/YYYY` (en-GB).
- **D7. Vite `base: './'`** (relative). One setting makes the same build work at
  `localhost`, any static host, and any GitHub Pages subpath.
  **Correction (2026-08-26):** the original wording also claimed `file://`, and
  that is not achievable — verified against the built output. Vite emits
  `<script type="module" crossorigin>` and code-splits with dynamic `import()`;
  browsers load ES modules with CORS semantics and treat a `file://` document as
  a null origin, so the page would render an empty `#root`. Service workers
  cannot register on `file://` either, so the offline PWA that SPEC §8.1.10
  requires was never reachable by that route regardless of bundling. Making the
  build a single non-module IIFE would trade away code-splitting and still not
  restore offline support. **SPEC §13's "must also work opened as plain static
  files" therefore cannot be met as written** — flagged for Girish rather than
  silently ignored. Everything else in §13 (localhost now, GitHub Pages when he
  says deploy) works today.
- **D8. One extra devDependency: `fake-indexeddb`.** Spec §10 mandates a backup export→restore round-trip test and balance tests against the real Dexie schema; that needs IndexedDB in Node. `fake-indexeddb` is the standard, MIT-licensed, dev-only shim — it ships nothing to the built app. **Flagging per §11.7 since I couldn't ask first** — say the word and I'll remove it and keep only pure-function tests.

## Money & data semantics

- **D9. Amount storage**: integers in minor units held in JS `number` (exact up to 2^53 — £90 trillion in pence; fine). All arithmetic integer-only; rounding half-away-from-zero applied exactly once at display/conversion (documented in `src/money/money.ts`).
- **D10. `dedupeHash` is the normalised key string itself** (`accountId|date|amount|normalisedPayeeOrDescription`), not a digest. Collision-free, debuggable, still indexable. Payee normalisation: lowercase, trim, collapse whitespace, strip punctuation.
- **D11. FX rate convention**: an `fxRates` row `{base, quote, rate}` means **1 unit of `base` = `rate` units of `quote`**. Settings UI edits rows as "1 CCY = X GBP". Conversion uses a direct rate or the inverse of the reverse row; missing both → "no rate" marker, value excluded from converted totals with a visible note (never a wrong number).
- **D12. Net-worth-over-time uses *current* FX rates for all history** (rate history isn't tracked in Phase 1). Same-currency maths is always exact; only the cross-currency *display* of history moves when you edit a rate. Rate history could be added later since rates rows carry `asOf`.
- **D13. Transfers are excluded from income/spend/budget/category reports** (they're not income or expense). They appear in the register and in account balances. Transfer legs have `categoryId: null`.
- **D14. Refund handling**: a refund is a *positive* amount in an *expense* category — it reduces that category's spend in budgets/reports. The transaction form has an explicit refund toggle so this is discoverable.
- **D15. Pending transactions count in balances and reports** (like MoneyWiz); the register shows status and can filter by it. Sidebar shows the full balance.
- **D16. Budget category selection includes descendants**: budgeting "Food & Drink" covers all its subcategories. Splits are budgeted by each split's own category.
- **D17. Auto-categorisation model**: `payee.defaultCategoryId`, learned from the most frequent category on that payee's existing transactions and applied as a *suggestion* at import + quick-add. The "rules list" in Settings is the editable payee→category table. (Keyword rules can come in Phase 2 if wanted.)
- **D18. Import undo** removes the batch's transactions **and** any accounts/categories/payees/tags that the batch created *if* nothing else references them by then. Created-entity ids are recorded on the `importBatches` row.
- **D19. Sample data is one import batch** (`source: 'sample'`), so "Remove sample data" is literally the import-undo path — one tap, clean removal, and it exercises the undo machinery.
- **D20. MoneyWiz CSV specifics** (until your real export file arrives — drop one in the repo and I'll validate against it): header detection is synonym-based, not positional; category paths split on `" > "` (fallback `"/"` only if no `">"` present anywhere in the column); tags split on `;` or `,`; amounts tolerate thousands separators, currency symbols and parentheses-negatives; date format auto-detected by scanning the whole column (any first-component >12 ⇒ dd/mm; ambiguous ⇒ dd/mm per en-GB, overridable in the mapping UI). Transfer rows are paired by (date, ±amount, account↔account) into real linked transfers; unpairable ones import as normal transactions with a note.
- **D21. Restore is all-or-nothing**: full-file validation first, then a single Dexie transaction that clears and repopulates every table. A malformed file changes nothing. Restore requires typed confirmation ("RESTORE") since it replaces current data.
- **D22. Multi-currency budgets**: budget amounts are in the base currency; spend in other currencies converts at current rates (no-rate transactions listed separately on the budget, not silently dropped).

- **D27. Import fine print** (decided during engine build): duplicates are only
  detected against the *existing database* — rows identical within one file
  import as-is (two identical same-day coffees are legitimate spending).
  Two-digit years pivot at 50 (<50 ⇒ 20xx). Amounts with more precision than
  the currency (e.g. "12.345" GBP) are row errors, never silently rounded.
  Date format and decimal style are detected once per file column, so one file
  can never mix interpretations.
- **D28. Reports missing-rate counting**: `missingRateCount` counts whole
  transactions whose currency has no rate (uniformly across the five flow
  reports); net worth reports the affected currencies by name.

- **D29. Theme display hint in localStorage.** IndexedDB is async, so the
  correct palette cannot be known before first paint — dark-theme users saw a
  white flash on every cold start. `localStorage['mymoney.theme']` holds one
  string (`system|light|dark`) read by a tiny inline script in `index.html`.
  It is a **display hint, never a record** (SPEC §3 stands: all records live in
  IndexedDB, which remains the source of truth and corrects the attribute after
  mount). A missing or stale hint costs exactly one corrected frame.
- **D30. Imported transactions are always stored in their account's currency.**
  A CSV row's `Currency` column describes the purchase, not the ledger
  denomination (MoneyWiz exports the account-currency amount). Storing anything
  else broke the app-wide invariant that `balance = opening + Σ amounts` — the
  balance, net worth and net-worth-over-time code all sum per account. Rows
  whose declared currency differs are counted, noted on the transaction, and
  disclosed in the import preview. No conversion is ever guessed (SPEC §6).
- **D31. Import amount scale follows the resolved account currency.** Parsers
  must choose a currency before the row's account is known, so `ParsedRow`
  carries the raw amount cell and the plan re-derives the amount once the
  account is resolved. Without this a ¥500 row became ¥50,000 and a valid
  3-decimal amount was rejected outright.
- **D32. Duplicate detection consumes its match.** Each existing transaction can
  absorb at most one incoming row, so two legitimately identical rows in one
  file no longer collapse onto a single existing record (that silently dropped
  real spending). Re-importing the same file still skips every row.
- **D33. Backups never claim more than the browser reports.** A `<a download>`
  click gives no completion signal, so `lastBackupAt` is no longer stamped on
  the strength of the click alone — the app does not reset the 7-day nudge for
  a save it could not observe.
- **D34. Live exchange rates — a deliberate Phase 2 pull-forward.** SPEC §8.1.4
  puts Phase 1 on manual rates and §8.2 lists auto-FX as Phase 2. Girish asked
  for real-time rates (and LKR/INR) on 2026-08-26, so the module is being built
  now. Everything the spec attaches to it still holds:
  - **Free, no-key sources only.** Primary `open.er-api.com` (166 currencies),
    fallback `latest.currency-api.pages.dev` (341). Both verified live at build
    time as §8.2 requires: no key, no account, `access-control-allow-origin: *`,
    and both carry LKR and INR. Cross-checked against each other (INR 130.16 vs
    130.01, LKR 447.92 vs 447.81). Zero cost, no signup, no quota to exceed at
    one call a day. (Frankfurter/ECB was rejected — it has no LKR.)
  - **"Real-time" means today's rate.** Free no-key providers publish once
    daily; intraday ticks only exist behind paid APIs, which the zero-fee
    constraint forbids. Daily reference rates are also the right granularity
    for personal finance — and what MoneyWiz itself uses. The UI says so
    rather than implying live ticks.
  - **This is the app's only outbound request, ever** — the single exception
    SPEC §2.3 carves out. Nothing else phones anywhere.
  - **Default ON**, because live rates are what was asked for; one switch in
    Settings → Rates returns the app to making no network requests at all.
  - **Manual rates are never overwritten.** A rate you typed is your explicit
    statement; refreshes skip those pairs and report them as kept. Switching a
    pair to live is an explicit, confirmed action.
  - **Offline changes nothing.** A failed fetch is a non-event: saved rates stay
    in use, missing rates still show the "no rate" marker, and no number is ever
    guessed (SPEC §6).
- **D35. Currency coverage.** LKR added to the picker alongside INR (which was
  already there), plus regional and common-trade currencies (PKR, BDT, NPR, MYR,
  PHP, IDR, AED, SAR, and others). Both rupees use 100 minor units, so the
  default 2 decimals in `money.ts` is already correct — no special-casing. Live
  rates cover far more than the picker lists; the picker is just the shortlist.
- **D36. Settings rows are normalised over defaults on read.** `getSettings()`
  now spreads the stored row over `defaultSettings()`, so a row written by an
  older build gains newly added fields with their defaults instead of
  `undefined`. Adding a setting therefore needs no schema migration, and older
  backups keep restoring cleanly (SPEC §9).
- **D37. The LAN-http route runs the app but is not the PWA.** `vite` now binds
  to every interface (`server.host`), so the iPhone can reach the dev server on
  the same wifi as SPEC §11.6 promises. But a LAN address is `http://`, which is
  not a secure context: **service workers do not register and
  `navigator.storage.persist()` is unavailable there**. So that route is for
  *trying* the app — it is not offline-capable, not truly installable, and iOS
  may evict its data without the persistence request. SPEC §12's "install it on
  an iPhone home screen and use it in airplane mode" therefore needs an https
  origin (GitHub Pages, which is one command away when Girish asks). Recording
  this because it is a deployment fact, not a bug, and it decides where his real
  history should live.
- **D38. Account grouping is inferred, and says when it is guessing.** MoneyWiz's
  Report export carries no account type and no grouping, so all 58 accounts
  imported as `current` in a flat list. `autoGroupAccounts()` files them into ten
  canonical groups (Cash · Bank Accounts · Savings · Credit Cards · Loans ·
  Investments & Assets · Foreign Currency · Gift Cards & Vouchers · Money Lent &
  Owed · Other Accounts) by matching WHOLE WORDS in the name — so "Visa" is not
  an ISA and "Bowen" does not owe anything. Precedence is gift → lending →
  currency → type. `rewards` is deliberately a *weak* signal, which is what
  separates "BARCLAYS REWARDS SERVER" (savings) from "HSBC rewards" (a credit
  card). Anything matched only weakly returns `confident: false` and the UI
  flags it for review rather than asserting a fact about someone's finances.
  Grouping and typing are organisational only — a test asserts transactions,
  per-account balances and net worth are byte-identical across a full run.
- **D39. Exclude-from-net-worth lives on the ACCOUNT.** A group-level control is
  a bulk action that sets the flag on that group's current members, not a second
  standing flag. Two independent flags were rejected: un-excluding one account
  inside an excluded group has no obviously correct answer. Excluded accounts
  stay visible with their real balance — "not counted", never hidden — and the
  net-worth chart shares one predicate with the headline figure so they cannot
  drift apart. An excluded account whose currency has no rate reports "cannot
  total this" rather than a silent zero. Spending and income reports are
  untouched: they group by category, not account. The field is optional
  (`undefined === false`) and unindexed, so no Dexie migration was needed and
  older backups restore with exclusions off.
- **D40. Duplicating a transaction dates the copy TODAY.** "I bought that again"
  is the overwhelming case, and re-typing the date is the friction the feature
  exists to remove. The competing risk — an old row silently re-saved under
  today's date — is handled by making the change visible rather than by
  defaulting to the original date: the dialog is titled "(copy)", and when the
  dates differ a note beside the Date field names the original with a one-click
  "Use that date". Copies carry no id, so saving can only insert; duplicating a
  transfer leg produces a whole new pair with both explicit amounts.
- **D41. The register's filters ARE the URL.** They were component state, which
  is why filtering created no history entry and Back skipped the whole page —
  the reported "no option to go back". A Back button calling `history.back()`
  would have inherited the same fault, so the state moved into the hash instead:
  Back/Forward now work, a narrowed view is bookmarkable and shareable, and the
  old workaround that wiped the address bar on the first filter tweak is gone.
  In-app depth is stamped into `history.state` rather than trusting
  `history.length`, which counts entries from before the app was opened.

- **D42. Drive sync runs on the user's OWN Google credentials, and syncs a whole
  snapshot rather than a stream of edits.** *(Superseded by D44/D45: sync moved
  to Dropbox, which ships a public app key, so nothing is pasted in any more.
  The record below stands as the decision that was taken; `docs/DRIVE-SETUP.md`
  is now `docs/DROPBOX-SETUP.md`.)* SPEC §8.3 lists "optional Google
  Drive backup sync" as Phase 3; pulled forward because opening the live site in
  a second browser showed onboarding again — correct behaviour for per-origin,
  per-browser IndexedDB, but indistinguishable from data loss to the person
  looking at it. Every part of this decision is downstream of §2's no-backend,
  zero-fees rule:
  - **No credential of ours ships.** A browser app cannot keep a client secret,
    and a shared client id would make me the quota holder and the party Google
    contacts. The user pastes in a client id from their own Google Cloud project
    (docs/DROPBOX-SETUP.md is the current file), so the app talked to Google *as
    them*, and revoking it
    is theirs to do at myaccount.google.com/permissions.
  - **Scope is `drive.file`, and a test fails if it is ever widened.** That scope
    grants access only to files this app itself created — it cannot list, read
    or touch anything else in the Drive. It is also classed *non-sensitive*, so
    the app needs no Google review, which is what makes the zero-fee, no-process
    promise survivable. `drive.appdata` was rejected for the opposite reason: it
    hides the file from the user, and a file you cannot see is a file you cannot
    rescue.
  - **The app is PUBLISHED, not left in testing.** Google expires a test app's
    grant after seven days; on a personal finance app that means silent
    reconnection prompts on every device every week, and the first one missed
    looks like sync failing. Publishing is free here precisely because the scope
    is non-sensitive.
  - **One file, whole-database.** Per-record deltas need a merge function, and a
    wrong merge in a money app is the unacceptable outcome §2 names. A snapshot
    can only ever be adopted whole, which makes every outcome explainable.
  - **"Has this device changed?" is a comparison, never a reset.** Three numbers
    do it: `syncLocalRevision` (bumped once per write batch — a 5,127-row import
    counts as one), `syncSyncedLocalRevision` (its value at the last successful
    sync) and `syncLastPulledRevision` (which remote snapshot we descend from).
    Zeroing the counter on sync was rejected: a write landing *during* a push
    would be erased by the reset, the device would then look clean while
    differing from the remote, and the next pull would overwrite it with nobody
    asked. Comparing against a captured value makes that window a redundant
    push instead of a silent loss. **(Audited later: the comparison was sound,
    but the value was captured before two network round trips during which the
    app stayed interactive, so a write landing mid-sync was destroyed anyway,
    and the pending-change marker was cleared unconditionally afterwards. See
    D43.)**
  - **Both sides moved ⇒ ask, and write nothing.** No last-write-wins, no
    timestamp tie-break. The dialog names each side with its device, its time and
    its row counts, and the losing copy is written to a restorable backup file
    *first* — if that write fails, the resolution is abandoned rather than
    proceeding. **(Audited later: that write went through a browser download
    whose success cannot be observed, so "if that write fails" never fired. See
    D43.)**
  - **Settings named `sync*` never travel.** A pulled snapshot carries the other
    device's settings row; letting it land whole would hand this browser the
    other one's device id, client id and sync bookkeeping, and the two would
    then fight over one identity. The device-local key list is declared once, in
    src/sync/syncEngine.ts.

  Cost to the privacy promise, stated plainly: Google is now a **second**
  outbound host after the rates provider, and the app's line is "no external
  requests except exchange rates, and your own Drive when you switch it on".
  Both are off-switchable; with both off the app still makes no network requests
  at all. Building this also surfaced a real latent bug — `updateSettings`
  read-modify-wrote outside a transaction, so a concurrent write could be lost,
  which in the sync path could mark a device clean while it still held unsynced
  changes. Now atomic, with a test that fails without the fix.

- **D43. Sync ancestry is CAUSAL, not numeric — and D42's safety claims were
  audited before anyone trusted them with real money.** D42 shipped with 2,400
  lines of new code, 2,091 lines of tests, and eight stated invariants. An
  adversarial review (six lenses, every finding put to two independent skeptics
  told to default to "refuted") raised eighteen defects and confirmed
  **seventeen**, several reproduced against the real engine. Sync was capable of
  destroying data. The lesson worth keeping is not any single bug — it is that a
  green suite and a carefully argued design document proved almost nothing here,
  because every test and every invariant was written by the same author, in the
  same frame of mind, as the code.
  - **A revision NUMBER is not an identity, and equality is not common
    ancestry.** This was the fatal one. Uploads were unconditional PATCHes, so
    two devices could each write revision N holding different books; the loser
    then compared 2 to 2, reported "up to date", and the next sync silently
    pulled its own rows out of existence — no conflict dialog, no safety file.
    A file re-created in Drive restarts at 1 and reached the same lie by a
    second route. Snapshots now carry an immutable `snapshotId` and the
    `parentSnapshotId` they descend from, so the question is "is this the remote
    I descend from?" rather than "is this number the number I remember".
    Revision survives only for display and ordering.
  - **A clean device can still be the one holding the only copy.** The old table
    read "not dirty ⇒ safe to pull". But a device whose last push is no longer
    the remote's ancestor holds rows that exist nowhere else, and pulling
    destroys them. Divergence is now a conflict *even when this device is
    clean* — the case the original design had no vocabulary for.
  - **Detection beats prevention when the store offers no CAS.** Drive has no
    compare-and-swap. So `writeRemote` re-reads the head immediately before
    uploading and refuses if it moved, then reads back afterwards and refuses to
    report success unless our own snapshot is what landed. A clobber cannot be
    prevented; it can be made impossible to mistake for agreement, which is what
    actually matters — the victim must never record false agreement.
  - **"The app isn't blocked during a sync" was the unexamined assumption.**
    Dirtiness was computed, then two network round trips ran while the owner
    could still type. A transaction entered during the download was applied over,
    and `clearPendingLocalChange()` then erased the evidence. The apply now
    re-checks inside the same transaction that nothing landed since the decision,
    and clearing a pending marker REQUIRES passing the mark being cleared —
    "clear whatever is pending" is no longer expressible, because that phrasing
    was the bug.
  - **A save you cannot observe is not a save.** D42 promised the losing copy was
    written to a restorable file *first*. It went out through an anchor download,
    which resolves whether or not a byte reaches disk — on iOS Safari, routinely
    nothing. The book was then destroyed. The safety copy now goes to a local
    recovery store whose write can be confirmed and proved by a test; the file
    download is offered alongside, never relied upon. Any promise of the form
    "we saved it first" must name a medium whose success is checkable.
  - **Every setting is now explicitly device-local or book-level**, with a test
    that fails if a new field joins neither. Book-level settings previously
    travelled in snapshots without bumping the revision, so changing base
    currency left the device "clean", never pushed, and got silently reverted.
    Relatedly, `restoreBackup` wrote a foreign settings row verbatim — and that
    is the exact path a conflict backup returns through, so recovering from a
    conflict handed this browser the other device's identity.
  - **Auto-sync stays OFF and now says so.** The switch existed and did nothing;
    no code path ever called `syncNow` on its own. Wiring it up unattended, in a
    feature that had just failed a review this badly, was not a call to make on
    the owner's behalf — a control that lies about protecting you is worse than
    no control, so it tells the truth and waits for him.

  Each fix was falsified by mutation: disabling a guard reproduces exactly its
  own defect and nothing else. 852 → 972 tests. What this decision really
  records is that a data-destroying feature should not be trusted on the
  strength of its own author's tests, and that the review has to come before the
  first real sync, not after the first real loss.

- **D44/D45 are referenced above but were never written down here.** They are
  the move from Google Drive to Dropbox — `rev` as the compare-and-swap token,
  causal identity (`snapshotId`/`parentSnapshotId`/`ancestry`) moved inside the
  file body — and the record of them lives in commit `ca43e86`'s message and in
  the header comments of `src/sync/transport.ts`, `src/sync/dropboxAuth.ts`,
  `src/sync/types.ts` and `src/sync/held.ts`, which are unusually complete about
  the reasoning. The gap is recorded rather than closed by reusing the numbers:
  a decision log with a hole in it can be filled later, but one where two
  different decisions both answer to "D44" is a log nobody can cite. Native
  work therefore starts at **D46**.

## UX

- **D23. Quick-add** is a bottom sheet (mobile) / modal (desktop) with amount-first keypad flow, category grid (recent first), payee autocomplete that learns, account defaulting to last used, date defaulting to today. Expense is the default sign; income/refund/transfer are one tap away.
- **D24. Onboarding**: welcome → base currency (GBP preselected) → pick accounts from templates (editable) → choose one of {import MoneyWiz now, load sample data, start empty}.
- **D25. Theme**: `system | light | dark` in Settings, default system, implemented as `data-theme` attribute + CSS variables; both palettes checked for WCAG AA.
- **D26a. Chart accessibility**: seed category colours are a hue-spread set
  checked with a colour-vision-deficiency validator on both theme surfaces.
  Twelve entity colours cannot be pairwise CVD-safe, so the binding rule is
  that every chart mark is direct-labelled (name + value), and category spend
  renders as labelled bar lists, not unlabelled pies. 'Other' is deliberately
  grey (neutral bucket).
- **D26. iOS splash screens**: shipping `apple-touch-icon` + themed manifest (iOS derives launch UI from these). Full per-device `apple-touch-startup-image` sets are 20+ generated PNGs; deferred to Phase 2 polish unless you want them now. Marked partial in PROGRESS.md.

## The native rewrite (Swift, iOS/macOS)

Started 2026-09-01. **These phase numbers are the native project's own (Phase
0, 1, 2) and have nothing to do with SPEC §8's Phase 1/2/3 feature phases** —
an unfortunate collision, so every mention below says which.

- **D46. The app is being rebuilt as a native iOS/macOS app (Swift, SQLite,
  CKSyncEngine), and the PWA keeps the real book until the native one has
  earned it.** Nothing is migrated, switched over or turned off by this
  decision; it authorises building a second implementation and proving it, and
  it stops there.

  **What it buys.**
  - **Replication becomes the platform's problem.** Every line of sync in this
    repo is a line whose failures are ours. D42 shipped 2,400 lines; an
    adversarial review confirmed seventeen defects, several reproduced against
    the real engine. D43 fixed them. D44/D45 then concluded the substrate
    itself was wrong and rebuilt the whole thing on Dropbox. Sync is *still*
    held in code (`src/sync/held.ts`), unshipped — and the honest summary is
    that every round before this one was green and every round before this one
    was wrong in a way its own tests could not see, while the current one has
    not been reviewed at all yet. CKSyncEngine is not
    self-evidently better code than ours. It is code whose conflict semantics
    are exercised by every app on the platform instead of by one book on one
    Mac, and whose bugs are Apple's to fix.
  - **Storage nobody reserves the right to evict.** IndexedDB is a cache the
    browser may reclaim; `navigator.storage.persist()` is a *request*, and it
    is unavailable outside a secure context at all (D37). The whole reason sync
    got pulled forward from Phase 3 was that opening the site in a second
    browser showed onboarding (D42) — correct per-origin behaviour, and
    indistinguishable from data loss to the person looking at it. A SQLite file
    in an app container is not evictable, does not depend on the user having
    installed a web page to the home screen, and does not vary by browser.
  - **Four pieces of hand-written security code stop existing**: the PKCE
    authorisation flow, the refresh-token store (today a long-lived Dropbox
    refresh token sits in `localStorage`, which is the best of several bad
    options in a browser), the compare-and-swap write discipline in
    `transport.ts`, and the causal-ancestry conflict engine in `syncEngine.ts`
    — 4,078 lines under `src/sync/` whose entire purpose is to make somebody
    else's file store behave like a database. On CloudKit the identity is the
    device's iCloud account, held by the OS: there is no token in the app to
    leak, and no authorisation flow of ours to get wrong.

  **What it costs, stated as plainly.**
  - **Apple-only, permanently.** The PWA runs in any browser on any machine.
    This trades that away. Accepted only because every device actually in use
    here is Apple's; it is still a real capability being given up, and it is
    not recoverable later without keeping the web app alive anyway.
  - **The reconciliation has to be earned again from zero.** 1,130 passing
    tests, 58 of 58 account balances matched against the MoneyWiz export, six
    reports, and an import path that needed three separate correctness fixes
    before it was trustworthy — none of that transfers. A Swift function that
    returns a plausible number is worth nothing; it has to return *the* number.
    That is the entire reason Phase 0 built the oracle and froze a backup file
    before any Swift was written (D52).

  **The strongest argument against it, which is not a straw man.** The PWA
  works. It holds the real book, it is deployed and green, and **the storage
  risk this move is meant to retire has not materialised** — nothing has been
  evicted and nothing has been lost. So this spends months against a hazard
  that is real in the platform's specification but has so far cost zero, and it
  does so by rewriting the one component in the project that is *known* to be
  correct, replacing it with one that is merely tested. If that trade is
  refused, almost nothing is wasted: the PWA is untouched, and every CloudKit
  finding below stands on its own as a reason not to have written sync by hand.

### Phase 1 — what the CloudKit probe actually established

A throwaway app (`~/CloudKitProbe`, delete it when it stops being useful)
driving a real CloudKit container with 50 **fabricated** rows. No real
financial data was read; nothing under `/Users/gs/MyMoney/` was opened by it.
Results in `~/CloudKitProbe/results.log`. These were paid for with real
experiments against a real server and would be expensive to rediscover.

- **D47. Cache the WHOLE `CKRecord`, not `encodeSystemFields`.** A three-way
  merge needs the common ancestor, and the Drive/Dropbox design never had one —
  that absence is why a whole-snapshot, refuse-and-ask design was the only
  defensible option there (D42). CloudKit *does* supply it:
  `CKRecordChangedErrorAncestorRecordKey` arrives in the code-14
  `serverRecordChanged` error alongside client and server. **It is the primitive
  the previous design lacked.**

  But it is **reconstructed client-side**, from base values the `CKRecord`
  instance you handed to the save is still carrying. The server keeps no record
  history and never sends an old version. So:
  - `CKRecord` fetched from the server, or restored from a **full**
    `NSKeyedArchiver` archive (`CKRecord.encode(with:)`) → ancestor arrives
    fully populated and equal to the version the client actually edited from.
  - `CKRecord` rebuilt from `encodeSystemFields(with:)` + `CKRecord(coder:)`
    with the fields re-applied by hand — **the shortcut Apple's own
    documentation steers you toward, and what most sync code does** → the
    ancestor arrives with `allKeys() == []`. Not an accessor quirk: the object
    reports zero data keys while the *server* record in the very same error
    reports all five.
  - Brand-new record with no change tag → ancestor empty, correctly: there is
    no base.

  Measured twice on the same collision with the same merge code, changing only
  the cache: system-fields cache → ancestor 0 keys → the merge fell back to a
  two-way modification-time guess and **destroyed the peer's edit, with no
  error, no event and no log line**. Full-record cache → ancestor 5 keys →
  "only client moved" / "only server moved" per field, both edits kept, no user
  involvement. Holds under 12 intervening server versions, single-field and
  all-field edits, archives taken after the local edit, five persist/reload/edit
  cycles, `encryptedValues` as well as plain values, `CKModifyRecordsOperation`
  with `savePolicy = .ifServerRecordUnchanged`, and `CKSyncEngine` — a
  13-variant matrix reproduced across three independent runs.

  **The cost of the rule is 13 MB instead of 9 MB** (about 2.65 KB per row on
  local disk instead of 1.87 KB, at this book's size), and it is local disk
  only — nothing changes about what is uploaded. Rejected: keeping the 9 MB.
  Four megabytes against a silently wrong balance is not a trade worth thinking
  about for long.

  **Apple guarantees none of this.** The entire documentation for
  `CKRecordChangedErrorAncestorRecordKey` is one sentence — "The key to retrieve
  the original version of the record" — with no discussion of when it is
  populated, and Apple's own `CKSyncEngine` sample code never uses the ancestor
  at all (it merges the server record into the local copy). Undocumented for a
  decade. So the behaviour is **observed, not promised**, and the port must
  carry a permanent test that goes red the day it stops being true.

- **D48. A ledger must never hard-delete. Deletion is a SAVE of a tombstone.**
  `CKSyncEngine.PendingRecordZoneChange.deleteRecord` carries a
  `CKRecord.ID` **and nothing else**. There is no change tag on a delete,
  therefore no optimistic-concurrency check to fail, therefore no
  `serverRecordChanged` to catch. `savePolicy = .ifServerRecordUnchanged`
  governs **saves only**. Three scripted scenarios lost data silently and
  reproducibly:
  - a stale delete destroyed an unseen peer edit — `saved 0, deleted 1,
    failedSaves 0, failedDeletes 0`, nothing thrown;
  - a stale edit onto a deleted record **resurrected** it, recreating the row on
    the server, and the only thing separating that from the correct refusal was
    whether the local cache still held a change tag — which is app state, not a
    CloudKit promise: evict a cache, restore a local backup or create the row
    offline and a deleted transaction comes back from the dead. A reappearing
    row is as wrong as a missing one;
  - a delete three server generations stale was **indistinguishable** from a
    current one: both were issued in the same batch, both succeeded, zero
    errors, zero events.

  This is not a gap an app closes by handling errors better, because there is no
  error. It can only be closed *above* CloudKit. So: soft-delete tombstones
  written as ordinary records, which turns every delete into a save and pulls
  deletes back inside the conflict machinery that demonstrably does work.
  Rejected: hard deletes plus "careful" ordering, which is what every one of the
  three scenarios above already was. Rejected also: treating this as acceptable
  because it needs two devices and bad luck — the whole point of the rewrite is
  that replication stops being our hand-written problem, and a delete path that
  loses rows silently is exactly the problem we were trying to hand away. The
  tombstone rule must be under permanent automated test before CloudKit's
  conflict handling counts as solved.

- **D49. The delegate is the only failure channel; the throw is an echo — and
  CloudKit's error surface is uneven at both ends.** `sendChanges()` throws a
  wrapper `CKError` code 2 whenever any record in the batch failed, including
  the completely ordinary `serverRecordChanged`. Unwrapping
  `CKPartialErrorsByItemIDKey` and diffing it against what the delegate had
  already been handed produced the same answer every time it fired (batches of
  1, 1 and 20): **the throw carried nothing the delegate had not already been
  given.** The failure is delivered *first* to
  `handleEvent(.sentRecordZoneChanges)` as `failedRecordSaves` /
  `failedRecordDeletes`; that method returns `Void`, is `async`, and ignoring
  its contents is legal, silent, and gets no compiler help. In the default
  configuration (`automaticallySync = true`) the app never calls `sendChanges()`
  itself, so the throw does not exist as a channel at all and the delegate is
  the *only* place a failure is ever mentioned. An app that implements the
  delegate but leaves `failedRecordSaves` unread loses transactions with no
  error, no log line and no crash. The port therefore treats an unread failure
  list as a build-level mistake, not a runtime one.

  Two related shapes worth writing down:
  - **`CKContainer(identifier:)` is a hard trap, not a throwing or optional
    API.** If the process is not entitled for the named container, merely
    *constructing* it kills the process with `SIGTRAP` (`EXIT=133`,
    `EXC_BREAKPOINT` in `CloudKit`) before anything can be caught. So the same
    framework gives no error where one is needed most and an uncatchable one
    where a `nil` would do.
  - **A crash mid-sync yields a burst of phantom self-conflicts.** After a
    `SIGKILL` during `sendChanges`, all 20 queued edits were recovered from the
    persisted state serialization *and* all 20 had already reached the server,
    so re-sending produced 20 × `serverRecordChanged` **against itself**, client
    and server byte-identical with only the change tag differing. An app that
    treats `serverRecordChanged` as "ask the user" would prompt twenty times
    about conflicts that do not exist. The port must recognise client == server
    (tag aside) and treat it as already-applied.

  (Also established the hard way, and worth keeping out of the next person's
  afternoon: the Team ID is **AQ5Z6U57L5**. `D9URF77Y76` is the per-person
  identifier Apple puts in the certificate common name, not a team id, and
  building with it fails provisioning outright.)

- **D50. Money survives CloudKit exactly, so amounts cross the wire as `Int64`
  and are never wrapped in anything else.** `amountMinor` round-tripped with
  `objCType 'q'` (long long) — exact at 2^53+1, at -(2^53+1) and at
  `Int64.max`. Had CloudKit coerced money to a `Double`, 2^53+1 would have
  returned as 2^53, and `Int64.max` would have come back as 2^63 — which
  overflows `Int64` and traps on the way *back*. It does not. This is a real
  advantage over any JSON-file design, where the number's fate depends on
  whoever parses it, and it means the MONEY RULES survive the transport
  unchanged: no float, nowhere, ever.

- **D51. The first sync is a migration, and its shape was measured rather than
  recalled.** An earlier note in the probe log claimed the app must cap its own
  batches because CloudKit's per-request limits apply; **that note was wrong and
  is corrected here**, because it was written from memory rather than
  observation. Measured with 600 records: the delegate handed
  `CKSyncEngine.RecordZoneChangeBatch` all 600 pending changes and got back a
  batch of 250, then 250, then 100 — the batch type **caps itself**, the engine
  keeps asking until the delegate returns `nil`, and `limitExceeded` was never
  seen. Capping in the app at 150 was *slower* (14.31 s vs 11.34 s for the same
  600) — worse, not safer. Extrapolated to this book: roughly 21 server
  operations and about two minutes for a first sync, with the state
  serialization staying small (~3.8 bytes per pending change, so tens of
  kilobytes, not megabytes). What does matter at that size: **`atomicByZone`
  defaults to `false`**, so a partial failure part-way through leaves the zone
  half-written, and the app must persist the state serialization on every
  `stateUpdate` or the migration restarts from the beginning. The lesson
  underneath the correction is the one to keep: a remembered API limit is not
  evidence, and it was about to produce a slower, more complicated port.

### Phase 2 — porting the money, and what the port had to decide

- **D52. The oracle is the port's contract and the frozen file is its gate;
  neither was written by the Swift side.** Phase 0 built 279 fixture cases
  (267 hand-calculated, not generated from our own code) and froze a read-only
  copy of the real backup with its manifest and canonical content hash. The
  Swift package reads `tools/oracle/cases/*.json` **from the repository at test
  time** — nothing copied, nothing restated — and all 279 pass. Copying the
  fixtures into the Swift tree was rejected for the obvious reason: a copy
  drifts, and a drifted copy of an oracle is just an opinion.

  Coverage is asserted rather than assumed. One test fails if a case names an op
  the harness cannot run; another fails if the file set, the case counts or the
  provenance mix move — so a case added on the TypeScript side turns the Swift
  suite red instead of quietly going unrun. A green run that silently covers
  less than it used to is the failure mode this class of harness has.

  **The gate is a byte-for-byte re-export, not agreement about totals.** The
  frozen file is parsed, the parsed document is thrown away, and the file is
  rebuilt from the decoded Swift records; the canonical content hash must equal
  the one the browser computed, and the bytes must be identical (which is
  stronger than the hash, since the hash ignores `exportedAt`). Balance
  equivalence was rejected as the gate: **two files can agree about every total
  and disagree about a field, and it is the field that gets lost in a
  migration.** That was not theoretical — deliberately sabotaging the writer to
  resolve one absent optional to `false` broke the hash while **every balance
  and the net worth still passed**.

  Three consequences carried forward:
  1. **The content hash covers key *presence*, so a normalising store cannot
     reproduce it.** Several fields are `x?: T` in `src/db/types.ts`: absent and
     `null` are different bytes. A SQLite column declared `NOT NULL DEFAULT 0`
     throws that distinction away, and the native app then cannot write a
     byte-identical file for a book the browser wrote. The schema must keep the
     tri-state (or record presence separately) for that to keep being true.
     `Account.excludeFromNetWorth` became `Bool?` for exactly this reason, and
     `Balances` asks `== true`, which is the TypeScript's `=== true`, so absent
     and false remain the same answer to the only question anyone asks of it.
  2. **A "helpful" writer fails this gate.** The real settings row carries
     device-local `sync*` keys and *omits* one that `types.ts` declares. A
     writer that filled the row in from its own defaults would have added it and
     broken the hash. The writer rebuilds the modelled fields and passes
     unmodelled keys through verbatim, adding nothing.
  3. **The gate must be able to go red.** It was broken three ways on purpose —
     an invented key, one minor unit added to 40 account sums, a reverted sort
     comparator — and each produced its own distinct, named failure. A green
     gate that has never been red proves nothing.

  The gate is **env-gated and not wired into a plain `swift test`**, because
  this repository is public and those figures are the owner's finances. Every
  expectation is read out of the file's own manifest, so the test states no
  balance, no total and no hash. Without the file — on CI, on any other machine,
  or with a stale path — the real-data tests **skip** and the suite is green.
  Rejected: failing when the file is absent. A gate that goes red on a laptop
  that has never seen the owner's data gets switched off within a week, and a
  switched-off gate proves nothing either.

- **D53. Where JavaScript and Swift disagree about the same expression, the port
  follows JavaScript — deliberately, in named places, with a test for each.**
  The port's job is to produce the same answers as the shipping app, not better
  ones. Every divergence below is a place where idiomatic Swift silently gives a
  different result:
  - **String comparison.** JS `<` and a bare `.sort()` compare UTF-16 code
    units. Swift's `String <` normalises first and gives a different order.
    `jsStringLess` is used everywhere the TypeScript uses either; a test
    demonstrates the difference with `a` + combining diaeresis.
  - **String *equality*, which is the subtler half.** Swift's `String ==` is
    canonical equivalence, so precomposed `ä` and `a` + U+0308 are the *same
    string* to Swift and two *different keys* in a JSON file. A sort comparator
    written as `if a != b { return jsStringLess(a, b) }` therefore left that
    pair in arrival order — silently. It now asks `jsStringLess` both ways and
    never tests equality. (Related and flagged, not fixed:
    `BackupReader.validate` uses `Set<String>` for duplicate-id detection and
    has the same blind spot, so it would refuse a file the browser accepts. Ids
    are UUIDs today so it cannot bite; `settings.savedMappings` keys are
    arbitrary strings.)
  - **Sort stability.** JS `sort` has been stable since ES2019; Swift's is not.
    Every ported sort gets an explicit final tiebreak on input position rather
    than relying on the runtime.
  - **Locale.** The `localeCompare` tiebreaks are pinned to `en_GB` where the
    TypeScript gets whatever the browser has. The oracle does not exercise
    them, so this is **a guess, and it is flagged as one in the code** rather
    than presented as a port.
  - **Character classes are spelled out, never handed to a regex engine.**
    ICU's `\d` matches Arabic-Indic digits where JavaScript's does not, and
    ICU's `\s` differs from JS's on U+0085 and U+FEFF. `NSRegularExpression`
    would have been half the code and would have diverged the first time a bank
    exported a file containing a digit from another script.
  - **Lengths and indices are UTF-16 code units.** Levenshtein distance and
    containment match JS `.length` / `a[i]` / `.includes`; Swift's `Character`
    is a grapheme cluster. The near-duplicate threshold is a *fraction of a
    length*, so the unit has to match or the dedupe decisions drift. Tested with
    a combining acute.
  - **Float operand order is preserved exactly** in the FX arithmetic, because
    float multiplication is not associative and reordering can move a `.5`
    across a rounding boundary. Identity conversion short-circuits before any
    `Double` exists at all.

  Three places where the port **deliberately does not follow**, each because
  following would itself risk data:
  - **The 2^53 ceiling is gone.** `parseAmountToMinor` refuses above
    `Number.MAX_SAFE_INTEGER` in TypeScript; in Swift the limit is `Int64.max`.
    A parity test runs 59 inputs × 3 modes against values captured from the real
    TypeScript function: 168 of 171 match exactly and the 3 that differ are
    exactly this window, with the divergence count asserted so a fourth cannot
    appear unnoticed. The risk runs the *other* way — a Swift-written file the
    browser would corrupt — so the importer **warns and names the row**.
  - **Overflow refuses rather than wraps** everywhere in the new code
    (`addingReportingOverflow`, and a checked negation because `-Int64.min`
    traps). The TypeScript cannot express this; a wrapped budget total is a
    negative number with no error anywhere.
  - **Duplicate row ids are refused, and non-summing splits are warned, not
    refused.** The TypeScript leans on Dexie's `bulkAdd` to catch duplicate ids;
    a reader with no database had nothing to catch it. But refusing a file over
    a non-summing split would turn one bad row into a total loss, which is the
    wrong direction on a restore path. Likewise a blank `baseCurrency` falls
    back rather than being refused, matching JS `||` truthiness: refusing a file
    the web app can still restore is itself a way to lose data.

- **D54. `netWorth()` and `netWorthSeries()` round at different granularity, and
  the port reproduces BOTH rather than reconciling them.** Found by porting, and
  confirmed against the real book. `src/domain/balances.ts` converts **once per
  account**; `src/reports/aggregate.ts` keeps per-currency running totals and
  converts **once per currency per sample point** (its own comment says "one
  rounding per ccy per point"). With two accounts in the same non-base currency
  those are different roundings — two accounts at €7.05, rate 0.85: per account
  `705 × 0.85 = 599.25 → 599`, twice, is 1198; per currency `1410 × 0.85 =
  1198.5 → 1199`. One penny apart, and the headline net worth and the right-hand
  end of the net-worth chart disagree by it.

  The oracle cannot see this: both the balances and reports fixture books have
  exactly one account per currency, which is the only reason their two totals
  agree. The real book **does** hit it — more than one non-base currency has
  several counted accounts — and the magnitude is a handful of minor units,
  deliberately not written down anywhere.

  It is not data loss: neither figure is stored, and both are defensible. But
  "the dashboard total and the chart disagree" is a bug in the ordinary sense,
  and it grows as more accounts share a currency. Reconciling it in Swift was
  rejected outright — a port that quietly improves on the thing it is being
  checked against can no longer be checked against it, and this is exactly the
  phase where that check is the entire value. So Swift reproduces both, and the
  real-data test asserts each figure against its own rule with **no tolerance**,
  so whichever way Girish settles it the test will say so. **Open question for
  him, not a decision taken.**

- **D55. One net-worth rule for the whole app — SUM PER CURRENCY, CONVERT ONCE
  — and the manifest carries a VERSION so that every backup already written
  keeps the rule it was written under.** This closes D54, which left the
  disagreement standing as an open question.

  **The rule.** Add up the counted balances of each currency IN that currency,
  then convert each currency subtotal to base exactly once, rounding half away
  from zero at that single step. Not once per account. Three places compute a
  net-worth-shaped total and all three now do this: `src/domain/balances.ts`
  `netWorth()` (the headline, and its separate "not counted" total),
  `src/reports/aggregate.ts` `netWorthSeries()` (the chart), and
  `src/backup/manifest.ts` `computeManifest()` (what a backup file says it
  contains).

  **Why per-currency won.** It rounds once per currency instead of once per
  account, so the error cannot grow with the number of accounts — the
  per-account rule is wrong by up to half a minor unit *per account sharing a
  currency*, which is a bug that gets worse as the book grows. It is the
  ordinary accounting treatment: total in the source currency, then convert.
  And it is what `netWorthSeries()` has always done, so adopting it leaves the
  chart's history truthful instead of retroactively re-rounding two years of
  points to match a worse rule. Per-account's only argument was that it was
  what the headline happened to do.

  **Why the manifest is VERSIONED and not reinterpreted.** `restoreBackup()`
  recomputes every manifest figure from the rows that landed and REFUSES the
  restore if any of them disagrees. Every backup file in existence — including
  the frozen file at `~/Documents/mymoney-backup-2026-09-01.json` that the
  entire native port is gated on — states a net worth computed under the
  per-account rule. Simply changing the arithmetic would therefore have made
  every one of those files fail its own self-check on the way back in.
  Measured, not assumed: recomputing the frozen file's manifest under the new
  rule produces exactly one disagreement — *"net worth is £X.99, but the backup
  says £X.98"* — and a restore of it is refused with "Nothing was changed."
  **That is a data-loss bug introduced while fixing a cosmetic one, and it
  would have been strictly worse than the defect.** Fixing a rounding
  inconsistency by making the safety net reject the files it exists to accept
  is not a fix.

  So `MANIFEST_VERSION` — which already existed and was already understood as
  "a claim this build may not know how to check" — now names the arithmetic:

  - **v1 means "summed per ACCOUNT". Its meaning is FROZEN.** A v1 manifest is
    a record of arithmetic already performed by a build that no longer exists.
    It is never reinterpreted and never silently upgraded.
  - **v2 means "summed per CURRENCY, converted once".** New exports write v2.
  - `computeManifest` takes an explicit, required `netWorthRule`, and the
    version it stamps is derived FROM that rule, so a file cannot claim one and
    hold the other. Exporting passes the current rule; **verifying passes the
    rule the manifest's own version names**, so a v1 file is recomputed the v1
    way and verifies exactly as it does today.
  - `isCheckableManifest` widened from "is this the current version" to "is
    this a version whose rule I know". Narrowing it instead would have left
    every old file restorable but UNVERIFIED, which quietly discards the
    self-check on almost every file that exists — the failure that looks like
    success.

  **A figure that moves across a round trip is expected here, and is not
  corruption.** Restore a v1 backup and export again and the new file states a
  v2 total that may differ by a penny or two. Same book, better rule, and the
  version beside the number is what says which is which. The code says so at
  every one of those points, because whoever next sees a total change during a
  restore will otherwise assume the worst — correctly, in every other
  circumstance.

  **Where per-account rounding is still right and was deliberately left
  alone.** Every `convertMinor` call site was accounted for. A *per-account*
  display figure legitimately rounds per account (`ManifestAccount.
  closingBalanceMinor`, the sidebar's account rows, the rate preview in
  Settings): it is one account, so there is nothing to accumulate. The flow
  reports (`loadFlowData`) and `budgetProgress` convert per transaction because
  a transaction is the unit that gets grouped, and — this is the actual test —
  **nothing computes those totals a second way, so nothing disagrees.** The
  criterion is not "round as late as possible everywhere", it is "one number
  must not be computed two ways in two places".

  **How it was found, and why nothing here caught it.** By porting `netWorth()`
  to Swift and reading the two implementations side by side — not by a failing
  test. It could not have been a failing test: every oracle fixture book has at
  most one counted account per currency (`tools/oracle/books.ts`), and with one
  account per currency the two rules are arithmetically identical. 279 oracle
  cases and 1,130 tests were structurally incapable of seeing it. The real book
  is not like that — two non-base currencies have several counted accounts
  each — so the defect was live on the dashboard the whole time. **The lesson
  is about the fixtures, not the arithmetic: a fixture book that never has two
  accounts in one foreign currency cannot test currency aggregation at all.**
  The regression tests added for this (in `tests/balances.test.ts` and
  `tests/backup.test.ts`) use the smallest book where the rules differ — two
  accounts at €7.05, rate 0.85, 1198 vs 1199 — and the v1 fixture
  (`tests/fixtures/backup-v1-with-manifest.json`) was generated by running the
  PREVIOUS build's own exporter, so it is a file this project really wrote
  rather than an approximation of one.

  **Still to do on the native side, and deliberately not done here** (the port
  is a separate tree and its own commit): `native/` mirrors the OLD rule in two
  places. `Manifest.version` is 1 and `Manifest.compute` converts per account —
  which is why the frozen-file gate still passes byte for byte, and it must
  keep passing, so the Swift writer must gain the same versioned rule rather
  than a bumped constant. `Balances.netWorth` also still converts per account,
  so the port now disagrees with the app it is being proved against by one
  penny on the real book — and its own suite will stay green while doing so,
  for exactly the fixture reason above.
