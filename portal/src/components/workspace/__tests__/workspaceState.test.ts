/**
 * THE ONE WORKSPACE STATE (Plan F, U2) — what the platform reports, turned into what a person
 * reads and what they may press.
 *
 * WHAT THESE TESTS CAN AND CANNOT PROVE, said up front because the distinction is the unit's
 * whole point. They prove the CLIENT's vocabulary: that no arm of this map reaches a destructive
 * verb, that a sentence says what the register requires, that a withheld attribution renders no
 * empty quotes. They prove nothing about what `POST /relaunch` does when a word is pressed — that
 * is server behaviour, asserted in `backend/tests/api/v1/build_sessions/`, and a client test
 * saying "this made no restore call" would pass in exactly the state that loses work.
 *
 * The copy assertions are deliberately literal. R-16 was a client call on exact wording, and a
 * test that matched loosely would let the sentence drift back to the negation it was chosen to
 * replace.
 */
import { describe, it, expect } from 'vitest'
import {
  LAUNCH_LABEL,
  isTerminalReading,
  resolveWorkspaceState,
  sameWorkspaceState,
  type WorkspaceInputs,
  type WorkspaceState,
} from '../workspaceState'
import type { PreviewState } from '../../../utils/buildSessionApi'

/** A preview-state read, in the shape the wire parser produces one. */
function reading(over: Partial<PreviewState> = {}): PreviewState {
  return {
    state: 'asleep',
    alive: false,
    previewUrl: null,
    occupyingProjectName: null,
    occupyingProjectId: null,
    restorable: null,
    ...over,
  }
}

function resolve(over: Partial<WorkspaceInputs> = {}) {
  return resolveWorkspaceState({
    preview: reading(),
    projectHasSavedBuild: null,
    startOutcome: null,
    startInFlight: false,
    ...over,
  })
}

/**
 * Everything a surface would put on screen for this value, as one string.
 *
 * ALL FOUR SLOTS, not just the two the map had before `#196`. A sweep that read only the headline,
 * the detail and the first action would have gone on passing while the take-back's label and the
 * stopped-holder note said whatever they liked — which is exactly the class of miss the register
 * assertions below exist to catch.
 */
const rendered = (over: Partial<WorkspaceInputs> = {}) => {
  const state = resolve(over)
  return [
    state.headline,
    state.detail ?? '',
    state.note ?? '',
    state.action?.label ?? '',
    state.secondAction?.label ?? '',
  ].join(' ')
}

/** A workspace held by a named project — the arm `#196` gives a second control to. */
const heldBy = (name = 'Car pool apps', id = 'proj-9') =>
  reading({ state: 'slot_taken', occupyingProjectName: name, occupyingProjectId: id })

