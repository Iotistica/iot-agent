import { test, expect } from '@playwright/test'

// This spec runs WITHOUT saved auth — it tests the raw first-login flow.
test.use({ storageState: { cookies: [], origins: [] } })

const NEW_PASSWORD = 'FirstLoginTest!99'

test('first login forces password reset then redirects to dashboard', async ({ page, baseURL }) => {
  const initialPassword = process.env._E2E_INITIAL_PASSWORD
  if (!initialPassword) {
    test.skip(true, 'No initial password available — cannot test first-login flow in isolation')
    return
  }

  await page.goto(baseURL + 'login')
  await page.locator('input[autocomplete="username"]').fill('admin')
  await page.locator('input[autocomplete="current-password"]').fill(initialPassword)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Must be redirected to the profile page for password change
  await page.waitForURL('**/user/profile', { timeout: 10_000 })
  await expect(page.getByText('temporary password')).toBeVisible()

  // Fill new password
  const passwordInputs = page.locator('input[autocomplete="new-password"]')
  await passwordInputs.nth(0).fill(NEW_PASSWORD)
  await passwordInputs.nth(1).fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Save Password' }).click()

  // Should redirect to dashboard after password change
  await page.waitForURL('**/dashboard', { timeout: 10_000 })
  await expect(page).toHaveURL(/\/dashboard/)
})
