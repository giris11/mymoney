# Connecting MyMoney to your Google Drive

MyMoney has no server, so each browser keeps its own copy of your data. Drive sync
fixes that by keeping **one file — `mymoney-sync.json` — in your own Google Drive**,
which your iMac, laptop and iPhone all read and write.

It stays free forever. You create your own Google credential (10 minutes, once),
the data goes to your Drive, and nothing passes through anybody else's server.

You need a Google account. You do **not** need any Google Cloud experience, and you
will not be asked for a card.

---

## Step by step

1. Go to **[console.cloud.google.com](https://console.cloud.google.com)** and sign in
   with the Google account whose Drive you want to sync to.
2. **Create a project.** Click the project dropdown at the top → **New Project** →
   name it `MyMoney Sync` → **Create**. Wait a few seconds, then make sure it is the
   selected project in that dropdown.
3. **Turn on the Drive API.** Search "Google Drive API" in the top search bar, open
   it, and click **Enable**.
4. **Set up the consent screen.** Go to **APIs & Services → OAuth consent screen**.
   Choose **External**, then fill in only what is required: app name (`MyMoney`),
   your own email for both the support and developer contact fields. Save.
   - Leave the app in **Testing** status and add your own Google address under
     **Test users**. That is all this needs — the narrow `drive.file` permission
     below does not trigger Google's app-verification review.
5. **Create the credential.** Go to **APIs & Services → Credentials** →
   **Create Credentials** → **OAuth client ID** → Application type **Web application**.
   Name it `MyMoney web`.
6. **Add both authorised JavaScript origins** (exactly these — no trailing slash,
   no path):

   ```
   https://giris11.github.io
   http://localhost:5173
   ```

   Leave "Authorised redirect URIs" empty; this sign-in style doesn't use them.
   Click **Create**.
7. **Copy the Client ID** (it ends in `.apps.googleusercontent.com`). Google also
   shows a "Client secret" — **ignore it**. A browser app cannot keep a secret, so
   MyMoney never uses one and never asks you for one.
8. In MyMoney, open **Settings → Sync**, paste the Client ID, and click **Connect**.

---

## What you'll see when you connect

A Google popup asking you to pick your account, then a permission screen. It will say
MyMoney wants to **"See, edit, create and delete only the specific Google Drive files
you use with this app."**

That wording is the whole point. The permission MyMoney asks for is
`drive.file` — per-file access — and it is the narrowest one Google offers:

- **It can:** create `mymoney-sync.json`, read it back, and update it.
- **It cannot:** see, search, open, or touch anything else in your Drive. Your other
  documents, photos and folders are invisible to it — it cannot even tell they exist.

Because the app is in Testing, Google may first warn that it "hasn't verified this
app". That is expected — it is your own app, created by you a minute ago. Click
**Advanced → Go to MyMoney** to continue.

---

## Good to know

- **Signing in lasts about an hour.** Google's browser sign-in issues a short-lived
  pass and deliberately gives out no long-term one. MyMoney renews it quietly in the
  background where your browser allows it, and shows a **Reconnect** button when it
  can't. Nothing is lost when that happens — your data is on your device regardless.
- **Allow pop-ups for the site**, or the Google window can't open.
- **Offline is normal.** With no connection the app behaves exactly as it always has;
  sync just waits.
- **The file is yours.** It sits in *My Drive* as `mymoney-sync.json`. MyMoney never
  deletes it — not even when you disconnect. If you delete it yourself, the next sync
  simply creates it again from the device you sync from.
- **The Client ID is not a password.** It identifies your project, nothing more; it is
  safe sitting in Settings. It is stored on your device only and is never committed to
  the repo.

## Turning it off

- **In MyMoney:** Settings → Sync → **Disconnect**. This releases the access on that
  device and forgets the sign-in. Your Drive file and all your local data are untouched.
- **In your Google account:** go to
  **[myaccount.google.com/permissions](https://myaccount.google.com/permissions)**,
  find **MyMoney**, and choose **Remove access**. That revokes it everywhere, on every
  device, immediately.
