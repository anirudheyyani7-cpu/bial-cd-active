# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.5] - 2026-06-24

### Added
- **Generated apps can turn an uploaded spreadsheet into a dashboard.** A deployed or
  preview app can now hand an uploaded Excel (`.xlsx`/`.xls`), CSV, or Word (`.docx`) file
  to the platform to be parsed — spreadsheets come back as structured rows, with the list
  of worksheet names so the app can offer a sheet picker; Word comes back as text — and
  render KPI cards, charts, and sortable tables from it. A view-only app parses for the
  session and keeps nothing; nothing is stored unless the app explicitly saves it. Reached
  through the injected `BIALData.parseFile(...)` client (a fresh file, or a previously
  uploaded one by id). PDF parsing is a planned fast-follow.
- **Real charts in generated apps.** The sanctioned Recharts charting library is now
  available inside every app sandbox, so dashboards render proper bar / line / grouped /
  stacked charts instead of hand-drawn SVG.

### Changed
- **Builder guidance for parsing and charts.** The app builder now knows to parse files via
  `BIALData.parseFile` (never a hand-rolled or CDN parser, and never assuming a global like
  `XLSX`), to offer worksheet and column selection where useful, and to draw charts with
  the Recharts global.

### Security
- **Untrusted uploaded files are parsed under strict server-side limits.** Parsing runs in
  an isolated worker thread with a hard wall-clock time budget and a memory ceiling, behind
  file-size, decompressed-size (zip-bomb), and row/column caps — an oversized or malicious
  file is rejected or truncated cleanly rather than exhausting the server, and a bomb can't
  slip through by being relabelled. The chart library is served through the sandbox's
  existing script allowlist with no change to the network/image rules that keep an app's
  session token from leaking.

## [1.4.4] - 2026-06-24

### Added
- **Attach Word and Excel files in chat.** You can now drop a `.docx` or `.xlsx` into any of
  the three chat surfaces (App Plan, Build, and BIAL Chat) alongside images, PDFs, and
  CSV/TXT. The document's text and the spreadsheet's sheets are read so the AI can answer
  questions about them, build from them, or summarise them. The original file stays attached
  as a chip you can click to download, byte-for-byte. Up to 4 MB per file. Legacy `.doc`
  files are politely declined with a "save as .docx" message.

### Changed
- **Large spreadsheets are handled gracefully.** Each sheet now sends up to 1,000 rows to the
  AI (raised from 200), so real rosters and schedules come through whole. If a sheet is still
  larger, the attachment is marked "truncated" and hovering the chip tells you exactly what
  was shortened — for example "first 1,000 of 2,300 rows" — while the file you download stays
  complete.

## [1.4.3] - 2026-06-24

### Fixed
- **No more surprise sign-outs on a brief hiccup.** When the app refreshed your session
  in the background, a momentary network blip, a rate-limit, or a transient server error
  could wrongly sign you out and bounce you to the login screen with "session expired" —
  even though your session was still valid. The app now signs you out only on a real
  authentication failure; transient errors keep you signed in and retry quietly.

### Changed
- **Steadier background session refresh.** After a transient refresh failure the app now
  waits briefly before trying again instead of retrying on every click — which, when many
  pilot users share one network, was making the rate-limiting worse. Each fail-open event
  is now logged to the browser console so session issues are easier to diagnose.

## [1.4.2] - 2026-06-24

### Added
- **Apps can now keep files, not just records.** A generated app can store an uploaded
  file or a file it produces (for example a reconciliation report), then list it,
  download it to your device, or re-open it inside the app later. Files survive a page
  refresh and are scoped to the app. Supported types: CSV, Excel (xlsx/xls), JSON, text,
  PDF, and common images (PNG/JPEG/GIF/WebP), up to roughly 18 MB per file.
- **Admin file visibility and cleanup.** Admins can see each app's file count and storage
  use, clear an app's files, and recompute the usage counters if they ever drift. Deleting
  an app also removes its stored files.

### Changed
- **Builder guidance for files.** The app builder now knows when to keep a file versus keep
  records, shows the worked reconciliation-report pattern, and warns that an app holding
  sensitive files must require sign-in and IT security review before go-live.
- **Runtime download support.** Deployed apps and the live preview can trigger a file
  download and render stored images inline, without widening what the sandbox can reach.

### Fixed
- Hardened the two-store file writes so a failed upload or delete no longer leaves an
  orphaned file or a wrong usage counter; cleanup and counter-recompute are race-safe.
