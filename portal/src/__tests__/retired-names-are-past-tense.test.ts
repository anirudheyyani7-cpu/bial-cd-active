/**
 * The final link in this repo's removal convention: once code, tests, and imports are gone,
 * human-facing prose (comments included) must still read as history, not present tense. A
 * retired name may appear when it explains why code is shaped the way it is, but the sentence
 * around it must say the thing is gone.
 *
 * Marker-list matching, not real prose analysis, is deliberate: cheap enough to stay, and wrong
 * in the harmless direction — a miss, not a false alarm. Test files are excluded; a `*-retired`
 * test file legitimately narrates what it retired.
 *
 * ABSENCE GUARD: adding a word to either list below changes what the whole source tree is
 * scanned for and can turn an unrelated edit elsewhere red. Treat both as fixed data.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const SRC_ROOT = path.resolve(process.cwd(), 'src')

/** Unambiguous identifiers only — a generic word like "relay" appears in live contexts and
 *  would only produce noise. */
const RETIRED = [
  'ChatPage',
  'BuilderPage',
  'useClaudeAPI',
  'fetchClaudeStream',
  'BuildProgress',
  '/v1/claude',
] as const

/** Deliberately generous: a miss is cheaper than a false alarm. */
const HISTORICAL = [
  'used to',
  'was ',
  'were ',
  'had ',
  'died',
  'dies with',
  'deleted',
  'retired',
  'removed',
  'gone',
  'no longer',
  'until',
  'before',
  'predates',
  'legacy',
  'old ',
  'since',
  're-homed',
  'replaced',
  'gained',
  'gave',
  'gets this',
  'gone with',
]

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : walk(full)
    return /\.(ts|tsx|js|jsx)$/.test(entry) && !/\.test\./.test(entry) ? [full] : []
  })
}

/** The mention's line plus two either side — a comment sentence rarely fits on one line. */
function windowAround(lines: string[], index: number): string {
  return lines
    .slice(Math.max(0, index - 2), index + 3)
    .join(' ')
    .toLowerCase()
}

describe('retired names read as history', () => {
  it('no production file mentions a retired name in the present tense', () => {
    const offenders: string[] = []
    for (const file of walk(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file)
      if (rel === path.join('__tests__', 'retired-names-are-past-tense.test.ts')) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const name of RETIRED) {
          if (!line.includes(name)) continue
          const context = windowAround(lines, i)
          if (!HISTORICAL.some((marker) => context.includes(marker))) {
            offenders.push(`${rel}:${i + 1}: ${name} — ${line.trim().slice(0, 90)}`)
          }
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('the guard can actually fail — a present-tense mention is reported', () => {
    // Mutation-proofing. If the marker list ever grew to match everything, the check above
    // would be green forever and this file would be worse than nothing.
    const present = ['// BuilderPage relays them to the harness.']
    const historical = ['// BuilderPage was the page that matched, and it was deleted.']
    const flags = (lines: string[]) =>
      !HISTORICAL.some((m) => windowAround(lines, 0).includes(m)) && lines[0].includes('BuilderPage')
    expect(flags(present)).toBe(true)
    expect(flags(historical)).toBe(false)
  })
})
