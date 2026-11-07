import { defineConfig } from '@playwright/test'
import { readFileSync } from 'fs'

const CI = !!process.env.CI

function resolveAdminPassword(): string {
  const file = process.env.E2E_ADMIN_PASSWORD_FILE
  if (file) {
    return readFileSync(file, 'utf-8').trim()
  }
  return process.env.E2E_ADMIN_PASSWORD || ''
}

const adminPassword = resolveAdminPassword()
if (adminPassword) {
  process.env._E2E_INITIAL_PASSWORD = adminPassword
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: 1,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : [['html', { open: 'on-failure' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:48484/admin/',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        storageState: 'e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],
})