describe('the register — what the pane may and may not say', () => {
  it('AE1: a saved, not-running project says "Your app is saved." and offers exactly one start', () => {
    const state = resolve({ preview: reading({ state: 'asleep', restorable: true }) })

    expect(state.name).toBe('not-running')
    // VERBATIM. R-16 was a client call on this exact sentence — full stop after "saved", and no
    // negation of any kind after it.
    expect(state.headline).toBe('Your app is saved.')
    expect(state.action).toEqual({ kind: 'start', label: 'Launch Application' })
  })

  it('names no negative state anywhere in what it renders', () => {
    // ASSERTED OVER THE WHOLE RENDERED TEXT, not over the headline, so a fourth negative phrasing
    // added to the detail line later fails a test rather than a review. `not running` stays alive
    // as an internal state name and on the wire; it is never a thing a person reads.
    //
    // ★ ONE FIELD IS OUT OF SCOPE, AND IT IS A NARROWING OF THE SUBJECT RATHER THAN OF THE RULE.
    // R-16 forbids the pane describing THIS app by what it is not — "saved", never "stopped". The
    // `note` `#196` adds is never about this app: its subject is always ANOTHER project, and D2
    // requires in as many words that any ending which stopped the holder says so. Using a softer
    // verb there would also be a second word for the thing the citizen just pressed a button
    // labelled "Stop" to do. The next block pins that carve-out so it cannot quietly widen.
    const forbidden = [/not running/i, /\bstopped\b/i, /unavailable/i, /preview/i]
    const everyState: Partial<WorkspaceInputs>[] = [
      { preview: reading({ state: 'asleep', restorable: true }) },
      { preview: reading({ state: 'asleep', restorable: false }) },
      { preview: reading({ state: 'never_built', restorable: false }) },
      { preview: reading({ state: 'starting' }) },
      { preview: reading({ state: 'alive', alive: true }) },
      { preview: reading({ state: 'unknown' }) },
      { preview: null },
      {
        preview: reading({
          state: 'slot_taken',
          occupyingProjectName: 'Car pool apps',
          occupyingProjectId: 'proj-9',
        }),
      },
      { preview: reading({ state: 'slot_taken' }) },
      { preview: reading({ state: 'asleep' }), startOutcome: { kind: 'not-painted' } },
      { preview: reading({ state: 'asleep' }), startOutcome: { kind: 'timed-out' } },
      { preview: reading({ state: 'asleep' }), startOutcome: { kind: 'failed', reason: 'no image' } },
      {
        preview: reading({
          state: 'slot_taken',
          occupyingProjectName: 'Car pool apps',
          occupyingProjectId: 'proj-9',
        }),
        startOutcome: { kind: 'take-back-failed', reason: 'no image', stoppedHolder: 'Car pool apps' },
      },
    ]

    for (const inputs of everyState) {
      const state = resolve(inputs)
      // Everything whose subject is this citizen's own app: the two sentences, and both labels.
      const text = [
        state.headline,
        state.detail ?? '',
        state.action?.label ?? '',
        state.secondAction?.label ?? '',
      ].join(' ')
      for (const phrase of forbidden) {
        expect(`${JSON.stringify(inputs.preview?.state ?? null)}: ${text}`).not.toMatch(phrase)
      }
    }
  })

  it('★ and the one carve-out stays exactly one field wide', () => {
    // The note is the only place "stopped" may appear, it appears only where a take-back stopped
    // somebody, and it names them. Written as its own assertion so that widening the carve-out —
    // by moving that sentence into `detail`, say — fails here rather than passing the sweep above
    // on a technicality.
    const stopped = resolve({
      preview: heldBy('Roster', 'p-9'),
      startOutcome: { kind: 'take-back-failed', reason: 'Could not save your work', stoppedHolder: 'Roster' },
    })

    expect(stopped.note).toMatch(/\bstopped\b/)
    expect(stopped.note).toContain('“Roster”')
    expect(`${stopped.headline} ${stopped.detail ?? ''}`).not.toMatch(/\bstopped\b/i)
  })

  it('AE2: nothing built invites a description and offers NO action', () => {
    const state = resolve({ preview: reading({ state: 'never_built', restorable: false }) })

    expect(state.name).toBe('never-built')
    expect(state.action).toBeNull()
    // An invitation, not a report of an absence.
    expect(state.headline).toMatch(/describe what you want to build/i)
  })

  it('AE36: the starting sentence carries no digits and no duration word', () => {
    // R4a taken literally. Nobody has measured a cold start, so no sentence may name one — the
    // canvas's "about thirty seconds" and the register's "about half a minute" are both dropped.
    const text = rendered({ preview: reading({ state: 'starting' }) })

    expect(text).not.toMatch(/\d/)
    expect(text).not.toMatch(
      /\b(second|seconds|minute|minutes|moment|moments|hour|hours|soon|shortly|about|roughly|approximately|quick|quickly)\b/i,
    )
    expect(resolve({ preview: reading({ state: 'starting' }) }).action).toBeNull()
  })
})

