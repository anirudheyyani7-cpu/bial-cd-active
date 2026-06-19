# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
