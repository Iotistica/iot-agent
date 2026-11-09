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

    const deviceRow = page.locator('.ant-table-row').first()
    await expect(deviceRow).toBeVisible({ timeout: 60_000 })

    await expect.poll(async () => {
      const res = await page.request.get('/v1/devices?protocol=opcua')
      const body = await res.json()
      return body.devices?.length ?? 0
    }, { timeout: 60_000, intervals: [2_000] }).toBeGreaterThan(0)
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

  test('OPC-UA device has expected metadata from simulator', async ({ page }) => {
    test.setTimeout(60_000)

    const res = await page.request.get('/v1/devices?protocol=opcua')
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.devices.length).toBeGreaterThan(0)

    const device = body.devices[0]
    expect(device.protocol).toBe('opcua')
    expect(device.enabled).toBe(true)
    expect(device.lastSeenAt).toBeTruthy()
  })

  test('Data page renders stat cards and table', async ({ page, baseURL }) => {
    test.setTimeout(60_000)

    await page.goto(baseURL + 'data-flow')

    await expect(page.getByTestId('stat-observed-points')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('stat-subscriptions')).toBeVisible({ timeout: 5_000 })

    const table = page.locator('.ant-table')
    await expect(table).toBeVisible({ timeout: 10_000 })

    const res = await page.request.get('/v1/pipeline/overview')
    expect(res.ok()).toBe(true)
    const body = await res.json()
    expect(body.overview).toHaveProperty('activePoints')
    expect(body.overview).toHaveProperty('activeDevices')
  })
})