describe('the hand-over states — two arms, and neither is an error', () => {
  it('AE31: with a name and an id, it names that project and offers the way to it', () => {
    const state = resolve({
      preview: reading({
        state: 'slot_taken',
        occupyingProjectName: 'Car pool apps',
        occupyingProjectId: 'proj-9',
      }),
    })

    expect(state.name).toBe('held-by-another-project')
    expect(state.headline).toContain('Car pool apps')
    expect(state.action).toEqual({
      kind: 'go-to-project',
      label: 'Open “Car pool apps”',
      projectId: 'proj-9',
    })
  })

  it('AE31: with the attribution withheld, it names none, quotes nothing and offers no action', () => {
    // A first-class wire state, not a bug to paper over: the server declines to attribute a
    // container it cannot map to a project this person owns. The failure this is written against
    // is a sentence with an empty pair of quotes in it.
    const state = resolve({ preview: reading({ state: 'slot_taken' }) })

    expect(state.name).toBe('held-unattributed')
    expect(state.action).toBeNull()
    expect(rendered({ preview: reading({ state: 'slot_taken' }) })).not.toMatch(/[“"]\s*[”"]/)
    expect(state.headline).toMatch(/another project is using your workspace/i)
  })

  it('offers no go-to when only half the attribution arrived — a button to nowhere is worse', () => {
    const nameOnly = resolve({
      preview: reading({ state: 'slot_taken', occupyingProjectName: 'Roster' }),
    })
    const idOnly = resolve({ preview: reading({ state: 'slot_taken', occupyingProjectId: 'p-9' }) })

    expect(nameOnly.action).toBeNull()
    expect(idOnly.action).toBeNull()
  })

  it('a held slot outranks a start outcome — the remedy, never a retry (R4b)', () => {
    // A retry against an occupied slot can only fail the same way again.
    const state = resolve({
      preview: reading({
        state: 'slot_taken',
        occupyingProjectName: 'Roster',
        occupyingProjectId: 'p-9',
      }),
      startOutcome: { kind: 'timed-out' },
    })

    expect(state.action?.kind).toBe('go-to-project')
  })
})

