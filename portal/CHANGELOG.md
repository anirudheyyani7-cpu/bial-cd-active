# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
