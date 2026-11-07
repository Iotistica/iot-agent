import { test, expect } from '@playwright/test'

const pages = [
  { name: 'Dashboard', path: '/dashboard' },
  { name: 'Sources', path: '/sources' },
  { name: 'Destinations', path: '/destinations' },
  { name: 'Devices', path: '/devices' },
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
})
