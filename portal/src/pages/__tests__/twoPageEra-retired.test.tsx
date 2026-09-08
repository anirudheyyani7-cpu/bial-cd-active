/**
 * WHY THIS EXISTS: replaces eleven suites (144 blocks) that pinned six modules this unit
 * deleted — the two-page chat/build split, its data hook, and their supporting UI. Each
 * subject was either replaced (its coverage moved with it) or removed outright, in which case
 * this file is that coverage: an assertion of absence.
 *
 * Where the replaced behaviour is pinned now, so a reader can check nothing was lost:
 *
 *   the send discipline        → `ConversationSurface-projectfirst`, `-composer`, `-persistence`
 *   drag-and-drop + the draft  → `components/chat/__tests__/Composer.test.tsx`
 *   the per-MESSAGE length cap → `utils/__tests__/composerCap.test.ts`
 *   the plan offer             → `components/chat/__tests__/OfferStrip.test.tsx`
 *   the stream reader          → `utils/__tests__/turnStreamApi.test.ts`
 *   the build narrative        → `components/chat/__tests__/ActivityGroup.test.tsx` and, for the
 *                                at-limit half, `utils/__tests__/turnNarrative.test.ts`
 *   the CONVERSATION guardrail → `utils/__tests__/contextLimits.test.ts` (the browser's warning)
 *                                and, server-side now rather than browser-side,
 *                                `backend/tests/api/v1/conversations/test_context_gate.py`
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const THIS_FILE = fileURLToPath(import.meta.url)
const SRC_ROOT = path.resolve(path.dirname(THIS_FILE), '../..')

/** The modules this unit deleted, by the path anything importing them would have used. */
const DELETED = [
  'pages/BuilderPage.tsx',
  'pages/ChatPage.tsx',
  'hooks/useClaudeAPI.ts',
  'components/chat/BuildProgress.tsx',
  'components/chat/PlanOptionsCard.tsx',
  'components/AttachmentLightbox.tsx',
]

/** Every source file, so the import sweep below reads the shipped tree rather than a guess. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      sourceFiles(full, out)
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('the deleted modules are gone and nothing reaches for them', () => {
  it('none of the six files exists', () => {
    for (const rel of DELETED) {
      expect(existsSync(path.join(SRC_ROOT, rel)), `${rel} still exists`).toBe(false)
    }
    // Liveness: every assertion above is an absence, and a `SRC_ROOT` pointing at the wrong
    // directory would make all six pass while proving nothing.
    expect(existsSync(path.join(SRC_ROOT, 'components/chat/ConversationSurface.tsx'))).toBe(true)
  })

  it('no file imports any of them, under any spelling', () => {
    // Excluded: this file names all six itself (the DELETED list above), so it would otherwise
    // flag itself as the offender.
    const files = sourceFiles(SRC_ROOT).filter((f) => f !== THIS_FILE)
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const rel of DELETED) {
        const name = path.basename(rel).replace(/\.(tsx?|jsx?)$/, '')
        // A mock standing in for a deleted module is still a dependency on it — exactly how a
        // suite could go on passing against a module that no longer ships.
        const reach = new RegExp(`(from|require\\(|import\\(|vi\\.mock\\()\\s*['"][^'"]*/${name}['"]`)
        if (reach.test(source)) offenders.push(`${path.relative(SRC_ROOT, file)} → ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('no `kind ===` comparison survives under pages/, checked mechanically', () => {
    // ChatRoute still resolves a kind; what has stopped is anything branching on it.
    // components/workspace/ is scanned too — that's where the deleted branch actually lived.
    for (const rel of ['pages', 'components/workspace']) {
      for (const file of sourceFiles(path.join(SRC_ROOT, rel))) {
        if (file.includes('__tests__')) continue
        const source = readFileSync(file, 'utf8')
        // Matches the KIND VALUES, not a bare `kind ===` — the latter also fires on
        // `typeof row.kind === 'string'`, an unrelated wire-field type guard.
        expect(
          /\bkind\s*===\s*['"](plan|build|builder)['"]/.test(source),
          `${path.relative(SRC_ROOT, file)} branches on a chat's kind`,
        ).toBe(false)
      }
    }
    // Liveness: the kind is still resolved, so the absences above mean "nothing branches on it",
    // not "the concept was deleted and the scan found nothing to look at".
    const route = readFileSync(path.join(SRC_ROOT, 'pages/ChatRoute.tsx'), 'utf8')
    expect(route).toMatch(/kindFromServer/)
  })
})
