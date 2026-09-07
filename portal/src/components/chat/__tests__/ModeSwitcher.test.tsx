/**
 * THE MODE SWITCH IS GONE — this file is its inertness guard.
 *
 * `ModeSwitcher` was the compact in-composer Ask / Plan / Write pill, opened with ⌥P, switching a
 * conversation's `mode` through a server route. Route and client call are both gone; a chat's kind
 * is fixed at creation (`backend/src/api/v1/conversations/schemas.py`), so a switch has nothing
 * left to do, and a control wired to a deleted endpoint gets deleted rather than flagged off.
 *
 * WHY THIS FILE STAYS. Deleting the suite deletes the evidence. It walks the real source tree, not
 * a render, because what is being proven is an ABSENCE: nothing under `portal/src` imports or
 * mounts the component, and the component file itself does not exist.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'

// vitest runs with cwd = the portal root (where vitest.config.ts lives), and import.meta.url is
// a jsdom http URL here — so anchor on cwd, not the module URL (matches jsx-deploy-retirement).
const SRC_ROOT = path.resolve(process.cwd(), 'src')

// WHAT COUNTS AS USING IT is narrower than "the name appears," deliberately. An earlier version
// banned the bare string, but broke on every legitimate "ModeSwitcher used to..." note, and an
// allowlist of exempt files couldn't keep up. The rule instead matches an IMPORT or a MOUNT: the
// only shapes a re-add would actually take, and neither can appear by accident in prose.
const USES_IT = [
  /from\s+['"][^'"]*ModeSwitcher['"]/, // import … from '…/ModeSwitcher'
  /require\(\s*['"][^'"]*ModeSwitcher['"]/, // require('…/ModeSwitcher')
  /import\(\s*['"][^'"]*ModeSwitcher['"]/, // a dynamic import of it
  /<ModeSwitcher[\s/>]/, // <ModeSwitcher … /> — the mount
  /vi\.mock\(\s*['"][^'"]*ModeSwitcher['"]/, // a mock standing in for it is still a dependency
]

// The guard itself writes those patterns down, so it would match every one of them.
const ALLOWLIST = new Set([path.join('components', 'chat', '__tests__', 'ModeSwitcher.test.tsx')])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

describe('ModeSwitcher is retired', () => {
  it('the component file is gone from disk', () => {
    expect(existsSync(path.join(SRC_ROOT, 'components', 'chat', 'ModeSwitcher.tsx'))).toBe(false)
  })

  it('no source file imports or mounts it', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const file of walk(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file)
      if (ALLOWLIST.has(rel)) continue
      scanned += 1
      const text = readFileSync(file, 'utf8')
      if (USES_IT.some((pattern) => pattern.test(text))) offenders.push(rel)
    }
    // LIVENESS: the walk actually read the tree — an empty `offenders` proves nothing if `walk`
    // returned nothing, which a wrong `SRC_ROOT` would otherwise make pass forever, silently.
    expect(scanned).toBeGreaterThan(100)
    expect(offenders).toEqual([])
  })

  it('the guard would CATCH a re-add — each pattern matches the shape it is for', () => {
    // The half that stops this from being a guard nobody has tested. An absence test whose
    // matcher is subtly wrong reports the same clean result as a genuine absence.
    const reAdds = [
      "import { ModeSwitcher } from '../chat/ModeSwitcher'",
      "const { ModeSwitcher } = require('./ModeSwitcher')",
      "const M = await import('../../components/chat/ModeSwitcher')",
      '<ModeSwitcher value={kind} onSelect={setKind} />',
      "vi.mock('../../components/chat/ModeSwitcher', () => ({}))",
    ]
    for (const line of reAdds) {
      expect(USES_IT.some((pattern) => pattern.test(line)), line).toBe(true)
    }
    // Prose about the retired control is NOT a re-add — the whole point of the narrowing above.
    const prose = [
      '// The ModeSwitcher used to sit here; a chat kind is fixed at creation now.',
      "  * mounted on both `BuilderPage` and `ProjectBuilder` — see ModeSwitcher's guard.",
    ]
    for (const line of prose) {
      expect(USES_IT.some((pattern) => pattern.test(line)), line).toBe(false)
    }
  })
})