describe('★ taking the workspace back (#196) — the second control, and D2`s five endings', () => {
  it('★ the held arm offers TWO controls, and the first is untouched', () => {
    // The owner`s decision on #196: `Open “<holder>”` stays exactly as it is. The take-back is an
    // ALTERNATIVE to it, not a replacement — a citizen who wants to go and finish what they were
    // doing over there still has the one-click way to.
    const state = resolve({ preview: heldBy() })

    expect(state.action).toEqual({
      kind: 'go-to-project',
      label: 'Open “Car pool apps”',
      projectId: 'proj-9',
    })
    expect(state.secondAction).toEqual({
      kind: 'take-back',
      label: 'Stop “Car pool apps” and open this app instead',
    })
  })

  it('★ the take-back carries no id of its own — the holder comes off the refusal', () => {
    // Deliberate, and the reason is the ending where a held id would be WRONG: another tab taking
    // the freed slot mid-sequence. The reading names the old holder; the server`s refusal names
    // the new one, and carries the `dirty` tri-state the dialog`s copy arms need besides.
    const second = resolve({ preview: heldBy() }).secondAction
    expect(second).not.toBeNull()
    expect(JSON.stringify(second)).not.toContain('proj-9')
  })

  it('★ the UNATTRIBUTED arm still offers nothing at all', () => {
    // Structural, not an oversight: both controls NAME the project they act on, and agreeing to
    // stop an app the platform has just admitted it cannot identify is the one place where naming
    // none costs somebody work rather than a click.
    const state = resolve({ preview: reading({ state: 'slot_taken' }) })

    expect(state.name).toBe('held-unattributed')
    expect(state.action).toBeNull()
    expect(state.secondAction ?? null).toBeNull()
    // LIVENESS: it still says something, so this is a withheld action rather than a blank arm.
    expect(state.headline.length).toBeGreaterThan(0)
  })

  it('★ ENDING 1 — a stop that failed returns to held and carries the server`s own sentence', () => {
    // `buildSessionApi.ts` authors the two-minute ceiling sentence, it is true only on this
    // ending, and the map does not rewrite it. Nothing was stopped, so nothing is said about the
    // holder having been.
    const ceiling =
      'The other app is still saving its work. Nothing has changed — give it a moment and try again.'
    const state = resolve({
      preview: heldBy('Roster', 'p-9'),
      startOutcome: { kind: 'take-back-failed', reason: ceiling, stoppedHolder: null },
    })

    expect(state.name).toBe('held-by-another-project')
    expect(state.detail).toBe(ceiling)
    expect(state.note ?? null).toBeNull()
    // Both ways out are still offered — the ending changed what is said, not what may be pressed.
    expect(state.action?.kind).toBe('go-to-project')
    expect(state.secondAction?.kind).toBe('take-back')
  })

  for (const [ending, reason] of [
    ['ENDING 3 — the save failed', 'Could not save your work'],
    ['ENDING 4 — the save worked and the release failed', 'Could not close the other workspace'],
  ] as const) {
    it(`★ ${ending}: held, plus the line saying the holder is down`, () => {
      // `handOverWorkspace` REJECTS RATHER THAN SWALLOWS, so a failed save is never followed by a
      // release: the holder is stopped and the slot is still held. Two facts, and the headline
      // alone tells the citizen neither of them.
      const state = resolve({
        preview: heldBy('Roster', 'p-9'),
        startOutcome: { kind: 'take-back-failed', reason, stoppedHolder: 'Roster' },
      })

      expect(state.name).toBe('held-by-another-project')
      expect(state.detail).toBe(reason)
      expect(state.note).toBe('“Roster” was stopped, and it still holds your workspace.')
    })
  }

  it('★ and never reuses ending 1`s "nothing has changed" where it would be false', () => {
    // The holder is DOWN on both of these. A sentence promising nothing moved is the one thing
    // this arm must not say — D2 names it explicitly.
    for (const reason of ['Could not save your work', 'Could not close the other workspace']) {
      const text = rendered({
        preview: heldBy('Roster', 'p-9'),
        startOutcome: { kind: 'take-back-failed', reason, stoppedHolder: 'Roster' },
      })
      expect(text).not.toMatch(/nothing has changed/i)
    }
  })

  it('★ ENDING 2 — the slot was freed and the start failed: the failed-to-start sentence, plus the holder', () => {
    // D2 supersedes the acceptance example here. "Returns to the held-by-another state" is
    // unreachable: the release succeeded, so the holder is gone and the reading is no longer
    // `slot_taken`. What is left is an ordinary failed start — with one extra thing to say.
    const state = resolve({
      preview: reading({ state: 'asleep', restorable: true }),
      startOutcome: { kind: 'take-back-failed', reason: 'the image could not be pulled', stoppedHolder: 'Roster' },
    })

    expect(state.name).toBe('start-failed')
    expect(state.headline).toBe('We could not start your app.')
    expect(state.detail).toBe('the image could not be pulled')
    expect(state.note).toBe('“Roster” was stopped.')
    // The remedy is unchanged: the same Try again every other start ending offers.
    expect(state.action?.kind).toBe('retry')
  })

  it('says nothing about a holder it never stopped, even on the freed arm', () => {
    const state = resolve({
      preview: reading({ state: 'asleep', restorable: true }),
      startOutcome: { kind: 'take-back-failed', reason: 'the image could not be pulled', stoppedHolder: null },
    })
    expect(state.note ?? null).toBeNull()
    // LIVENESS: it still reports the failure it does know about.
    expect(state.detail).toBe('the image could not be pulled')
  })

  it('★ every OTHER start outcome is still outranked by a held slot (R4b)', () => {
    // The precedence is unchanged for the three endings that describe an ordinary start. Only the
    // take-back ending crosses it, because it describes a press made FROM this arm.
    for (const startOutcome of [
      { kind: 'timed-out' },
      { kind: 'not-painted' },
      { kind: 'failed', reason: 'no image' },
    ] as const) {
      const state = resolve({ preview: heldBy('Roster', 'p-9'), startOutcome })
      expect(state.name).toBe('held-by-another-project')
      expect(state.detail).toBe('You have one workspace at a time. Open that project to pick up where you left off.')
      expect(state.note ?? null).toBeNull()
    }
  })

  it('★ the comparator sees BOTH new fields, and each one on its own', () => {
    // The channel skips a publish when `sameWorkspaceState` says two readings render identically,
    // and both new fields are things a citizen reads. ISOLATED DELIBERATELY: the obvious pair —
    // two different holders — differs in the headline and in the first action's label too, so a
    // comparator that had never heard of either new field still calls them different and the test
    // passes vacuously. Each assertion below moves exactly one field.

    // THE NOTE, alone: the same failing take-back, told apart only by whether it got as far as
    // stopping the holder. Same name, same headline, same server prose.
    const failed = (stoppedHolder: string | null) =>
      resolve({
        preview: heldBy('Roster', 'p-9'),
        startOutcome: { kind: 'take-back-failed', reason: 'Could not save your work', stoppedHolder },
      })
    expect(failed(null).headline).toBe(failed('Roster').headline)
    expect(failed(null).detail).toBe(failed('Roster').detail)
    expect(sameWorkspaceState(failed(null), failed('Roster'))).toBe(false)

    // THE SECOND SLOT, alone. Hand-built, because the map ties the take-back's label to the holder
    // name that is also in the headline — and the comparator's contract is over the TYPE, not over
    // whichever combinations one arm happens to produce today.
    const held = resolve({ preview: heldBy('Roster', 'p-9') })
    expect(sameWorkspaceState(held, held)).toBe(true)
    expect(sameWorkspaceState(held, { ...held, secondAction: null })).toBe(false)
    expect(
      sameWorkspaceState(held, { ...held, secondAction: { kind: 'take-back', label: 'Stop it' } }),
    ).toBe(false)
    // An omitted optional and an explicit `null` are the same claim, and must compare equal.
    const { secondAction: _s, note: _n, ...bare } = held
    expect(sameWorkspaceState({ ...bare, secondAction: null, note: null }, bare)).toBe(true)
  })
})

