import { test, expect } from '@playwright/test'

test.use({ storageState: { cookies: [], origins: [] }, channel: process.env.E2E_BROWSER_CHANNEL || undefined })

test('warns about related subscriptions and retains a specific empty selection after deletion', async ({ page, baseURL }) => {
  let sources = [
    { id: 1, uuid: 'source-1', name: 'plc 1', protocol: 'opcua', enabled: true, connection: { endpointUrl: 'opc.tcp://localhost:4840' } },
    { id: 2, uuid: 'source-2', name: 'plc 2', protocol: 'opcua', enabled: true, connection: { endpointUrl: 'opc.tcp://localhost:4841' } },
  ]
  const subscriptions = [{
    id: 1, publish_destination_id: 1, topics: [], route_json: { includeDevices: ['plc 1'], sourceFilterMode: 'specific' },
    payload_format: 'tags', compression: null, ml_dataset_id: null, enabled: true, created_at: '', updated_at: '',
  }]
  await page.route('**/v1/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let response: unknown = {}
    if (path === '/v1/auth/me') response = { username: 'admin', role: 'admin', is_superuser: true, must_change_password: false }
    else if (path === '/v1/settings') response = { settings: { agent: {} } }
    else if (path === '/v1/publish/destinations') response = { publishers: [{ id: 1, name: 'nowhere', type: 'noop', enabled: true }] }
    else if (path === '/v1/publish/subscriptions') response = { subscriptions }
    else if (path === '/v1/endpoints') response = { endpoints: sources }
    else if (path === '/v1/endpoints/source-1' && request.method() === 'DELETE') {
      sources = sources.filter(source => source.uuid !== 'source-1')
      subscriptions[0].route_json.includeDevices = []
    } else if (path.includes('discovery-rules')) response = { rules: [] }
    else if (path === '/v1/ml-datasets') response = { datasets: [] }
    await route.fulfill({ json: response })
  })

  await page.goto(baseURL + 'sources')
  const sourceRow = page.locator('.ant-table-row').filter({ hasText: 'plc 1' })
  await sourceRow.getByRole('button').filter({ has: page.locator('.anticon-delete') }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('1 subscription explicitly selects these sources')
  await expect(dialog).toContainText('1 subscription will have no selected sources and will receive no source data')
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(sourceRow).toHaveCount(0)

  await page.goto(baseURL + 'subscriptions')
  const row = page.locator('.ant-table-row').filter({ hasText: 'nowhere' })
  await expect(row).toContainText('No sources selected')
  await expect(row).not.toContainText('plc 1')
  await row.getByRole('button').first().click()
  const drawer = page.locator('.ant-drawer').filter({ hasText: 'Edit Subscription' })
  await expect(drawer.getByRole('radio', { name: 'Specific sources' })).toBeChecked()
  await expect(drawer.getByText('No sources selected. This subscription will not receive source data.')).toBeVisible()
  await expect(drawer.getByText('no longer exists')).toHaveCount(0)
})