- File lists now query against a matching database index, avoiding a slow or failing path
  on the production database.
- A generated file download over a non-secure URL now safely falls back to the in-app proxy.

## [1.4.1] - 2026-06-23

### Added
- **Pilot (POC) notice on the home screen.** A short banner now states this is an
  early proof-of-concept and that apps and data are for demonstration only and may
  change or reset, so first-time users know what to expect.

### Changed
- **The daily AI token counter is now easy to see.** It moved from tiny grey text to
  a clear status chip showing `used / limit` that turns amber as you near the limit
  and red when it's used up. It still reads your live usage and resets at midnight IST.
- **Clearer "Plan with AI" vs "Build an App".** The App Builder now explains that
  Plan with AI scopes your requirements in a guided chat first (no code yet), while
  Build an App jumps straight to a working draft.
- **Honest global search.** The search box no longer advertises apps it can't find —
  it now reads "Search pages or actions…" to match what it actually searches.

### Removed
- **Removed the non-functional "Data Source" dropdown and "Backend Schema" toggle**
  from the build sandbox. They connected to no real system, so they are gone, along
  with the misleading help text that claimed the portal connects to AODB, FIDS, and
  other airport systems. File upload, the Theme picker, and saved app data are
  unchanged.
- **Removed the meaningless role label** ("User") shown under the home-screen greeting.

## [1.4.0] - 2026-06-23

### Added
- **Build real, data-backed apps and deploy them to a shareable link.** The App
  Builder now generates working tools (like a Gate Inspection Log) that save records
  to a shared, per-app data store instead of holding everything in the browser.
  Start from a prompt or seed from an uploaded CSV, then **Submit for deployment**;
  once an admin approves, the app is served at its own `/apps/:id` URL. Apps can
  require your BIAL portal sign-in, and what you save persists and is shared with
  other signed-in users.
- **Search, filter, and page through your records.** Generated apps now include a
  search box that matches across every field, per-field filters (e.g. show only
  Status = Fail), and page-number pagination with a live total count. These are
  powered by a shared data API and the App Builder wires them in automatically, so
  apps stay fast even as the record count grows — no more loading every row into the
  browser to search or sort.
- **Admin App Registry.** Admins can review and approve or reject submitted apps,
  turn each app's sign-in requirement on or off, disable or delete an app, clear its
  data, and read a full audit trail of who created, changed, or deleted records.

### Security
- **Strict per-app data isolation.** Every record read and write is scoped to its
  own app, so one app can never see or change another app's data — even if someone
  guesses a record ID. Per-app storage quotas and request rate limits are enforced.
- **Hardened app sandbox.** Deployed apps and the live preview run in an
  opaque-origin sandboxed frame that cannot read your portal session. A scoped
  content-security-policy blocks any off-origin leak of the short-lived access token,
  native form submissions can't smuggle it out, and the long-lived refresh token is
  never handed to an app.

### Fixed
- **Record search and lists work on the deployed (Azure Cosmos DB) database, not
  just locally.** Record search now sorts on a single field, and the per-app
  list/search reads ship the tenant-scoped composite indexes Cosmos requires — it
  rejects a multi-field sort, or a filtered-and-sorted read with no matching index,
  with a 400 (the same constraint that broke chat history in 1.3.1–1.3.3). The
  indexes are created automatically on server start and can be applied to a running
  deployment with `node scripts/ensure-indexes.js`.
- **Sign-in works in deployed data-backed apps.** The app page now signs you in with
  the shared BIAL login and hands the running app a ready session (your identity is
  available to the app, never your password), so apps no longer try — and fail — to
  log in from inside their sandbox. The App Builder also stops generating a redundant
  in-app login form, and any older app that still has one now skips it automatically.

## [1.3.3] - 2026-06-23

### Fixed
- **Opening a conversation now actually loads its messages on the deployed app.** A
  live probe against the Cosmos account showed it serves only single-field ORDER BY
  — any multi-field sort (`{seq, createdAt}`, `{seq, createdAt, _id}`) returns the
  same 400, even with a matching compound index, which is why 1.3.1/1.3.2 did not
  fully resolve it. Messages now sort by `seq` alone; `seq` is a unique, monotonic
  per-conversation counter (user = N, assistant = N+1) so it fully orders messages
  with no tiebreak, and the matching index drops to `{conversationId, username, seq}`.

## [1.3.2] - 2026-06-23

