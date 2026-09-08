/**
 * First 7 of a commit — THE length the product shows a person, everywhere.
 *
 * Lives here because the disagreement it used to describe is over: this was private to the
 * admin declaration module, whose comment recorded a defect fixable nowhere from there — the
 * admin screen showed 7 while the citizen's publish/review cards showed 12 for the same
 * commit, left alone because changing either was a visible change, not a refactor. Both cards
 * are gone now, replaced by one publish chip, so there is one citizen-facing display again,
 * agreeing with the administrator's. `null` reads as an em dash, not an empty string — a
 * blank version row looks like a layout bug, indistinguishable from one that was blank.
 */
export function shortSha(sha: string | null): string {
  return sha === null ? '—' : sha.slice(0, 7)
}
