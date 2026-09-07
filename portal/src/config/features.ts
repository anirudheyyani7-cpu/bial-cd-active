/**
 * UI feature flags (interim, hardcoded). Single source of truth for whether a
 * feature is surfaced in the running app.
 *
 * The general-assistant chat flag is gone with the feature: conversation-create
 * now requires `header.projectId` for every kind, so `/chat/:chatId` is always a
 * project chat.
 */

// The old deploy flag is DELETED, not flipped (team doctrine: no non-functional
// affordances) — the approval surfaces it hid are now always on: the citizen's
// publish chip (PublishStatusChip, replacing the Publish card, the review-status
// card, and the toolbar button) and the Admin → App Registry review queue.
//
// No flag covers the chip either, deliberately: this file is the portal's only
// flag mechanism, compile-time constants only, so nothing here dark-ships or
// rolls back without a redeploy — why the three retired controls' 48 test cases
// were walked for parity before deletion; that pass is the only safety net here.