describe('R4b — a start that did not end in a running app says which way it ended', () => {
  it('AE3: an unreadable state answers "we could not check" and offers the retry member', () => {
    const state = resolve({ preview: reading({ state: 'unknown' }) })

    expect(state.name).toBe('could-not-read')
    expect(state.action?.kind).toBe('retry')
  })

  it('gives the three endings three distinct sentences, all landing on retry', () => {
    const notPainted = resolve({ startOutcome: { kind: 'not-painted' } })
    const timedOut = resolve({ startOutcome: { kind: 'timed-out' } })
    const failed = resolve({ startOutcome: { kind: 'failed', reason: 'the image could not be pulled' } })

    expect([notPainted.name, timedOut.name, failed.name]).toEqual([
      'not-painted',
      'timed-out',
      'start-failed',
    ])
    for (const state of [notPainted, timedOut, failed]) expect(state.action?.kind).toBe('retry')
    // Three sentences, not one shrug wearing three names.
    expect(new Set([notPainted.headline, timedOut.headline, failed.headline]).size).toBe(3)
  })

  it("carries the server's named reason verbatim rather than rewriting it", () => {
    const state = resolve({ startOutcome: { kind: 'failed', reason: 'the image could not be pulled' } })
    expect(state.detail).toBe('the image could not be pulled')
  })

  it('a live read outranks a stale start outcome — reaching alive IS the start succeeding', () => {
    const state = resolve({
      preview: reading({ state: 'alive', alive: true }),
      startOutcome: { kind: 'timed-out' },
    })
    expect(state.name).toBe('running')
  })
})

