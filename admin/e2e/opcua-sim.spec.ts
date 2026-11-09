import { test, expect } from '@playwright/test'

test.describe('OPC-UA simulator integration', () => {
  test('add OPC-UA source via UI and verify discovery', async ({ page, baseURL }) => {
    test.setTimeout(120_000)

    await page.goto(baseURL + 'sources')
    await page.getByTestId('sources-add-button').click()

    await page.locator('input[placeholder="e.g. Warehouse Modbus Bus"]').fill('opcua-sim')

    await page.locator('.ant-form-item', { hasText: 'Protocol' }).locator('.ant-select-selector').click()
    await page.locator('.ant-select-item-option', { hasText: 'OPC-UA' }).click()

    await page.locator('input[placeholder="opc.tcp://192.168.1.100:4840"]').fill('opc.tcp://localhost:4840')

    await page.getByTestId('source-drawer-test-connection').click()
    await expect(page.locator('.ant-alert-success')).toBeVisible({ timeout: 15_000 })

    await page.getByTestId('source-drawer-submit').click()
    await expect(page.getByText('Source added')).toBeVisible({ timeout: 5_000 })

    await expect(page.getByText('opcua-sim')).toBeVisible({ timeout: 10_000 })

    await page.locator('.ant-menu-item', { hasText: 'Devices' }).click()
    await expect(page).toHaveURL(/\/devices/)

    await expect(page.locator('.ant-table-row').first()).toBeVisible({ timeout: 60_000 })
  })

  test('source shows connected status on Sources page', async ({ page, baseURL }) => {
    test.setTimeout(90_000)

    await page.goto(baseURL + 'sources')

    const sourceRow = page.locator('.ant-table-row', { hasText: 'opcua-sim' })
    await expect(sourceRow).toBeVisible({ timeout: 15_000 })

    await expect.poll(async () => {
      await page.reload()
      const row = page.locator('.ant-table-row', { hasText: 'opcua-sim' })
      const label = row.getByTestId('source-status-label')
      return (await label.textContent())?.trim() ?? ''
    }, { timeout: 60_000, intervals: [5_000] }).toBe('Connected')

    const row = page.locator('.ant-table-row', { hasText: 'opcua-sim' })
    const dot = row.getByTestId('source-status-dot')
    await expect(dot).toHaveClass(/status-dot--pulse/)
  })

  test('discovered device shows Active on Devices page', async ({ page, baseURL }) => {
    test.setTimeout(90_000)

    await page.goto(baseURL + 'devices')

    const deviceRow = page.locator('.ant-table-row').first()
    await expect(deviceRow).toBeVisible({ timeout: 30_000 })

    const deviceName = deviceRow.getByTestId('device-name')
    await expect(deviceName).toBeVisible()
    const name = await deviceName.textContent()
    expect(name?.trim().length).toBeGreaterThan(0)

    await expect.poll(async () => {
      await page.reload()
      const row = page.locator('.ant-table-row').first()
      const status = row.getByTestId('device-status')
      return (await status.textContent())?.trim() ?? ''
    }, { timeout: 60_000, intervals: [5_000] }).toBe('Active')
  })

  test('device drawer shows OPC-UA protocol and last seen', async ({ page, baseURL }) => {
    test.setTimeout(60_000)

    await page.goto(baseURL + 'devices')

    const deviceRow = page.locator('.ant-table-row').first()
    await expect(deviceRow).toBeVisible({ timeout: 30_000 })

    await deviceRow.click()

    const drawer = page.locator('.ant-drawer')
    await expect(drawer).toBeVisible({ timeout: 5_000 })

    await expect(drawer.locator('.ant-tag', { hasText: 'OPC-UA' })).toBeVisible()

    await expect(drawer.getByText('Last Seen')).toBeVisible()
    const lastSeenRow = drawer.locator('.ant-descriptions-row', { hasText: 'Last Seen' })
    const lastSeenText = await lastSeenRow.textContent()
    expect(lastSeenText).toMatch(/just now|\ds ago|\dm ago|\dh ago/)
  })

  test('Data Explorer shows live OPC-UA points', async ({ page, baseURL }) => {
    test.setTimeout(120_000)

    await page.goto(baseURL + 'data-flow')
    await expect(page.getByTestId('stat-observed-points')).toBeVisible({ timeout: 10_000 })

    await expect.poll(async () => {
      await page.reload()
      const value = await page.getByTestId('stat-observed-points').locator('.ant-statistic-content-value').textContent()
      return parseInt(value?.trim() ?? '0', 10)
    }, { timeout: 90_000, intervals: [5_000] }).toBeGreaterThanOrEqual(1)

    const pointNames = page.getByTestId('point-name')
    await expect(pointNames.first()).toBeVisible({ timeout: 10_000 })

    const count = await pointNames.count()
    expect(count).toBeGreaterThanOrEqual(1)
  })
})
