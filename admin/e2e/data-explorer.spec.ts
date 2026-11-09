import { test, expect } from '@playwright/test'

test.describe('Data Explorer', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL + 'data-flow')
    await expect(page.getByTestId('stat-observed-points')).toBeVisible({ timeout: 10_000 })
  })

  test('stat cards render with correct titles', async ({ page }) => {
    await expect(page.getByTestId('stat-observed-points').locator('.ant-statistic-title')).toHaveText('Observed points')
    await expect(page.getByTestId('stat-subscriptions').locator('.ant-statistic-title')).toHaveText('Active subscriptions')

    const badQualityCard = page.locator('.metric-card', { hasText: 'Bad quality' })
    await expect(badQualityCard).toBeVisible()

    const staleCard = page.locator('.metric-card', { hasText: 'No update in 60s' })
    await expect(staleCard).toBeVisible()
  })

  test('search filter accepts input and clears', async ({ page }) => {
    const search = page.getByTestId('data-search')
    await expect(search).toBeVisible()

    await search.fill('nonexistent-point-xyz')
    await expect(search).toHaveValue('nonexistent-point-xyz')

    await expect(page.getByTestId('data-toolbar-info')).toContainText('0 points')

    await page.getByTestId('data-clear-filters').click()
    await expect(search).toHaveValue('')
  })

  test('tab navigation switches between Live, Favorites, Views, and Datasets', async ({ page }) => {
    const liveTab = page.getByTestId('data-tab-live')
    const favTab = page.getByTestId('data-tab-favorites')
    const viewsTab = page.getByTestId('data-tab-views')
    const datasetsTab = page.getByTestId('data-tab-datasets')

    await expect(liveTab).toHaveClass(/active/)

    await favTab.click()
    await expect(favTab).toHaveClass(/active/)
    await expect(liveTab).not.toHaveClass(/active/)

    await viewsTab.click()
    await expect(viewsTab).toHaveClass(/active/)
    await expect(page.getByTestId('data-toolbar-info')).toContainText('views')

    await datasetsTab.click()
    await expect(datasetsTab).toHaveClass(/active/)
    await expect(page.getByTestId('data-toolbar-info')).toContainText('datasets')

    await liveTab.click()
    await expect(liveTab).toHaveClass(/active/)
    await expect(page.getByTestId('data-toolbar-info')).toContainText('points')
  })

  test('pause button toggles to resume', async ({ page }) => {
    const pauseBtn = page.getByTestId('data-pause')
    await expect(pauseBtn).toContainText('Pause')

    await pauseBtn.click()
    await expect(pauseBtn).toContainText('Resume')

    await pauseBtn.click()
    await expect(pauseBtn).toContainText('Pause')
  })

  test('refresh button is clickable', async ({ page }) => {
    const refreshBtn = page.getByTestId('data-refresh')
    await expect(refreshBtn).toBeVisible()
    await refreshBtn.click()
    await expect(refreshBtn).toBeVisible()
  })

  test('points table shows column headers', async ({ page }) => {
    const table = page.locator('.ant-table')
    await expect(table).toBeVisible()

    await expect(table.locator('th', { hasText: 'Protocol' })).toBeVisible()
    await expect(table.locator('th', { hasText: 'Source' })).toBeVisible()
    await expect(table.locator('th', { hasText: 'Point' })).toBeVisible()
    await expect(table.locator('th', { hasText: 'Latest Value' })).toBeVisible()
    await expect(table.locator('th', { hasText: 'Quality' })).toBeVisible()
    await expect(table.locator('th', { hasText: 'Updated' })).toBeVisible()
  })

  test('Views tab shows empty state', async ({ page }) => {
    await page.getByTestId('data-tab-views').click()
    await expect(page.getByText('No saved views yet')).toBeVisible({ timeout: 5_000 })
  })

  test('Datasets tab shows empty state', async ({ page }) => {
    await page.getByTestId('data-tab-datasets').click()
    await expect(page.getByText('No datasets yet')).toBeVisible({ timeout: 5_000 })
  })
})
