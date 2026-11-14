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
  let failSourcePoints = false
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    let response: unknown = {}
    if (path === '/v1/auth/me') response = { username: 'admin', role: 'admin', is_superuser: true, must_change_password: false }
    else if (path === '/v1/endpoints') response = { endpoints: [
      { id: 1, uuid: 'source-1', name: 'Source one', protocol: 'modbus', enabled: true, poll_interval: 5000, connection: { host: 'localhost' } },
      { id: 2, uuid: 'source-2', name: 'Source two', protocol: 'mqtt', enabled: true, poll_interval: 5000, connection: { host: 'localhost' } },
      { id: 3, uuid: 'source-3', name: 'Source zzz', protocol: 'opcua', enabled: true, poll_interval: 5000, connection: { host: 'localhost' } },
    ] }
    else if (path === '/v1/endpoints/source-1/points') response = { points: [
      { name: 'speed', protocolAddress: { address: 1 }, canonicalStatus: 'resolved', canonicalReason: null, identityStatus: 'resolved', identityReason: null, pointUuid: 'durable-uuid' },
    ] }
    else if (path === '/v1/endpoints/source-2/points') response = { points: [
      { name: 'temperature', protocolAddress: 'sensors/temperature', canonicalStatus: 'resolved', canonicalReason: null, identityStatus: 'unresolved', identityReason: 'not-found' },
    ] }
    else if (path === '/v1/endpoints/source-3/points') {
      if (failSourcePoints) return route.fulfill({ status: 503, json: { error: 'Unavailable' } })
      response = { points: [
        { name: 'pressure', protocolAddress: 'ns=1;s=pressure', canonicalStatus: 'resolved', canonicalReason: null, identityStatus: 'resolved', identityReason: null, pointUuid: 'pressure-uuid' },
        ...Array.from({ length: 20 }, (_, index) => ({
          name: `zzz-point-${index}`, protocolAddress: `ns=1;s=point-${index}`, canonicalStatus: 'resolved',
          canonicalReason: null, identityStatus: 'resolved', identityReason: null, pointUuid: `point-${index}`,
        })),
      ] }
    }
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
  const tabBar = page.locator('.views-bar')
  const toolbarInfo = tabBar.getByTestId('data-toolbar-info')
  await expect(toolbarInfo).toContainText('Showing 2 points')
  await expect(toolbarInfo).toContainText('Last sync')
  const tabBox = await page.getByTestId('data-tab-live').boundingBox()
  const infoBox = await toolbarInfo.boundingBox()
  expect(tabBox).not.toBeNull()
  expect(infoBox).not.toBeNull()
  expect(Math.abs((tabBox!.y + tabBox!.height / 2) - (infoBox!.y + infoBox!.height / 2))).toBeLessThan(2)
  await page.getByTestId('data-tab-views').click()
  await expect(toolbarInfo).toContainText('Showing 0 views')
  await page.getByTestId('data-tab-datasets').click()
  await expect(toolbarInfo).toContainText('Showing 0 datasets')
  await page.getByTestId('data-tab-live').click()
  await expect(page.locator('.views-list > button')).toHaveText([
    'Data Points (2)', 'Source Points (23)', 'Favorites (0)', 'Views (0)', 'Datasets (0)',
  ])
  await expect(page.getByTestId('stat-source-points')).toContainText('Source points')
  await expect(page.getByTestId('stat-source-points')).toContainText('23')
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
  await expect(page.getByTestId('data-tab-configured')).toHaveText('Source Points (1)')
  await expect(page.getByTestId('stat-source-points')).toContainText('23')
  await page.getByTestId('data-tab-configured').click()
  await expect(toolbarInfo).toHaveCount(0)
  await expect(page.getByTestId('data-tab-configured')).toHaveClass(/active/)
  await expect(page.getByTestId('data-tab-live')).not.toHaveClass(/active/)
  await expect(page.getByText('durable-uuid')).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Protocol', exact: true })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Actions', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Manage', exact: true })).toHaveCount(0)
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
  await page.locator('.ant-select-item-option').filter({ hasText: 'Source zzz' }).click()
  await expect(page.getByRole('row').filter({ hasText: 'pressure-uuid' })).toBeVisible()
  await expect(page.getByTestId('data-tab-configured')).toHaveText('Source Points (21)')
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
  await expect(page.getByTestId('data-tab-configured')).toHaveText('Source Points (0)')
  await page.getByTestId('data-tab-live').click()
  await expect(page.getByTestId('point-name')).toHaveText(['temperature'])
  await page.getByTestId('data-tab-configured').click()
  await expect(mqttRow).toHaveCount(0)
  await page.getByTestId('data-clear-filters').click()
  await expect(modbusRow).toBeVisible()
  await expect(mqttRow).toBeVisible()
  await expect(page.getByTestId('data-tab-configured')).toHaveText('Source Points (23)')
  failSourcePoints = true
  await page.getByTestId('data-refresh').click()
  await expect(page.getByTestId('data-tab-configured')).toHaveText('Source Points (!)')
  await expect(page.getByTestId('stat-source-points')).toContainText('!')
  await expect(page.getByText('Unable to load points for: Source zzz')).toBeVisible()
  failSourcePoints = false
  await page.getByTestId('data-refresh').click()
  await expect(page.getByTestId('data-tab-configured')).toHaveText('Source Points (23)')
  await page.getByTestId('data-tab-live').click()
  await page.setViewportSize({ width: 375, height: 800 })
  await expect(toolbarInfo).toBeVisible()
  expect(await tabBar.locator('.views-list').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
})

