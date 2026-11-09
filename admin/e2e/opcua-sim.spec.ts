import { test, expect } from '@playwright/test'

test.describe('OPC-UA simulator integration', () => {
  test('add OPC-UA source via UI and verify discovery', async ({ page, baseURL }) => {
    // ── 1. Navigate to Sources and open the "Add Source" drawer ──────────
    await page.goto(baseURL + 'sources')
    await page.getByRole('button', { name: 'plus Add Source' }).click()

    // ── 2. Fill in the source form ──────────────────────────────────────
    await page.locator('input[placeholder="e.g. Warehouse Modbus Bus"]').fill('opcua-sim')

    // Select OPC-UA protocol (default is Modbus)
    await page.locator('.ant-form-item', { hasText: 'Protocol' }).locator('.ant-select-selector').click()
    await page.locator('.ant-select-item-option', { hasText: 'OPC-UA' }).click()

    // Fill in the endpoint URL
    await page.locator('input[placeholder="opc.tcp://192.168.1.100:4840"]').fill('opc.tcp://localhost:4840')

    // ── 3. Test connection ──────────────────────────────────────────────
    await page.getByRole('button', { name: 'Test Connection' }).click()
    await expect(page.locator('.ant-alert-success')).toBeVisible({ timeout: 15_000 })

    // ── 4. Save the source ──────────────────────────────────────────────
    await page.getByRole('button', { name: 'Add Source', exact: true }).click()
    await expect(page.getByText('Source added')).toBeVisible({ timeout: 5_000 })

    // ── 5. Verify the endpoint appears in the Sources table ─────────────
    await expect(page.getByText('opcua-sim')).toBeVisible({ timeout: 10_000 })

    // ── 6. Navigate to Devices and wait for OPC-UA discovery ────────────
    await page.locator('.ant-menu-item', { hasText: 'Devices' }).click()
    await expect(page).toHaveURL(/\/devices/)

    const deviceRow = page.locator('.ant-table-row').first()
    await expect(deviceRow).toBeVisible({ timeout: 60_000 })

    // ── 7. Verify data is flowing via pipeline overview API ─────────────
    let activePoints = 0
    for (let i = 0; i < 20; i++) {
      const res = await page.request.get('/v1/pipeline/overview')
      if (res.ok()) {
        const body = await res.json()
        activePoints = body.overview?.activePoints ?? 0
        if (activePoints > 0) break
      }
      await page.waitForTimeout(3_000)
    }
    expect(activePoints).toBeGreaterThan(0)
  })
})
