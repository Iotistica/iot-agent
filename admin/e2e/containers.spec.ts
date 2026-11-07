import { test, expect } from '@playwright/test'

test.describe('Applications page', () => {
  test('loads without errors', async ({ page, baseURL }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    await page.goto(baseURL + 'applications')

    // Page should render — the container view has a "Check Updates" button when Docker is available,
    // or shows a Docker-unavailable message. Either way the page should load.
    await expect(page.locator('.ant-layout-content')).toBeVisible()

    // No console errors should have fired
    const realErrors = consoleErrors.filter(
      (e) => !e.includes('favicon') && !e.includes('ResizeObserver'),
    )
    expect(realErrors).toHaveLength(0)
  })
})
