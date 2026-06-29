import { test, expect } from '@playwright/test'

// The one spec that exercises the REAL UI login (everything else reuses the
// seeded storageState). Start logged OUT by dropping the project's storageState,
// so /login actually renders. One login per run keeps us well under the
// 10 / 15-min login limiter.
test.use({ storageState: { cookies: [], origins: [] } })

test('real UI login lands on the dashboard with no console errors', async ({ page }) => {
  const email = process.env.E2E_QA_EMAIL
  const password = process.env.E2E_QA_PASSWORD
  expect(email, 'E2E_QA_EMAIL must be set (.env.e2e)').toBeTruthy()
  expect(password, 'E2E_QA_PASSWORD must be set (.env.e2e)').toBeTruthy()

  // Baseline health signal: a clean login flow logs nothing to console.error.
  const consoleErrors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  await page.goto('/login')
  await page.getByTestId('login-email').fill(email!)
  await page.getByTestId('login-password').fill(password!)
  await page.getByTestId('login-submit').click()

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 })
  expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0)
})
