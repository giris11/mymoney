# Connecting MyMoney to your Dropbox

MyMoney has no server, so each browser keeps its own copy of your data. Sync fixes
that by keeping **one file — `mymoney-sync.json` — in your own Dropbox**, which your
iMac, laptop and iPhone all read and write.

Nothing passes through anybody else's server. There is no account to create with us,
nothing to pay for, and no card to enter.

> **Sync is currently switched off in this build** (`src/sync/held.ts`). The Sync
> screen says so and offers no controls. This document describes the app that is
> waiting behind that hold, and records how the Dropbox side was actually set up.

---

## For the owner: there is nothing to set up

Open **Settings → Sync** and press **Connect to Dropbox**. Dropbox asks, in its own
window, whether to let MyMoney use a folder of its own. That is the whole procedure.

You are **not** asked for a key, a secret, or a password, and MyMoney has none to
ask for. This is the one real difference from the Google Drive version this replaced:
Google gave a browser app no usable public credential, so the owner had to create a
Cloud project and paste a client ID before sync would work at all. Dropbox publishes
its app key as safe for client-side code, so the app carries its own.

Everything below is either (a) the record of how that built-in app is registered, or
(b) the optional path for pointing MyMoney at a Dropbox app of your own.

---

## How the built-in app is registered

This is what exists in the Dropbox App Console today, and it is what the app's code
is written against.

| Setting | Value |
| --- | --- |
| Access type | **Scoped access**, **App folder** |
| App key | `kbqcrqxstpn4baq` — public by design, lives in `src/sync/dropboxAuth.ts` |
| App secret | Exists in the console. **Never used, never stored, never sent.** |
| Public clients (Implicit Grant & PKCE) | **Allow** |
| Redirect URIs | `https://giris11.github.io/mymoney/` and `http://localhost:5173/` |
| Status | Development — correct for an app that only ever serves its own owner |

### App folder, not Full Dropbox

The app is registered for **App folder** access. Dropbox creates one folder for it,
under `Apps/`, and the permission the app holds reaches that folder and nothing else.
The rest of your Dropbox is not merely off-limits to it — it is invisible. The app
cannot list it, cannot search it, and cannot tell what is in it.

Every path in `src/sync/transport.ts` is relative to that folder, which is why the
sync file is addressed as `/mymoney-sync.json`.

### The permissions

Four are ticked, and the app refuses a sign-in that comes back with fewer:

| Scope | Why |
| --- | --- |
| `account_info.read` | Mandatory — Dropbox requires it of every scoped app |
| `files.metadata.read` | The cheap head read, to learn the file's revision without downloading it |
| `files.content.read` | Downloading the snapshot |
| `files.content.write` | Uploading it |

**`files.metadata.write` is deliberately NOT requested.** That scope would give access
to Dropbox's "property groups", the closest thing it has to Google Drive's
`appProperties` — and property groups are written in a *separate request* from the
upload, so they can end up disagreeing with the file's contents. That mismatch is the
exact defect that cost the Drive version of this feature two review rounds (C18/C19).
Refusing the scope is the cheapest possible guarantee that nobody reintroduces it.
Sharing, file requests and contacts are not requested either.

### Both redirect URIs

Dropbox matches a redirect URI **character for character**, trailing slash included.
Two are registered because the app runs from two places — the published site and the
dev server — and one build serves both: `defaultRedirectUri()` computes the directory
the app is being served from, which is exactly one of these two strings.

### Public clients = Allow, and why there is no secret

MyMoney signs in with the OAuth 2 **authorization code flow with PKCE**. A random
verifier is generated in the browser and never leaves it; only its SHA-256 hash is
sent to Dropbox. The code Dropbox hands back is worthless to anyone who does not hold
that verifier.

That is what replaces a client secret, and it is why **"Public clients" must be set to
Allow**. A browser app cannot keep a secret — shipping one would publish it to every
visitor while adding no security whatsoever — so this app has no code path that sends
`client_secret`, on sign-in or on refresh. If one ever appears, that is a bug in the
flow, not a missing setting.

---

## Optional: use your own Dropbox app

Do this only if you would rather the connection was registered in your own Dropbox
account. The app works without it.

1. Go to **[dropbox.com/developers/apps](https://www.dropbox.com/developers/apps)**
   and sign in with the Dropbox account that should hold the file.
2. **Create app.** Choose **Scoped access**, then **App folder** — *not* "Full
   Dropbox". Name it anything; the name is only for you.
3. On the **Permissions** tab tick exactly these four, then **Submit**:
   `account_info.read`, `files.metadata.read`, `files.content.read`,
   `files.content.write`.
4. On **Settings**, set **Public clients (Implicit Grant & PKCE)** to **Allow**.
5. Under **Redirect URIs**, add the address MyMoney is served from, *including the
   trailing slash* — for the published site that is
   `https://giris11.github.io/mymoney/`. The Sync screen shows you the exact string
   to paste, with a copy button, under "Use my own Dropbox app instead".
6. Copy the **App key** from the top of the Settings page.
7. In MyMoney, open **Settings → Sync → Advanced: use my own Dropbox app key**, paste
   it, and press **Connect**.

### ⚠ Do not paste the app secret

The console prints **App secret** directly underneath **App key**. Both are fifteen
lowercase letters and digits, and **they are indistinguishable by shape** — so nothing
in MyMoney can catch this mistake for you. (The Google client ID this replaced could
be checked: it ended in `.apps.googleusercontent.com`, and its secret began `GOCSPX-`.
Dropbox offers no such tell.)

MyMoney never uses a secret, never sends one, and never asks for one. A secret pasted
into that field would simply sit in your browser's storage, useful to nobody, until
you cleared it. Copy the value labelled **App key**.

---

## What you'll see when you connect

A Dropbox window asking you to allow MyMoney access. It names the app folder — the app
is asking for a folder of its own, not for your Dropbox.

- **It can:** create `mymoney-sync.json` inside its own folder, read it back, update it.
- **It cannot:** see, search, list or open anything else in your Dropbox. Your other
  documents and photos are invisible to it — it cannot even tell they exist.

---

## Good to know

- **Signing in lasts.** Dropbox issues a refresh token that is valid until you revoke
  it, so this is a one-off — unlike the Drive version, which expired roughly hourly
  and needed re-consenting. The refresh token is kept in this browser's
  `localStorage`, on this device only; it is deliberately *not* kept in the app's
  database, because the database is what `exportBackup()` copies into every backup
  file you save or share.
- **Allow pop-ups for the site**, or the Dropbox window cannot open.
- **Offline is normal.** With no connection the app behaves exactly as it always has;
  sync just waits.
- **The file is yours.** It sits in `Apps/<the app>/mymoney-sync.json`. MyMoney never
  deletes it — not even when you disconnect. If you delete it yourself, the next sync
  will *refuse* to quietly create a new one: starting a second file would leave your
  devices comparing two unrelated histories as if they were one, so the app stops and
  asks you first.
- **The app key is not a password.** It identifies the app and authorises nothing on
  its own. It is safe in code, and safe in Settings.

## Turning it off

- **In MyMoney:** Settings → Sync → **Disconnect**. This tells Dropbox to cancel the
  permission and forgets the sign-in stored on this device. Your Dropbox file and all
  your local data are untouched.
- **In your Dropbox account:** go to
  **[dropbox.com/account/connected_apps](https://www.dropbox.com/account/connected_apps)**,
  find MyMoney, and disconnect it. That revokes it everywhere, on every device,
  immediately.
- **To remove the data as well:** delete `mymoney-sync.json` from the app's folder,
  then delete it permanently from your Dropbox deleted files.
