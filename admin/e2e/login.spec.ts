import { test, expect } from '@playwright/test'

// Login tests run without saved auth state.
test.use({ storageState: { cookies: [], origins: [] } })

test.describe('Login page', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL + 'login')
  })

  test('shows login form with username and password fields', async ({ page }) => {
    await expect(page.locator('input[autocomplete="username"]')).toBeVisible()
    await expect(page.locator('input[autocomplete="current-password"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  })

  test('shows error on invalid credentials', async ({ page }) => {
    await page.locator('input[autocomplete="username"]').fill('admin')
    await page.locator('input[autocomplete="current-password"]').fill('wrong-password-xyz')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.locator('.ant-alert-error')).toBeVisible({ timeout: 5_000 })
  })

  test('shows error when fields are empty', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.locator('.ant-alert-error')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('.ant-alert-error')).toContainText('username and password')
  })
})
