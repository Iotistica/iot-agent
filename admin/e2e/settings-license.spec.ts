import { test, expect } from '@playwright/test'

test.describe('Settings — License tab', () => {
  test('shows license status card', async ({ page, baseURL }) => {
    await page.goto(baseURL + 'settings')

    // Click the License tab
    await page.locator('.ant-tabs-tab', { hasText: 'License' }).click()

    // License Status card should be visible
    await expect(page.getByText('License Status')).toBeVisible({ timeout: 5_000 })

    // Should show a state badge (unlicensed, trial, or paid)
    const stateBadge = page.locator('.ant-badge-status-text, .ant-tag')
    await expect(stateBadge.first()).toBeVisible()
  })
})
