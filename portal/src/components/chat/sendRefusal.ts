/**
 * A refusal whose message was WRITTEN FOR THE CITIZEN and is therefore safe to show.
 *
 * The type is the permission. `onSubmit` can reject for reasons that are nobody's business on
 * screen — a `TypeError` from a bug, an aborted send the surface has already explained in its own
 * banner with the server's wording — and showing `err.message` for those would put developer text,
 * or a second differently-worded copy of the banner, in front of someone asking for an app. Only
 * this class means "say this out loud".
 *
 * `silent` means "reject, but say nothing", and TWO different situations need it. Both must still
 * reject, because resolving would empty the composer for a press that sent nothing.
 *
 *   1. THE PRESS NOBODY MADE. An identical send is already in flight and this one was swallowed;
 *      the citizen did not knowingly make it, so there is nothing to report.
 *   2. SOMEONE ELSE ALREADY ANSWERED. The surface has put the real explanation on screen — the
 *      server's own sentence in the urgent banner, or a dialog in front of the composer — and a
 *      second, weaker line underneath would be the composer talking over it. `RailComposer` uses
 *      this for its guardrail modal and its held-workspace dialog, and `handleSubmit`'s abort arm
 *      for the banner `fireRelayTurn` has already written.
 *
 * CASE 2 IS WHY THE FLAG IS NOT OPTIONAL DECORATION. The abort arm once rejected with a plain
 * `Error`, on the stated reasoning that its message was "empty of copy" — but a non-`SendRefusal`
 * is not silence here, it is the GENERIC sentence, and that overwrote the specific one the surface
 * had just written. A citizen who attached an over-long PDF was told "try again" instead of the
 * page limit, and trying again could never work.
 *
 * IT LIVES IN ITS OWN MODULE so that `ComposerBox` can test for it with `instanceof`. `Composer`
 * imports `ComposerBox`, so a class exported from `Composer` is not reachable from inside the box
 * without a cycle — which is why that check used to be a duck-typed `err.name === 'SendRefusal'`
 * plus an unchecked cast for `silent`. A leaf module both can import costs nothing and makes the
 * type the permission everywhere, exactly as the paragraph above claims.
 */
export class SendRefusal extends Error {
  readonly silent: boolean
  constructor(message: string, opts: { silent?: boolean } = {}) {
    super(message)
    this.name = 'SendRefusal'
    this.silent = opts.silent ?? false
  }
}