### Fixed
- **Opening a chat or App Builder conversation works on the deployed app.** The
  1.3.1 indexes fixed the conversation list, but loading a single conversation's
  messages still failed with the same Cosmos 400 because the message read sorted by
  `_id` as a final tiebreak — and Azure Cosmos DB for MongoDB will not serve an
  ORDER BY that includes `_id`, even with the index present. Messages now sort by
  `{seq, createdAt}` and the matching index drops `_id`, so the read is served.

## [1.3.1] - 2026-06-23

### Fixed
- **Chat and App Builder history loads again on the deployed app.** On Azure Cosmos
  DB, listing your conversations and opening a chat were failing with a 400 error
  because the database had no composite index to serve those sorted, filtered
  reads (it worked locally, where the database does not require one). The required
  indexes are now created automatically on server start, so a fresh deployment
  fixes itself. To unblock a running deployment without redeploying, run
  `node scripts/ensure-indexes.js`.

## [1.3.0] - 2026-06-22

### Added
- **Your chats, generated apps, and uploaded files now follow you across browsers
  and devices.** Planning chats, App Builder sessions, the generated app code, and
  attachments are saved to your account on the server instead of only in this
  browser. Sign in on another machine and your recent work is already there;
  clearing your browser no longer loses anything.
- **Image and PDF attachments are kept in cloud object storage.** Attachment files
  live in a dedicated object store (Azure Blob Storage in production, or any
  S3-compatible store) and are served back through an authenticated, per-user link,
  so your files are only ever readable by you. Small text files (CSV/TXT) travel
  inline with the message. Supported uploads: PNG, JPEG, GIF, WebP, and PDF, up to
  4 MB each, with a 50 MB per-user total; unsupported files are rejected with a
  clear message.

### Changed
- **Conversations and generated code load from the server.** The App Builder and
  chat history, message order, and the latest generated app preview are read from
  the server on every open and refresh, replacing the previous browser-only
  storage. Signing out clears your local session while your work stays safe on the
  server.

## [1.2.0] - 2026-06-19

### Fixed
- **No more surprise logouts while navigating.** The route guard now silently
  refreshes an expired access token (using the still-valid 7-day refresh token)
  before redirecting, instead of bouncing you to the login screen the moment the
  15-minute access token lapsed mid-session. A transient network error during the
  refresh no longer wipes your session either — only a genuine auth failure signs
  you out, so a brief connectivity blip lets the next action retry.

### Removed
- **Deploy feature removed.** The non-functional "Deploy App" button — and its
  mock deploy page/route — is gone, along with the related Help Center FAQ, the
  "Understanding Deployment" section, and the deploy references in the App Builder
  copy.
- **Login "Contact IT Support Desk" link removed**, as it pointed at a
  non-functional destination.

### Changed
- **Consistent "Plan with AI" naming.** The App Builder sandbox's planning toggle
  is now labelled "Plan with AI" (was "Chat & Plan"), matching the hero and
  history CTAs. The duplicate "Plan with AI" button in the workspace empty state
  was removed, since the hero card above it already offers the same action.

## [1.1.1] - 2026-06-19

### Changed
- **BIAL Chat is temporarily hidden.** The general-assistant chat no longer
  appears in the top nav, the search dropdown, or the dashboard, and the
  dashboard reflows cleanly around the single remaining App Builder card. This is
  a temporary suppression behind a single flag — the `/chat` pages still work by
  direct URL and the feature can be restored in one line.
- **BIAL pilot users now get memorable temporary passwords.** The pilot seed sets
  each user's password to `<LastName>BIAL@123` (e.g. `FernandezBIAL@123`) instead
  of a random string, and every run now also resets existing users' passwords to
  this value — so missing users are created and existing ones refreshed in a
  single pass. Passwords are still stored only as Argon2id hashes. The redundant
  `--rotate` flag was removed; `--dry-run` still previews without writing.

## [1.1.0] - 2026-06-18

### Added
- **Send feedback from anywhere.** A "Feedback" button in the header opens a modal
  with a single text box; submitting stores the message tagged with who sent it,
  when, and which page they were on, then confirms with a toast.
- **Review feedback in Admin.** A read-only "Feedback" tab in the Admin console
  lists submissions newest-first (user, message, page, time), visible to admins only.

### Changed
- New required setting `MONGODB_FEEDBACK_COLLECTION` plus a pre-created Cosmos
  `feedback` collection are needed before deploy. Local dev (docker `mongo:7`)
  auto-creates the collection on first write, so only the env var is needed locally.