test('groups picker points by source UUID and blocks ambiguous identities without remapping saved keys', async ({ page, baseURL }) => {
  const key = (endpoint: string, name: string) => JSON.stringify(['opcua', endpoint, name])
  const firstKey = key('device-a', 'same')
  const legacyKey = JSON.stringify(['opcua', 'device-a', 'same', 'old-device'])
  const secondKey = key('device-b', 'same')
  const duplicateKey = key('shared', 'duplicate')
  const orphanKey = key('orphan', 'orphan')
  const patches: Array<{ pointKeys: string[] }> = []
  let failConfiguredPoints = false
  const sources = [
    { id: 1, uuid: 'source-11111111', name: 'plc', protocol: 'opcua', enabled: true, poll_interval: 5000, connection: {} },
    { id: 2, uuid: 'source-22222222', name: 'plc', protocol: 'opcua', enabled: true, poll_interval: 5000, connection: {} },
    { id: 3, uuid: 'source-33333333', name: 'mqtt-source', protocol: 'mqtt', enabled: true, poll_interval: 5000, connection: {} },
  ]
  const configured = (name: string, address: string, deviceUuid?: string) => ({
    name, protocolAddress: address, deviceUuid, canonicalStatus: 'resolved', canonicalReason: null,
    identityStatus: 'resolved', identityReason: null,
  })
  const catalog = [
    { sourceSystem: 'opcua', endpointName: 'device-a', deviceKey: 'device-a', rawName: 'raw-a', normalizedName: 'same', pointKey: firstKey },
    { sourceSystem: 'opcua', endpointName: 'device-b', deviceKey: 'device-b', rawName: 'raw-b', normalizedName: 'same', pointKey: secondKey },
    { sourceSystem: 'opcua', endpointName: 'shared', deviceKey: 'device-a', rawName: 'duplicate', normalizedName: 'duplicate', pointKey: duplicateKey },
    { sourceSystem: 'opcua', endpointName: 'shared', deviceKey: 'device-c', rawName: 'duplicate', normalizedName: 'duplicate', pointKey: duplicateKey },
    { sourceSystem: 'opcua', endpointName: 'device-a', deviceKey: 'device-a', rawName: 'collapsed', normalizedName: 'collapsed', pointKey: key('device-a', 'collapsed') },
    { sourceSystem: 'opcua', endpointName: 'orphan', deviceKey: 'orphan', rawName: 'orphan', normalizedName: 'orphan', pointKey: orphanKey },
    { sourceSystem: 'mqtt', endpointName: 'mqtt-input', deviceKey: 'source-33333333', rawName: 'temperature', normalizedName: 'temperature', pointKey: JSON.stringify(['mqtt', 'mqtt-input', 'temperature']) },
  ]
  const view = { id: 'view-1', name: 'Saved view', description: '', pointKeys: [legacyKey, duplicateKey, orphanKey] }
  await page.route('**/v1/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let response: unknown = {}
    if (path === '/v1/auth/me') response = { username: 'admin', role: 'admin', is_superuser: true, must_change_password: false }
    else if (path === '/v1/endpoints') response = { endpoints: sources }
    else if (path === '/v1/endpoints/source-11111111/points') {
      if (failConfiguredPoints) return route.fulfill({ status: 503, json: { error: 'Unavailable' } })
      response = { points: [
        configured('raw-a', 'ns=2;s=a', 'device-a'),
        configured('raw-b', 'ns=2;s=b', 'device-b'),
        configured('duplicate', 'ns=2;s=d1', 'device-a'),
        configured('collapsed', 'ns=2;s=c1', 'device-a'),
        configured('collapsed', 'ns=2;s=c2', 'device-a'),
      ] }
    }
    else if (path === '/v1/endpoints/source-22222222/points') response = { points: [configured('duplicate', 'ns=2;s=d2', 'device-c')] }
    else if (path === '/v1/endpoints/source-33333333/points') response = { points: [configured('temperature', 'sensor/temperature')] }
    else if (path === '/v1/devices') response = { devices: [
      { uuid: 'device-a', endpoint_id: 1, name: 'AHU-1', protocol: 'opcua' },
      { uuid: 'device-b', endpoint_id: 1, name: 'AHU-2', protocol: 'opcua' },
      { uuid: 'device-c', endpoint_id: 2, name: 'AHU-3', protocol: 'opcua' },
    ] }
    else if (path === '/v1/point-catalog') response = { points: catalog }
    else if (path === '/v1/data-explorer/views') response = { views: [view] }
    else if (path === '/v1/data-explorer/views/view-1' && request.method() === 'PATCH') {
      patches.push(request.postDataJSON())
      response = { view }
    }
    else if (path === '/v1/ml-datasets') response = { datasets: [] }
    else if (path === '/v1/anomaly/config') response = { config: { metrics: [] } }
    else if (path === '/v1/anomaly-incidents') response = { incidents: [], total: 0 }
    else if (path === '/v1/pipeline/subscriptions') response = { subscriptions: [] }
    else if (path === '/v1/pipeline/overview') response = { overview: {} }
    else if (path === '/v1/pipeline/points') response = { points: [] }
    await route.fulfill({ json: response })
  })

  await page.goto(baseURL + 'data-flow')
  await page.getByTestId('data-tab-views').click()
  await page.getByRole('row', { name: /Saved view/ }).getByRole('button').nth(2).click()
  const drawer = page.locator('.ant-drawer').filter({ hasText: 'Edit View' })
  await drawer.getByRole('button', { name: 'Edit Selection' }).click()
  const modal = page.getByRole('dialog', { name: 'Select Points' })
  await expect(modal.getByText('1 catalog points could not be matched', { exact: false })).toBeVisible()
  await expect(modal.getByText('Some points have ambiguous or unverifiable', { exact: false })).toBeVisible()
  const opcua = modal.locator('.protocol-group').filter({ hasText: 'OPC-UA' })
  await opcua.locator('.protocol-header').click()
  const groups = opcua.locator('.source-group')
  await expect(groups).toHaveCount(2)
  await expect(groups.locator('.source-name')).toHaveText(['plc', 'plc'])
  await expect(groups.nth(0)).toContainText('source-11111111')
  await expect(groups.nth(1)).toContainText('source-22222222')
  await groups.nth(0).locator('.source-header').click()
  await groups.nth(1).locator('.source-header').click()
  const first = groups.nth(0).locator('.point-item').filter({ hasText: 'raw-a' })
  const second = groups.nth(0).locator('.point-item').filter({ hasText: 'raw-b' })
  await expect(first).toContainText('AHU-1')
  await expect(second).toContainText('AHU-2')
  await expect(first.getByRole('checkbox')).toBeChecked()
  await expect(second.getByRole('checkbox')).not.toBeChecked()
  await groups.nth(0).locator('.source-header').getByRole('checkbox').check()
  await expect(first.getByRole('checkbox')).toBeChecked()
  await expect(second.getByRole('checkbox')).toBeChecked()
  await expect(modal.getByText('4 selected')).toBeVisible()
  await expect(modal.locator('.point-item').filter({ hasText: 'duplicate' }).getByRole('checkbox')).toHaveCount(2)
  for (const checkbox of await modal.locator('.point-item').filter({ hasText: 'duplicate' }).getByRole('checkbox').all()) {
    await expect(checkbox).toBeDisabled()
  }
  await expect(modal.locator('.point-item').filter({ hasText: 'collapsed' }).getByRole('checkbox')).toBeDisabled()
  await modal.getByPlaceholder('Search source or point name…').fill('raw-b')
  await expect(modal.locator('.point-item')).toHaveCount(1)
  await modal.getByPlaceholder('Search source or point name…').clear()
  await modal.getByPlaceholder('Search source or point name…').fill('plc')
  await expect(groups).toHaveCount(2)
  await modal.getByPlaceholder('Search source or point name…').clear()
  await modal.locator('.ant-select-selector').click()
  await page.locator('.ant-select-item-option').filter({ hasText: 'MQTT' }).click()
  await expect(modal.locator('.protocol-group')).toHaveCount(1)
  await modal.locator('.protocol-header').click()
  const mqttSource = modal.locator('.source-group')
  await expect(mqttSource.locator('.source-name')).toHaveText('mqtt-source')
  await mqttSource.locator('.source-header').click()
  await expect(mqttSource.locator('.point-item').getByRole('checkbox')).toBeEnabled()
  await modal.locator('.ant-select-clear').click()
  await modal.getByRole('button', { name: 'Confirm (4)' }).click()
  await drawer.getByRole('button', { name: 'Save Changes' }).click()
  await expect.poll(() => patches.length).toBe(1)
  expect(patches[0].pointKeys).toEqual([legacyKey, duplicateKey, orphanKey, secondKey])

  await page.goto(baseURL + 'anomaly')
  await page.getByRole('tab', { name: 'Anomaly Rules' }).click()
  await page.getByRole('button', { name: 'Add rule' }).click()
  const ruleDrawer = page.locator('.ant-drawer').filter({ hasText: 'Apply to' })
  await ruleDrawer.getByText('Click to select a point…').click()
  const singlePicker = page.getByRole('dialog', { name: 'Select Point', exact: true })
  const mqttGroup = singlePicker.locator('.protocol-group').filter({ hasText: 'MQTT' })
  await mqttGroup.locator('.protocol-header').click()
  await mqttGroup.locator('.source-header').click()
  await expect(mqttGroup.getByText('Device metadata is required for this selection.')).toBeVisible()
  await mqttGroup.locator('.point-item').click()
  await expect(singlePicker).toBeVisible()
  await singlePicker.locator('.protocol-group').filter({ hasText: 'OPC-UA' }).locator('.protocol-header').click()
  const singleSource = singlePicker.locator('.source-group').filter({ hasText: 'source-11111111' })
  await singleSource.locator('.source-header').click()
  await singleSource.locator('.point-item').filter({ hasText: 'collapsed' }).click()
  await expect(singlePicker).toBeVisible()
  await singleSource.locator('.point-item').filter({ hasText: 'raw-b' }).click()
  await expect(singlePicker).not.toBeVisible()
  await expect(ruleDrawer.locator('.point-picker-trigger')).toContainText('same')
  await expect(ruleDrawer.locator('.point-picker-trigger')).toContainText('AHU-2')
  failConfiguredPoints = true
  await ruleDrawer.getByRole('button', { name: 'Change' }).click()
  await expect(singlePicker.getByText('Unable to load sources and points.', { exact: false })).toBeVisible()
})
