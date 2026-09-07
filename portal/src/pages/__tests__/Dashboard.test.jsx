/**
 * The welcome page is gone — this file is its INERTNESS GUARD.
 *
 * `pages/Dashboard.tsx` was a screen whose whole purpose was a button to `/projects`; once the
 * project list carried the summary numbers itself, that hop had nothing left to do, so the page
 * was deleted and `/dashboard` became a redirect. This suite is not deleted alongside it: a
 * removal is only real once nothing can quietly bring it back, so re-adding the page has to be
 * argued for, not merely land beside the new landing screen.
 *
 * IT CHECKS THE FILESYSTEM, not a dynamic import: Vite resolves imports at transform time, so
 * the suite would fail to LOAD rather than report a rejected promise (same reason
 * `jsx-deploy-retirement.test.ts` walks the tree). The route-level half lives in `App.test.jsx`.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PAGES = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SRC = path.dirname(PAGES)

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full)
    return /\.(ts|tsx|js|jsx)$/.test(entry.name) ? [full] : []
  })
}

describe('the welcome page stays deleted', () => {
  it('has no module file', () => {
    for (const ext of ['tsx', 'ts', 'jsx', 'js']) {
      expect(fs.existsSync(path.join(PAGES, `Dashboard.${ext}`))).toBe(false)
    }
  })

  it('is imported by nothing', () => {
    // A stale `vi.mock` or import still naming the deleted path is exactly the kind of
    // leftover this catches — it can pass locally and fail oddly later.
    const offenders = walk(SRC)
      .filter((file) => !file.endsWith(path.join('__tests__', 'Dashboard.test.jsx')))
      .filter((file) => /pages\/Dashboard|pages\\Dashboard/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file))

    expect(offenders).toEqual([])
  })
})
