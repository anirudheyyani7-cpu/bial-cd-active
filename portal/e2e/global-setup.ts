import type { FullConfig } from '@playwright/test'

// Health-gate the target before any spec runs. GET /preview is an unauthenticated
// 200 (also the Dockerfile healthcheck), so it is the readiness signal for both
// the dev stack and the container. Budget ~120s for container boot + LibreOffice
// warmup. A never-ready target fails fast here with a clear message instead of
// every spec failing on an auth redirect that masquerades as a packaging bug.
async function globalSetup(_config: FullConfig) {
  const baseURL = process.env.E2E_BASE_URL || 'http://localhost:5173'
  const target = `${baseURL.replace(/\/$/, '')}/preview`
  const deadlineMs = Date.now() + 120_000
  let lastErr = 'no attempt'

  while (Date.now() < deadlineMs) {
    try {
      const res = await fetch(target)
      if (res.ok) return
      lastErr = `status ${res.status}`
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 1500))
  }

  throw new Error(`global-setup: ${target} never returned 200 within 120s (last: ${lastErr}). ` +
    'Is the dev stack (npm run dev:full) or the container up?')
}

export default globalSetup
