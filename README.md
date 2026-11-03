# E-Notes

**Created by Md. Towfiq Bin Hasan and TH team.**

E-Notes is a handwriting notebook for studying with PDFs. Every PDF page becomes a
"sheet": the page sits on one side and a margin for your notes on the other. Write
with the S Pen, a stylus or a mouse; your notebooks sync live between Windows,
Linux, Android and the web, and keep working offline.

## Download

Get the latest version from the **[Releases page](https://github.com/towfiqbinhasan/E-Notes/releases/latest)**:

| Device | File |
|---|---|
| Windows 10/11 | `E-Notes-Setup-<version>.exe` |
| Linux | `E-Notes-<version>-x86_64.AppImage` (any distro) or `E-Notes-<version>-amd64.deb` (Ubuntu/Debian) |
| Android (Galaxy S25 Ultra and others) | `E-Notes-<version>-android.apk` |
| Web (install as an app from the browser) | https://towfiqbinhasan.github.io/E-Notes/ |

One codebase ships as:

| Platform | Technology | Output |
|---|---|---|
| Web / PWA | Vite | `dist/` (GitHub Pages, Vercel or Netlify; installable, works offline) |
| Windows, Linux | Electron | `.exe` installer, `.AppImage`, `.deb` |
| Android (Galaxy S25 Ultra + S Pen) | Capacitor | `.apk` |

All of them sign in to the same Supabase account. Ink you write on one device
appears on the others **while you write** (live ink) and is saved within a
second; everything works offline and syncs when the connection comes back.

### Publishing a new version (already automated)

1. Change `"version"` in `package.json` (for example `1.0.1`) and commit.
2. `git tag v1.0.1 && git push && git push origin v1.0.1`
3. GitHub Actions (`.github/workflows/release.yml`) builds Windows, Linux and the
   signed Android APK and publishes them as a release. Installed desktop apps
   update themselves. Every push to `main` also redeploys the web version
   (`.github/workflows/pages.yml`).

The Android signing key lives **outside** this repository in
`~/E-Notes-signing/` (with its passwords in `README.txt` there) and as GitHub
secrets. Back that folder up: Android only installs updates signed with the
same key.

To turn on sync and sign-in for the released apps, add the repository secrets
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (Settings → Secrets and
variables → Actions), then publish a new version.

---

## 1. Install the tools (once)

| Tool | Why | Where |
|---|---|---|
| **Node.js LTS** (22 or newer) | builds everything | https://nodejs.org |
| **Git** | version control, GitHub releases | https://git-scm.com |
| **Android Studio** | builds the Android app | https://developer.android.com/studio |
| **JDK 17 or 21** | Android Gradle needs it | Android Studio already bundles one (see below) |

Android Studio's bundled JDK is the easiest: in Android Studio open
**Settings → Build, Execution, Deployment → Build Tools → Gradle → Gradle JDK**
and pick *jbr-17* or *jbr-21*. (A newer system JDK such as 25 is too new for
the Android build tools.)

Then, in this folder:

```bash
npm install
```

## 2. Create the Supabase project

1. Go to https://supabase.com, create a free account and a **New project**.
   Remember the database password.
2. **Database:** open **SQL Editor → New query**, paste the whole of
   [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. This creates:
   - the `notebooks` and `sheets` tables, with row level security (each user
     sees only their own rows),
   - the merge functions `upsert_sheet` / `upsert_notebook` (stroke union and
     last-write-wins, see "How sync works" below),
   - Realtime on both tables,
   - the private storage bucket **`pdfs`** and its policies (users can only
     read and write files under the folder `<their user id>/`).

   The script is safe to run again.
3. **Check the bucket:** under **Storage** you should see a private bucket named
   `pdfs`. If it is missing, create it by hand (name `pdfs`, *Public* off) and
   run the SQL again to add the policies.
4. **Email login:** **Authentication → Sign In / Providers → Email** is on by
   default. If you don't want confirmation emails while testing, turn off
   *Confirm email*.
5. **Google login:**
   1. In https://console.cloud.google.com create a project, then go to
      **APIs & Services → OAuth consent screen** and fill it in (External).
   2. **Credentials → Create credentials → OAuth client ID → Web application.**
      Under *Authorized redirect URIs* add
      `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`.
   3. Copy the client ID and secret into Supabase
      **Authentication → Sign In / Providers → Google**, and enable it.
6. **Redirect URLs:** in **Authentication → URL Configuration**:
   - *Site URL*: your web address, e.g. `https://enotes.vercel.app`
     (use `http://localhost:5173` until you deploy).
   - *Redirect URLs*, add all of these:
     ```
     http://localhost:5173/**
     https://YOUR-SITE.vercel.app/**
     enotes://auth-callback
     com.enotes.app://auth-callback
     ```
     The last two let the desktop app and the Android app receive the Google
     sign-in.

## 3. Fill in `.env`

```bash
cp .env.example .env
```

Open `.env` and paste the values from **Supabase → Project Settings → API**
(called *Data API* / *API Keys* in newer dashboards):

```
VITE_SUPABASE_URL=https://abcdefgh.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...   (the "anon" / "publishable" key)
```

The anon key is safe in a client app because row level security protects the
data. Never put the `service_role` key in `.env`. `.env` is git-ignored.

## 4. Run it

```bash
npm run dev            # web app at http://localhost:5173
npm run electron:dev   # desktop window running against the dev server
```

Without a `.env`, the login screen offers **"Use without an account"**, which
keeps notes on that device only.

## 5. Deploy the web version (PWA)

**Vercel:** push the folder to GitHub, then in https://vercel.com click
**Add New → Project**, import the repo, and add the two environment variables
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Click **Deploy**.
`vercel.json` already sets the build command (`npm run build`) and the output
folder (`dist`).

**Netlify:** in https://app.netlify.com choose **Add new site → Import an
existing project**, pick the repo, add the same two environment variables
under **Site configuration → Environment variables**, and deploy.
`netlify.toml` already sets the build settings.

Then put the site address into Supabase *Site URL* / *Redirect URLs* (step 2.6).
On a phone or PC, open the site and choose **Install app** / **Add to Home
screen**. After the first visit the service worker caches the whole app, so it
opens offline.

## 6. Build the desktop apps (Windows + Linux)

```bash
npm run electron:build         # Windows .exe + Linux .AppImage/.deb -> release/
npm run electron:build:linux   # only Linux
npm run electron:build:win     # only Windows
```

- Build the **Windows installer on a Windows PC** (or with the GitHub Action
  below). Building it on Linux needs Wine.
- Linux: `release/E-Notes-1.0.0-x86_64.AppImage` (make it executable and run
  it) or install the `.deb` with `sudo apt install ./release/E-Notes-*.deb`.
- Windows: run `release/E-Notes-Setup-1.0.0.exe`. The build is not
  code-signed, so on first run SmartScreen asks you to confirm: choose
  *More info → Run anyway*.

The desktop app adds a native menu with shortcuts, remembers its window size
and position, accepts PDFs dropped onto the window, and saves exports with a
normal *Save as* dialog.

## 7. Build the Android app (APK) for the Galaxy S25 Ultra

```bash
npm run android:sync   # builds the web app and copies it into android/
npm run android:open   # opens the android/ project in Android Studio
```

In Android Studio:

1. Wait for "Gradle sync" to finish (the first time it downloads a lot). If it
   complains about the JDK, set the Gradle JDK to 17 or 21 (see step 1).
2. **Debug APK (quickest):** **Build → Build App Bundle(s) / APK(s) → Build
   APK(s)**. The file appears at
   `android/app/build/outputs/apk/debug/app-debug.apk`.
3. **Release APK (for daily use):** **Build → Generate Signed App Bundle / APK
   → APK**, create a keystore the first time (**keep it safe: every future
   update must be signed with the same key**), choose *release*. The output is
   `android/app/release/app-release.apk`.

You can also build from the terminal: `cd android && ./gradlew assembleDebug`.

**Install on the Galaxy S25 Ultra:**

- *By USB (easiest when you already have Android Studio):* on the phone open
  **Settings → About phone → Software information** and tap **Build number**
  7 times. Then **Settings → Developer options → USB debugging** on. Plug in the
  phone, accept the prompt, and press the green ▶ Run button in Android Studio,
  or run `adb install -r app-debug.apk`.
- *Without a cable:* copy the APK to the phone (Google Drive, Quick Share,
  e-mail), open it in **My Files**, and allow **Install unknown apps** for that
  app when asked.

**S Pen:** the pen draws with pressure, a finger scrolls and pinch-zooms, and
holding the S Pen side button switches to the eraser. If you have no pen, turn
on **Settings → Draw with finger**.

## 8. How updates reach every device

| Platform | What you do | What users see |
|---|---|---|
| **Web / PWA** | push to GitHub (Vercel/Netlify redeploys) | the new version loads on the next visit; offline copies update in the background |
| **Desktop** | bump `"version"` in `package.json`, then publish a GitHub release (below) | the installed app checks on start, downloads the update, and offers *Restart now* |
| **Android** | bump `versionCode`/`versionName` in `android/app/build.gradle`, `npm run android:sync`, build a new **signed** APK, install it over the old one | notes are kept; they live in the cloud and in the app's storage |

**Desktop auto-update setup (once):**

1. Create a GitHub repository and set `owner` and `repo` in
   `electron-builder.yml` under `publish:`.
2. In the repo go to **Settings → Secrets and variables → Actions** and add
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. To release: change `"version"` in `package.json` (e.g. `1.0.1`), commit,
   then `git tag v1.0.1 && git push && git push --tags`. The workflow in
   `.github/workflows/release.yml` builds Windows and Linux on GitHub's servers
   and attaches the files to a release. Installed apps update from there.
   (Or publish from your PC: `GH_TOKEN=<token> npm run electron:publish`.)

Auto-update works for the Windows installer, the AppImage and the `.deb`.

**Android live updates (optional):** to ship web-code changes to Android without
a new APK, you can add a live-update service such as Capgo
(`@capgo/capacitor-updater`) or Ionic Appflow. Changes to native code or
plugins still need a new APK.

Data is never lost during an update. Notes live in Supabase, and every device
also keeps a local copy in IndexedDB.

## 9. AI helper (free)

The ✨ button in the top bar opens the **AI helper**. It reads the sheet in the
middle of the screen.

**Free, offline, no key:**
- **Read aloud**: reads the page out loud (English or বাংলা), using the device's
  own voice (Android text-to-speech, or the system voices on Windows/Linux/web).
- **Key points**: picks the most important sentences of the page.
- **Page text**: copies the printed text of the PDF page.

These work on PDF pages that contain real text (not scanned images).

**Look up (free, no key):** type a word or topic, get a short explanation from
Wikipedia in English or বাংলা.

**AI with free keys:** Handwriting → text, Summarize, Explain page, Quiz me,
Translate বাংলা ⇄ English, and questions about the sheet. Add one or both keys
(no card needed); when one is busy, the other answers automatically:

| Provider | Get the key | Notes |
|---|---|---|
| Google Gemini | https://aistudio.google.com/apikey → **Create API key** | best at handwriting and Bangla; busy at peak times |
| Groq | https://console.groq.com/keys → **Create API Key** | very fast; reads pictures (Qwen), reads handwriting |

In E-Notes open ✨ AI helper, paste the key, press **Save** (once per device;
the key stays on that device). Free keys have daily limits, and providers may
use free-tier requests to improve their models, so keep very private notes out.

## How it works

### Project layout

```
src/
  main.js      start-up: login, offline start, opening the local database
  ui.js        sidebar, toolbar, sheet list, zoom, import/export, settings, shortcuts
  canvas.js    ink rendering (perfect-freehand), sheet views, pen/touch input
  history.js   undo / redo
  store.js     local data layer + merge rules, writes to IndexedDB and the outbox
  db.js        IndexedDB (idb)
  sync.js      Supabase push / pull / Realtime
  pdf.js       pdf.js rendering + page image cache
  export.js    PDF export with pdf-lib
  ai.js        AI helper: offline tools + Gemini (user's free key)
  platform.js  web / Electron / Android differences (save, share, deep links, status bar)
  supabase.js  Supabase client from .env
  styles.css
public/        manifest, service worker, icons
electron/      main.js (window, menu, updater, app:// protocol), preload.js
android/       Capacitor Android project
supabase/      schema.sql
scripts/       copy pdf.js assets, generate icons
```

### Data and sync

- **Local first:** every edit is written to IndexedDB immediately and queued in
  an *outbox*. Sync pushes the outbox to Supabase 800 ms after you stop writing,
  and keeps retrying with back-off while offline.
- **Live:** each device subscribes to Supabase Realtime, so changes from other
  devices are merged into the open notebook as they happen. When a device
  reconnects or returns to the foreground, it also pulls everything changed
  since its last cursor (`synced_at`, a server-side timestamp).
- **No lost strokes:** every stroke and text box has a unique id and a
  `created` time. Sheets merge as the *union* of items by id, both in the
  browser and on the server (`upsert_sheet`). Deleting is a tombstone
  (`deleted_at`) that always wins. Undoing a delete adds a copy with a new id.
- **Metadata** (titles, order, margins) is last-write-wins on `updated_at`.
- **PDFs** are stored once in the private bucket at `<user_id>/<sha256>.pdf`;
  sheets reference them with `pdf_path` + `pdf_page`. Each device renders pages
  locally with pdf.js and caches the images in IndexedDB. No rendered images go
  to the database.

The schema contains the columns you specified plus `pdf_name`, `margin_side`,
`margin_width`, `paper` (per-sheet layout) and `synced_at` (pull cursor).
After updating the app, run `supabase/schema.sql` again: it only adds what is
missing and keeps your data. Text boxes are
stored in the `strokes` array as items with `"t": "text"`.

### Writing tools

- **Pen presets** (the coloured dots with ▾ in the toolbar): tap a dot to use it,
  tap ▾ (or the active dot again) to edit it: pen type (Ballpoint, Fountain,
  Brush, Pencil), 30 colours + recent + custom colour, thickness, opacity and a
  live preview. **+** adds a preset. Highlighter presets have a *Straight lines
  only* option.
- **Eraser** options: *Whole stroke* or *Precise* (only erases where you rub),
  size, *Erase highlighter only*, and *Clear this sheet*. The S Pen side button
  always erases.
- **Lasso** (L): draw around ink or text to select it, then drag to move, pull
  the round handle to resize, or use the bar: Delete, Duplicate, Copy, Cut and
  quick colours. Ctrl+C / Ctrl+X / Ctrl+V / Ctrl+D / Delete work too, also
  between notebooks.
- **Hold to make a shape**: draw a line, circle, ellipse, triangle or rectangle
  and keep the pen still for half a second; it snaps to a clean shape
  (turn off in Settings).
- **Laser pointer** (K): a red trail for presenting that fades away and is not
  saved.
- **Paper**: plain, lined, grid or dotted, per sheet (⋯ menu) with defaults for
  new sheets in Settings. Exported PDFs include it.
- **Sheets**: the ⋯ menu can duplicate a sheet, move it up or down, insert a
  blank sheet, change the margin, or delete it. The "3 / 12" button at the
  bottom right jumps to any sheet.

### Shortcuts

| Key | Action |
|---|---|
| P / H / E / L / T / K / V | pen / highlighter / eraser / lasso / text / laser / hand |
| Space (hold) | pan with the mouse |
| Ctrl+Z, Ctrl+Y (Ctrl+Shift+Z) | undo, redo |
| Ctrl+C / X / V / D, Delete | copy / cut / paste / duplicate / delete the selection |
| Esc | clear the selection, close menus |
| Ctrl + mouse wheel, Ctrl +/−/0 | zoom in / out / fit width |
| Ctrl+O, Ctrl+E, Ctrl+B | add PDF, export, toggle sidebar |

### Troubleshooting

- **"Sync error" dot:** check that `schema.sql` ran without errors and that
  `.env` has the right URL and key. Your changes are safe on the device and
  upload once the problem is fixed.
- **Google sign-in returns to the browser instead of the app:** check that the
  Redirect URLs in step 2.6 include `enotes://auth-callback` and
  `com.enotes.app://auth-callback`.
- **Using a custom Supabase domain:** add it to the `connect-src` list in the
  Content-Security-Policy `<meta>` tag in `index.html`.
- **Changing app icons:** replace the PNGs in `public/icons/`, `build/icon.png`
  and `android/app/src/main/res/mipmap-*`, or edit and rerun
  `npm run icons`.

---

## Credits

E-Notes is created and maintained by **Md. Towfiq Bin Hasan** and **TH team**.
