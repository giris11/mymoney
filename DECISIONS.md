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