describe('the restore question, and the one answer that suppresses the start control', () => {
  it('falls through a null `restorable` to the project row rather than retracting its claim', () => {
    // `??`, never `||`: the tri-state's null is "no claim" — the object store was unreachable —
    // and treating it as "no" would retract an answer the project row already gave confidently.
    const state = resolve({
      preview: reading({ state: 'asleep', restorable: null }),
      projectHasSavedBuild: true,
    })
    expect(state.name).toBe('not-running')
    expect(state.action?.kind).toBe('start')
  })

  it('a definite `false` suppresses the start — the endpoint would only 404 there', () => {
    // The server holds neither a recovery copy nor a saved bundle, so "Launch Application" is a
    // button whose only outcome is an error. What is left is the same affordance as a project with
    // nothing built: ask for the app.
    const state = resolve({ preview: reading({ state: 'asleep', restorable: false }) })

    expect(state.name).toBe('never-built')
    expect(state.action).toBeNull()
  })

  it('a fresher `restorable` outranks a stale project row in both directions', () => {
    expect(
      resolve({
        preview: reading({ state: 'asleep', restorable: false }),
        projectHasSavedBuild: true,
      }).action,
    ).toBeNull()
    expect(
      resolve({
        preview: reading({ state: 'never_built', restorable: true }),
        projectHasSavedBuild: false,
      }).action?.kind,
    ).toBe('start')
  })
})

