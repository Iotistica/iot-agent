import { test as setup, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORAGE_STATE = join(__dirname, '.auth', 'user.json')
const NEW_PASSWORD = 'E2eTestPass!2024'

setup('authenticate and handle first-login password reset', async ({ page, baseURL }) => {
  const initialPassword = process.env._E2E_INITIAL_PASSWORD
  if (!initialPassword) {
    throw new Error(
      'No admin password found. Set E2E_ADMIN_PASSWORD env var, or E2E_ADMIN_PASSWORD_FILE pointing to a file containing the password.',
    )
  }

  await page.goto(baseURL + 'login')
  await page.locator('input[autocomplete="username"]').fill('admin')
  await page.locator('input[autocomplete="current-password"]').fill(initialPassword)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // After login the router either redirects to /dashboard or to /user/profile
  // (when must_change_password is true). Wait for navigation to settle.
  await page.waitForURL(/\/(dashboard|user\/profile)/, { timeout: 10_000 })

  if (page.url().includes('/user/profile')) {
    // First-login forced password reset
    await expect(page.getByText('temporary password')).toBeVisible({ timeout: 5_000 })

    const passwordInputs = page.locator('input[autocomplete="new-password"]')
    await passwordInputs.nth(0).fill(NEW_PASSWORD)
    await passwordInputs.nth(1).fill(NEW_PASSWORD)

    await page.getByRole('button', { name: 'Save Password' }).click()

    await page.waitForURL('**/dashboard', { timeout: 10_000 })
  }

  await expect(page).toHaveURL(/\/dashboard/)

  mkdirSync(join(__dirname, '.auth'), { recursive: true })
  await page.context().storageState({ path: STORAGE_STATE })

  // Persist the working password for other tests that may need it
  writeFileSync(join(__dirname, '.auth', 'password.txt'), NEW_PASSWORD, 'utf-8')
})
