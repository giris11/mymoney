# DECISIONS.md

Every non-obvious choice made while building, per Working Agreement §2. Newest at the bottom of each section. Anything here can be changed — say the word.

## Environment

- **D1. Node.js was not installed on this Mac.** Installed official Node v24.19.0 LTS (darwin-arm64) from nodejs.org, SHA256-verified, into `~/.local/node` (user-local, no sudo, nothing system-wide). Added one `export PATH="$HOME/.local/node/bin:$PATH"` line to `~/.zshrc` (clearly commented) so `npm run dev` works in your terminal. Remove that line + `~/.local/node-v24.19.0-darwin-arm64` to uninstall.

## Stack & architecture

- **D2. Styling: Tailwind CSS v4** (via `@tailwindcss/vite`). Chosen over CSS modules: faster to keep two themes + responsive layouts consistent, compiles to a single static stylesheet, zero runtime cost. Theme colours are CSS variables so dark/light is one attribute flip.
- **D3. No router library.** A ~40-line hash router (`#/transactions` etc.). Hash routing is what makes the app work on GitHub Pages subpaths **and** opened as plain `file://` static files (spec §13) with zero server config.
- **D4. No state-management library.** Dexie is the single source of truth; UI subscribes via Dexie's built-in `liveQuery` wrapped in a small `useLive` hook (written in-repo, ~20 lines, `useSyncExternalStore`-style). Avoids adding `dexie-react-hooks` or Redux/Zustand.
- **D5. IDs are `crypto.randomUUID()`** strings. No id-generation dependency.
- **D6. Dates stored as `'YYYY-MM-DD'` strings** (transaction `date`), plus ISO timestamps for `createdAt`/`updatedAt`. Sortable, indexable, timezone-proof (a purchase on the 3rd stays on the 3rd regardless of DST/travel). dayjs used for period math; display format is `DD/MM/YYYY` (en-GB).
- **D7. Vite `base: './'`** (relative). One setting makes the same build work at `localhost`, any GitHub Pages subpath, and `file://`.
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

## UX

- **D23. Quick-add** is a bottom sheet (mobile) / modal (desktop) with amount-first keypad flow, category grid (recent first), payee autocomplete that learns, account defaulting to last used, date defaulting to today. Expense is the default sign; income/refund/transfer are one tap away.
- **D24. Onboarding**: welcome → base currency (GBP preselected) → pick accounts from templates (editable) → choose one of {import MoneyWiz now, load sample data, start empty}.
- **D25. Theme**: `system | light | dark` in Settings, default system, implemented as `data-theme` attribute + CSS variables; both palettes checked for WCAG AA.
- **D26. iOS splash screens**: shipping `apple-touch-icon` + themed manifest (iOS derives launch UI from these). Full per-device `apple-touch-startup-image` sets are 20+ generated PNGs; deferred to Phase 2 polish unless you want them now. Marked partial in PROGRESS.md.
