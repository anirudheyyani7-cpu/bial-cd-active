import { test, expect } from '@playwright/test'

const PPTX_MT = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

// Client-side rejections — no network, no model, identical in dev and container.
// Fixtures are in-memory buffers (no committed binaries): the rejection is decided
// by extension/size before any upload, so the bytes need not be valid OOXML.
test.describe('deck attachment rejections (client-side)', () => {
  test('legacy .ppt is rejected with the "save as .pptx" message (no PDF mention)', async ({ page }) => {
    await page.goto('/chat')

    await page.getByTestId('chat-file-input').setInputFiles({
      name: 'legacy.ppt',
      mimeType: 'application/vnd.ms-powerpoint',
      buffer: Buffer.from('legacy-binary-ppt'),
    })

    // The honest message must NOT reveal the internal PDF conversion.
    const toast = page.getByText('save as .pptx and re-upload')
    await expect(toast).toBeVisible()
    await expect(toast).not.toContainText(/pdf/i)

    // No chip was added and no assistant turn was generated.
    await expect(page.getByText('legacy.ppt')).toHaveCount(0)
    await expect(page.getByTestId('assistant-message')).toHaveCount(0)
  })

  test('oversize .pptx (> 4 MB) is rejected and generates no assistant turn', async ({ page }) => {
    await page.goto('/chat')

    await page.getByTestId('chat-file-input').setInputFiles({
      name: 'oversize.pptx',
      mimeType: PPTX_MT,
      buffer: Buffer.alloc(4 * 1024 * 1024 + 128 * 1024), // ~4.1 MB > 4 MB cap
    })

    await expect(page.getByText('exceeds the 4 MB limit')).toBeVisible()
    await expect(page.getByText('oversize.pptx')).toHaveCount(0)
    await expect(page.getByTestId('assistant-message')).toHaveCount(0)
  })
})
