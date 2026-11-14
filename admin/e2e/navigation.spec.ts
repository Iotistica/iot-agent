import { test, expect } from '@playwright/test'

const pages = [
  { name: 'Dashboard', path: '/dashboard' },
  { name: 'Sources', path: '/sources' },
  { name: 'Destinations', path: '/destinations' },
  { name: 'Applications', path: '/applications' },
  { name: 'Settings', path: '/settings' },
]

test.describe('Sidebar navigation', () => {
  for (const pg of pages) {
    test(`navigates to ${pg.name}`, async ({ page, baseURL }) => {
      await page.goto(baseURL + 'dashboard')
      await page.locator('.ant-menu-item', { hasText: pg.name }).click()
      await expect(page).toHaveURL(new RegExp(pg.path))
      await expect(page.locator('.ant-layout-content')).toBeVisible()
    })
  }

  test('redirects the old Devices route to connected devices in Sources', async ({ page, baseURL }) => {
    await page.goto(baseURL + 'devices')
    await expect(page).toHaveURL(/\/sources\?tab=devices/)
    await expect(page.getByRole('tab', { name: 'Connected Devices' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.ant-menu-item', { hasText: 'Devices' })).toHaveCount(0)
  })
})
