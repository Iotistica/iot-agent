import { test, expect } from '@playwright/test'

test.use({ storageState: { cookies: [], origins: [] }, channel: process.env.E2E_BROWSER_CHANNEL || undefined })

test('preserves device workflows under Sources and scopes devices to the source', async ({ page, baseURL }) => {
  const updates: Array<Record<string, unknown>> = []
  const writes: Array<Record<string, unknown>> = []
  const deleted: string[] = []
  const devices = [
    { uuid: 'device-1', endpoint_id: 1, name: 'Pump', protocol: 'modbus', enabled: true, identifier: '1', metadata: {}, assetPath: null, lastSeenAt: null, created_at: '' },
    { uuid: 'device-2', endpoint_id: 2, name: 'Other device', protocol: 'opcua', enabled: true, identifier: '2', metadata: {}, assetPath: null, lastSeenAt: null, created_at: '' },
  ]
  await page.route('**/v1/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let response: unknown = {}
    if (path === '/v1/auth/me') response = { username: 'admin', role: 'admin', is_superuser: true, must_change_password: false }
    else if (path === '/v1/endpoints') response = { endpoints: [{ id: 1, uuid: 'source-1', name: 'Source one', protocol: 'modbus', enabled: true, poll_interval: 5000, connection: { host: 'localhost', port: 502 } }] }
    else if (path === '/v1/endpoints/source-1/points') response = { points: [
      { name: 'speed', protocolAddress: { address: 1 }, canonicalStatus: 'resolved', canonicalReason: null, identityStatus: 'resolved', identityReason: null, pointUuid: 'durable-uuid', deviceUuid: 'device-1', deviceName: 'Pump' },
      { name: 'pending', protocolAddress: null, canonicalStatus: 'deferred', canonicalReason: 'namespace-evidence-required', identityStatus: 'deferred', identityReason: 'namespace-evidence-required' },
      { name: 'invalid', protocolAddress: null, canonicalStatus: 'unresolved', canonicalReason: 'invalid-input', identityStatus: 'unresolved', identityReason: 'invalid-input' },
    ] }
    else if (path === '/v1/devices') response = { devices }
    else if (path === '/v1/devices/device-1/writable-points') response = { points: [{ name: 'speed', type: 'number', unit: 'rpm' }] }
    else if (path === '/v1/devices/device-1/write') { writes.push(request.postDataJSON()); response = { success: true } }
    else if (path === '/v1/devices/device-1' && request.method() === 'PATCH') { updates.push(request.postDataJSON()); response = { device: devices[0] } }
    else if (path === '/v1/devices/device-1' && request.method() === 'DELETE') { deleted.push('device-1') }
    else if (path.includes('discovery-rules')) response = { rules: [] }
    await route.fulfill({ json: response })
  })

  await page.goto(baseURL + 'devices')
  await expect(page).toHaveURL(/\/sources\?tab=devices/)
  await expect(page.getByRole('tab', { name: 'Connected Devices' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.ant-menu-item', { hasText: 'Devices' })).toHaveCount(0)
  await expect(page.getByTestId('device-name')).toHaveCount(2)
  await expect(page.getByRole('tabpanel', { name: 'Connected Devices' }).locator('.ant-table-row', { hasText: 'OPC-UA' }).first()).toBeVisible()

  await page.getByRole('tab', { name: 'Sources', exact: true }).click()
  await page.getByTestId('source-edit').click()
  const sourceDrawer = page.locator('.ant-drawer').filter({ hasText: 'Edit — Source one' })
  await sourceDrawer.getByRole('tab', { name: 'Points', exact: true }).click()
  await expect(sourceDrawer.getByText('durable-uuid')).toBeVisible()
  await expect(sourceDrawer.getByText('Pump', { exact: true })).toBeVisible()
  await expect(sourceDrawer.getByText('Pending', { exact: true })).toBeVisible()
  await expect(sourceDrawer.getByText('Unresolvable', { exact: true })).toBeVisible()
  await sourceDrawer.getByPlaceholder('Search points, source, address or UUID').fill('pending')
  await expect(sourceDrawer.getByText('durable-uuid')).toHaveCount(0)
  await expect(sourceDrawer.getByText('Pending', { exact: true })).toBeVisible()
  await sourceDrawer.getByRole('tab', { name: 'Connected Devices' }).click()
  await expect(sourceDrawer.getByTestId('device-name')).toHaveCount(1)
  await sourceDrawer.getByTestId('device-name').click()

  const deviceDrawer = page.locator('.ant-drawer').filter({ hasText: 'Custom Metadata' })
  await deviceDrawer.getByPlaceholder('e.g. Chicago/Plant-3/Line-A/CNC-01').fill('Plant/Line')
  await deviceDrawer.getByPlaceholder('New key').fill('owner')
  await deviceDrawer.getByPlaceholder('Value', { exact: true }).fill('operations')
  await deviceDrawer.getByRole('button', { name: 'Save', exact: true }).click()
  expect(updates).toContainEqual({ assetPath: 'Plant/Line', metadata: { owner: 'operations' } })

  await sourceDrawer.getByTestId('device-name').click()
  await deviceDrawer.getByRole('button', { name: 'Write Value' }).click()
  const modal = page.getByRole('dialog', { name: 'Write Value' })
  await modal.getByRole('combobox').click()
  await page.locator('.ant-select-item-option').filter({ hasText: 'speed' }).click()
  await modal.getByPlaceholder('e.g. 1500').fill('123')
  await modal.getByRole('button', { name: 'OK' }).click()
  expect(writes).toContainEqual({ pointName: 'speed', value: 123 })

  await deviceDrawer.getByRole('button', { name: 'Cancel' }).click()
  await sourceDrawer.getByRole('button', { name: 'Close' }).click()
  await page.locator('main').getByRole('tab', { name: 'Connected Devices', exact: true }).click()
  const devicePanel = page.locator('main').getByRole('tabpanel', { name: 'Connected Devices' })
  await devicePanel.getByPlaceholder('Search name, protocol, identifier…').fill('Pump')
  await expect(devicePanel.getByTestId('device-name')).toHaveCount(1)
  await devicePanel.getByRole('row', { name: /Pump/ }).getByRole('checkbox').check()
  await devicePanel.getByRole('button', { name: 'Disable' }).click()
  await expect.poll(() => updates).toContainEqual({ enabled: false })
  await expect(devicePanel.getByText('1 selected')).toHaveCount(0)
  await devicePanel.getByRole('row', { name: /Pump/ }).getByRole('checkbox').check()
  await devicePanel.getByRole('button', { name: 'Enable' }).click()
  await expect.poll(() => updates).toContainEqual({ enabled: true })
  await expect(devicePanel.getByText('1 selected')).toHaveCount(0)
  await devicePanel.getByRole('row', { name: /Pump/ }).getByRole('checkbox').check()
  await devicePanel.getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('button', { name: 'Delete 1' }).click()
  await expect.poll(() => deleted).toEqual(['device-1'])
})

test('shows durable point UUIDs only when the optional column is enabled', async ({ page, baseURL }) => {
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    let response: unknown = {}
    if (path === '/v1/auth/me') response = { username: 'admin', role: 'admin', is_superuser: true, must_change_password: false }
    else if (path === '/v1/endpoints') response = { endpoints: [
      { id: 1, uuid: 'source-1', name: 'Source one', protocol: 'modbus', enabled: true, poll_interval: 5000, connection: { host: 'localhost' } },
      { id: 2, uuid: 'source-2', name: 'Source two', protocol: 'mqtt', enabled: true, poll_interval: 5000, connection: { host: 'localhost' } },
      { id: 3, uuid: 'source-3', name: 'Source three', protocol: 'opcua', enabled: true, poll_interval: 5000, connection: { host: 'localhost' } },
    ] }
    else if (path === '/v1/endpoints/source-1/points') response = { points: [
      { name: 'speed', protocolAddress: { address: 1 }, canonicalStatus: 'resolved', canonicalReason: null, identityStatus: 'resolved', identityReason: null, pointUuid: 'durable-uuid' },
    ] }
    else if (path === '/v1/endpoints/source-2/points') response = { points: [
      { name: 'temperature', protocolAddress: 'sensors/temperature', canonicalStatus: 'resolved', canonicalReason: null, identityStatus: 'unresolved', identityReason: 'not-found' },
    ] }
    else if (path === '/v1/endpoints/source-3/points') response = { points: [
      { name: 'pressure', protocolAddress: 'ns=1;s=pressure', canonicalStatus: 'resolved', canonicalReason: null, identityStatus: 'resolved', identityReason: null, pointUuid: 'pressure-uuid' },
    ] }
    else if (path === '/v1/devices') response = { devices: [] }
    else if (path === '/v1/data-explorer/views') response = { views: [] }
    else if (path === '/v1/ml-datasets') response = { datasets: [] }
    else if (path === '/v1/pipeline/subscriptions') response = { subscriptions: [] }
    else if (path === '/v1/pipeline/overview') response = { overview: { activePoints: 2 } }
    else if (path === '/v1/pipeline/points') response = { points: [
      { id: 1, timestamp: new Date().toISOString(), protocol: 'modbus', endpointName: 'Pump', sourceEndpointUuid: 'source-1', metric: 'speed', pointUuid: 'durable-uuid', value: 10, subscriptionId: 1, destinationId: 1, destinationName: 'MQTT', pointCount: 1 },
      { id: 2, timestamp: new Date().toISOString(), protocol: 'mqtt', endpointName: 'Pump', sourceEndpointUuid: 'source-2', metric: 'temperature', provisionalPointId: 'provisional-uuid', value: 20, subscriptionId: 1, destinationId: 1, destinationName: 'MQTT', pointCount: 1 },
    ] }
    await route.fulfill({ json: response })
  })

  await page.goto(baseURL + 'data-flow')
  await expect(page.getByTestId('point-name')).toHaveCount(2)
  await expect(page.locator('.views-list > button')).toHaveText([
    'Data Points (2)', 'Source Points', 'Favorites (0)', 'Views (0)', 'Datasets (0)',
  ])
  await expect(page.getByTestId('data-tab-live')).toHaveClass(/active/)
  await expect(page.getByRole('columnheader', { name: /^Device\b/ })).toHaveCount(0)
  await page.getByTestId('data-tab-favorites').click()
  await expect(page.getByRole('columnheader', { name: /^Device\b/ })).toBeVisible()
  await page.getByTestId('data-tab-live').click()
  await expect(page.getByRole('columnheader', { name: /^Device\b/ })).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: 'Point UUID' })).toHaveCount(0)
  await page.getByRole('checkbox', { name: 'Point UUID' }).check()
  await expect(page.getByRole('columnheader', { name: 'Point UUID' })).toBeVisible()
  await expect(page.getByText('durable-uuid')).toBeVisible()
  await expect(page.getByText('Provisional', { exact: true })).toBeVisible()
  await page.getByTestId('data-search').fill('durable-uuid')
  await expect(page.getByTestId('point-name')).toHaveCount(1)
  await expect(page.getByTestId('point-name')).toHaveText('speed')
  await page.getByTestId('data-tab-configured').click()
  await expect(page.getByTestId('data-tab-configured')).toHaveClass(/active/)
  await expect(page.getByTestId('data-tab-live')).not.toHaveClass(/active/)
  await expect(page.getByText('durable-uuid')).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Protocol', exact: true })).toBeVisible()
  const modbusRow = page.getByRole('row').filter({ hasText: 'durable-uuid' })
  const mqttRow = page.getByRole('row').filter({ hasText: 'sensors/temperature' })
  await expect(mqttRow).toHaveCount(0)
  await page.getByTestId('data-clear-filters').click()
  await expect(modbusRow.getByRole('cell').nth(0)).toHaveText('Modbus')
  await expect(modbusRow.getByRole('cell').nth(1)).toHaveText('Source one')
  await expect(mqttRow.getByRole('cell').nth(0)).toHaveText('MQTT')
  await expect(mqttRow.getByRole('cell').nth(1)).toHaveText('Source two')
  const protocolFilter = page.getByTestId('data-protocol-filter')
  await protocolFilter.locator('.ant-select-selector').click()
  await page.locator('.ant-select-item-option').filter({ hasText: 'OPC-UA' }).click()
  await page.getByTestId('data-source-filter').locator('.ant-select-selector').click()
  await page.locator('.ant-select-item-option').filter({ hasText: 'Source three' }).click()
  await expect(page.getByRole('row').filter({ hasText: 'pressure-uuid' })).toBeVisible()
  await page.getByTestId('data-tab-live').click()
  await expect(page.getByTestId('point-name')).toHaveCount(0)
  await page.getByTestId('data-clear-filters').click()
  await page.getByTestId('data-quality-filter').locator('.ant-select-selector').click()
  await page.locator('.ant-select-item-option').filter({ hasText: 'Bad quality' }).click()
  await expect(page.getByTestId('point-name')).toHaveCount(0)
  await page.getByTestId('data-tab-configured').click()
  await expect(mqttRow).toBeVisible()
  await page.getByTestId('data-tab-live').click()
  await expect(page.getByTestId('point-name')).toHaveCount(0)
  await page.getByTestId('data-clear-filters').click()
  await page.getByTestId('data-tab-configured').click()
  await protocolFilter.locator('.ant-select-selector').click()
  await page.locator('.ant-select-item-option').filter({ hasText: 'MQTT' }).click()
  await page.getByTestId('data-source-filter').locator('.ant-select-selector').click()
  await page.locator('.ant-select-item-option').filter({ hasText: 'Source two' }).click()
  await page.getByTestId('data-search').fill('temperature')
  await expect(mqttRow).toBeVisible()
  await expect(modbusRow).toHaveCount(0)
  await page.getByTestId('data-tab-live').click()
  await expect(page.getByTestId('data-search')).toHaveValue('temperature')
  await expect(page.getByTestId('point-name')).toHaveText(['temperature'])
  await page.getByTestId('data-tab-configured').click()
  await expect(mqttRow).toBeVisible()
  await page.getByTestId('data-identity-filter').locator('.ant-select-selector').click()
  await page.locator('.ant-select-item-option').filter({ hasText: 'Assigned' }).click()
  await expect(mqttRow).toHaveCount(0)
  await page.getByTestId('data-tab-live').click()
  await expect(page.getByTestId('point-name')).toHaveText(['temperature'])
  await page.getByTestId('data-tab-configured').click()
  await expect(mqttRow).toHaveCount(0)
  await page.getByTestId('data-clear-filters').click()
  await expect(modbusRow).toBeVisible()
  await expect(mqttRow).toBeVisible()
  await modbusRow.getByRole('button', { name: 'Manage', exact: true }).click()
  await expect(page.locator('.ant-drawer').filter({ hasText: 'Edit — Source one' })).toBeVisible()
})