describe('the properties that hold across every input', () => {
  it('names no destructive verb in any arm', () => {
    // The type is the real enforcement — the union has three members and none of them is a
    // teardown — but a sentence can still say a dangerous word, and this is what catches that.
    const destructive = /\b(restore|restoring|rebuild|rebuilding|reset|delete|deleting|destroy|tear down|teardown|discard|wipe|erase)\b/i
    const states: (PreviewState | null)[] = [
      null,
      reading({ state: 'alive', alive: true }),
      reading({ state: 'starting' }),
      reading({ state: 'unknown' }),
      reading({ state: 'asleep', restorable: true }),
      reading({ state: 'asleep', restorable: false }),
      reading({ state: 'never_built', restorable: null }),
      reading({ state: 'slot_taken', occupyingProjectName: 'A', occupyingProjectId: 'p' }),
      reading({ state: 'slot_taken' }),
    ]
    const outcomes = [
      null,
      { kind: 'not-painted' },
      { kind: 'timed-out' },
      { kind: 'failed', reason: 'x' },
      { kind: 'take-back-failed', reason: 'x', stoppedHolder: null },
      { kind: 'take-back-failed', reason: 'x', stoppedHolder: 'Roster' },
    ] as const

    for (const preview of states) {
      for (const startOutcome of outcomes) {
        for (const projectHasSavedBuild of [true, false, null]) {
          const state = resolveWorkspaceState({ preview, projectHasSavedBuild, startOutcome, startInFlight: false })
          const text = `${state.headline} ${state.detail ?? ''} ${state.note ?? ''} ${state.action?.label ?? ''} ${state.secondAction?.label ?? ''}`
          expect(`${state.name}: ${text}`).not.toMatch(destructive)
          // Every arm says something, and offers at most one thing to press plus at most one
          // alternative — never a third.
          expect(state.headline.length).toBeGreaterThan(0)
          expect(['start', 'retry', 'go-to-project', undefined]).toContain(state.action?.kind)
          expect(['take-back', undefined]).toContain(state.secondAction?.kind)
          // ONLY THE HELD ARM HAS EVER FILLED THE SECOND SLOT, and only ever beside a first.
          if (state.secondAction) {
            expect(state.name).toBe('held-by-another-project')
            expect(state.action).not.toBeNull()
          }
        }
      }
    }
  })

  it('carries no address — the map answers what to SAY, never what to frame', () => {
    // Framing `PreviewState.previewUrl` because it is conveniently in hand silently drops the top
    // of the address precedence: the live turn's preview, which is the app being built in front of
    // the person. There is no field here to put a URL in, which is the enforcement.
    const state = resolve({
      preview: reading({ state: 'alive', alive: true, previewUrl: 'https://app.example/' }),
    })

    expect(JSON.stringify(state)).not.toContain('https://app.example/')
  })

  it('★ EVERY arm carries the whole key set, so the map stays total over the optional two', () => {
    // `secondAction` and `note` are OPTIONAL in the type, so the suites that hand-build a state
    // need not restate two nulls (three files do, and making them required is a compile break in
    // files this unit may not touch). That optionality is exactly why the map has to be pinned
    // here instead: TypeScript will not notice an arm that forgets one.
    //
    // IT IS PINNED OVER EVERY ARM, NOT ONE. This assertion used to run against a single `alive`
    // resolve while its comment claimed "an arm that forgets one fails here" — which was true of
    // that arm and of nothing else. Nine of the ten arms could have dropped a key with the suite
    // green. The inputs below reach all ten; `expectedNames` is asserted too, so an input that
    // stops reaching its arm fails loudly rather than quietly shrinking the coverage.
    const KEYS = ['action', 'busy', 'detail', 'headline', 'name', 'note', 'secondAction']

    const arms: Array<[string, WorkspaceState]> = [
      ['running', resolve({ preview: reading({ state: 'alive', alive: true }) })],
      ['starting', resolve({ preview: reading({ state: 'starting' }) })],
      ['never-built', resolve({ preview: reading({ state: 'never_built', restorable: false }) })],
      ['not-running', resolve({ preview: reading({ state: 'asleep', restorable: true }) })],
      ['could-not-read', resolve({ preview: null })],
      [
        'held-by-another-project',
        resolve({
          preview: reading({
            state: 'slot_taken',
            occupyingProjectName: 'Roster',
            occupyingProjectId: 'p-9',
          }),
        }),
      ],
      ['held-unattributed', resolve({ preview: reading({ state: 'slot_taken' }) })],
      ['not-painted', resolve({ startOutcome: { kind: 'not-painted' } })],
      ['timed-out', resolve({ startOutcome: { kind: 'timed-out' } })],
      ['start-failed', resolve({ startOutcome: { kind: 'failed', reason: 'no image' } })],
    ]

    // Liveness first: the inputs really do reach ten DISTINCT arms. Without this the loop below
    // could pass while every entry resolved to the same fallback.
    expect(new Set(arms.map(([, s]) => s.name)).size).toBe(10)
    for (const [expectedName, armState] of arms) {
      expect(armState.name).toBe(expectedName)
      expect(Object.keys(armState).sort()).toEqual(KEYS)
    }
  })

  it('answers even before the platform has said anything', () => {
    // Not an empty pane: the honest sentence before the first read is that we have not asked yet,
    // and the retry is the only thing a person can usefully do with that.
    const state = resolve({ preview: null })
    expect(state.name).toBe('could-not-read')
    expect(state.action?.kind).toBe('retry')
  })

  it('exports the start label from one place so no surface can spell it differently', () => {
    expect(LAUNCH_LABEL).toBe('Launch Application')
  })
})

describe('isTerminalReading — when re-asking can only hear the same sentence again', () => {
  it('ends the asking on a settled state with a decided restore answer', () => {
    for (const state of ['asleep', 'slot_taken', 'never_built'] as const) {
      expect(isTerminalReading(reading({ state, restorable: true }))).toBe(true)
      expect(isTerminalReading(reading({ state, restorable: false }))).toBe(true)
    }
  })

  it('keeps asking while `restorable` is still null — a half answer is not an answer', () => {
    // Ending there pins the one sentence this must never say wrongly over a workspace sitting
    // safely on Blob, with no timer left to correct it.
    for (const state of ['asleep', 'slot_taken', 'never_built'] as const) {
      expect(isTerminalReading(reading({ state, restorable: null }))).toBe(false)
    }
  })

  it('never ends on an answer that decided nothing', () => {
    expect(isTerminalReading(reading({ state: 'unknown', restorable: true }))).toBe(false)
    expect(isTerminalReading(reading({ state: 'alive', restorable: true }))).toBe(false)
    expect(isTerminalReading(reading({ state: 'starting', restorable: true }))).toBe(false)
  })
})
