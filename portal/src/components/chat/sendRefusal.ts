/**
 * A refusal whose message was WRITTEN FOR THE CITIZEN — the type IS the permission. Other
 * `onSubmit` rejections (a `TypeError`, an already-explained abort) must never surface via
 * `err.message`; only this class means "say this out loud". `silent` marks an in-flight
 * duplicate press: nothing to report, but still rejects so the composer doesn't empty for a
 * press that sent nothing. Lives in its OWN module so `ComposerBox` can `instanceof`-check
 * it without a cycle through `Composer` — replaces a duck-typed `err.name` check.
 */
export class SendRefusal extends Error {
  readonly silent: boolean
  constructor(message: string, opts: { silent?: boolean } = {}) {
    super(message)
    this.name = 'SendRefusal'
    this.silent = opts.silent ?? false
  }
}
