<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { message } from 'ant-design-vue'
import { CheckCircleOutlined, ThunderboltOutlined, StopOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import type { DiscoveredDevice, DiscoveryRule, Endpoint } from '@/types'
import { useAuth } from '@/composables/useAuth'
import { discoveryRulesApi } from '@/api/discovery'
import { sourcesApi } from '@/api/sources'
import { protocolColor, protocolLabel } from '@/utils/protocol'

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const props = withDefaults(
  defineProps<{ open: boolean; preSelectedRuleUuid?: string }>(),
  { preSelectedRuleUuid: undefined },
)

const CONFIDENCE_COLORS: Record<string, string> = { high: 'success', medium: 'warning', low: 'error' }

// ── Rule ─────────────────────────────────────────────────────────────────────
const rules = ref<DiscoveryRule[]>([])
const selectedRuleUuid = ref<string | null>(null)

// ── Existing endpoints (loaded on open for "already added" check) ─────────────
const existingEndpoints = ref<Endpoint[]>([])

const selectedRule = computed(() =>
  rules.value.find((r) => r.uuid === selectedRuleUuid.value) ?? null,
)

async function loadRules() {
  try {
    rules.value = await discoveryRulesApi.getAll()
  } catch {
    // non-fatal
  }
}

// ── Scan state ───────────────────────────────────────────────────────────────
const { hasRole } = useAuth()

const running = ref(false)
const results = ref<DiscoveredDevice[]>([])
const hasRun = ref(false)
const adding = ref<Set<string>>(new Set())
const addingAll = ref(false)
const addedThisSession = ref<Set<string>>(new Set())
let abortController: AbortController | null = null

// "Run in background" — the drawer component is always mounted by its parent
// (never v-if'd away), so a scan already keeps running after the drawer is
// closed regardless; only `close()` used to actively abort it. When this is
// checked, closing leaves the in-flight request alone instead of aborting it,
// and the reopen watcher below skips its usual reset so the results are still
// there — for the same rule — whenever the user comes back to check.
const runInBackground = ref(false)
const awaitingBackgroundResult = ref(false)
const backgroundRuleUuid = ref<string | null>(null)

// Elapsed-time counter shown next to "Scanning…" — a large scan (500+ devices)
// can genuinely take minutes with no intermediate progress available from the
// backend (BACnet's discover() only reports a count once, at the very end),
// so a static label with no movement reads as frozen. A ticking counter is the
// cheapest proof-of-life without needing real incremental progress reporting.
const scanElapsedSec = ref(0)
let scanTimer: ReturnType<typeof setInterval> | null = null

function startScanTimer() {
  scanElapsedSec.value = 0
  stopScanTimer()
  scanTimer = setInterval(() => { scanElapsedSec.value++ }, 1000)
}
function stopScanTimer() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null }
}
function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

// ── Prune (disable endpoints of this protocol not found in the scan) ──────────
const pruneEnabled = ref(false)
const pruneConfirmVisible = ref(false)
const prunePreview = ref<Array<{ name: string; protocol: string }>>([])
const pruneCommitting = ref(false)
const lastPrunedCount = ref<number | null>(null)

function stopScan() {
  abortController?.abort()
  abortController = null
  running.value = false
  stopScanTimer()
}

function isAlreadyAdded(device: DiscoveredDevice): boolean {
  if (addedThisSession.value.has(device.fingerprint)) return true
  return existingEndpoints.value.some((ep: Endpoint) =>
    (ep.fingerprint && ep.fingerprint === device.fingerprint) ||
    ep.name === device.name,
  )
}

const columns: TableColumnType<DiscoveredDevice>[] = [
  { title: 'Protocol', key: 'protocol', width: 100 },
  { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true },
  { title: 'Connection', key: 'connection', ellipsis: true },
  { title: 'Confidence', key: 'confidence', width: 100 },
  { title: '', key: 'actions', width: 80, fixed: 'right' },
]

function connSummary(d: DiscoveredDevice): string {
  const c = d.connection
  if (!c) return '—'
  if (d.protocol === 'modbus') {
    return c.type === 'rtu' ? String(c.serialPort ?? '') : `${c.host ?? ''}:${c.port ?? 502}`
  }
  if (d.protocol === 'opcua') return String(c.endpointUrl ?? '')
  if (d.protocol === 'mqtt') return String(c.host ?? c.url ?? '')
  return JSON.stringify(c).slice(0, 50)
}

function fmtInterval(s: number): string {
  if (s >= 86400) return `${s / 86400}d`
  if (s >= 3600) return `${s / 3600}h`
  if (s >= 60) return `${s / 60}m`
  return `${s}s`
}

// Large scans can run for several minutes, and something in the network path
// (not just our own request timeout) has been observed dropping connections
// held open that long — independent of whether the scan itself is still
// healthy server-side. Polling the rule's own persisted status (the same
// status/last_run_at the Discovery Rules table shows) lets us tell "the
// connection died" apart from "the scan actually failed", so a dropped
// connection can report an accurate outcome instead of a bare error.
const STATUS_POLL_MS = 5000

async function pollUntilRuleSettles(ruleUuid: string, onSettled: (rule: DiscoveryRule) => void) {
  let stopped = false
  const timer = setInterval(async () => {
    if (stopped) return
    try {
      const rules = await discoveryRulesApi.getAll()
      const match = rules.find((r) => r.uuid === ruleUuid)
      if (match && match.status !== 'running') {
        stopped = true
        clearInterval(timer)
        onSettled(match)
      }
    } catch {
      // transient poll failure — just try again next tick
    }
  }, STATUS_POLL_MS)
  return () => { stopped = true; clearInterval(timer) }
}

async function runRuleScan() {
  if (!selectedRule.value) return
  const rule = selectedRule.value
  const bgMode = runInBackground.value
  abortController = new AbortController()
  running.value = true
  awaitingBackgroundResult.value = false
  backgroundRuleUuid.value = bgMode ? rule.uuid : null
  startScanTimer()
  results.value = []
  hasRun.value = false
  pruneConfirmVisible.value = false
  prunePreview.value = []
  lastPrunedCount.value = null
  addedThisSession.value = new Set()

  const pollResult: { settled: DiscoveryRule | null } = { settled: null }
  const stopPolling = await pollUntilRuleSettles(rule.uuid, (settled) => {
    pollResult.settled = settled
  })

  try {
    // Prune dry-run: same scan, nothing gets disabled yet — just previews what
    // would be, so the confirmation modal can show exactly what's about to change.
    const { devices, prunedCount, prunedDevices } = await discoveryRulesApi.run(
      rule.uuid,
      abortController.signal,
      pruneEnabled.value ? { prune: true, pruneDryRun: true } : undefined,
    )
    results.value = devices
    existingEndpoints.value = await sourcesApi.getAll().catch(() => existingEndpoints.value)
    hasRun.value = true

    if (pruneEnabled.value && prunedCount > 0) {
      prunePreview.value = prunedDevices ?? []
      pruneConfirmVisible.value = true
    } else {
      emit('saved')
    }
  } catch (err: unknown) {
    if ((err as any)?.code === 'ERR_CANCELED' || (err as any)?.name === 'AbortError') {
      emit('saved')
      return
    }
    // The HTTP connection failed, but polling already saw the rule settle —
    // the scan itself completed (or errored) server-side regardless, we just
    // never got its response. Report what actually happened instead of a bare
    // "Discovery failed" that reads as if nothing occurred.
    if (pollResult.settled) {
      const found = pollResult.settled.last_result_json?.found ?? 0
      if (pollResult.settled.status === 'ok') {
        message.warning(`Connection dropped, but the scan finished on the agent (found ${found} device${found !== 1 ? 's' : ''}) — click Run Again to load the results.`)
      } else {
        message.error('Connection dropped, and the scan itself failed on the agent — check the Discovery Rules page for details.')
      }
      existingEndpoints.value = await sourcesApi.getAll().catch(() => existingEndpoints.value)
      emit('saved')
      return
    }
    const e = err as { message?: string }
    message.error(e?.message ?? 'Discovery failed')
    emit('saved')
  } finally {
    stopPolling()
    abortController = null
    running.value = false
    stopScanTimer()
    if (bgMode) awaitingBackgroundResult.value = true
  }
}

async function confirmPrune() {
  if (!selectedRule.value) return
  pruneCommitting.value = true
  try {
    const { prunedCount } = await discoveryRulesApi.run(selectedRule.value.uuid, undefined, {
      prune: true,
      pruneDryRun: false,
    })
    lastPrunedCount.value = prunedCount
    message.success(`Disabled ${prunedCount} endpoint${prunedCount !== 1 ? 's' : ''} not seen in this scan`)
    pruneConfirmVisible.value = false
    existingEndpoints.value = await sourcesApi.getAll().catch(() => existingEndpoints.value)
    emit('saved')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to prune endpoints')
  } finally {
    pruneCommitting.value = false
  }
}

function cancelPrune() {
  pruneConfirmVisible.value = false
  message.info('Prune skipped — nothing was disabled')
  emit('saved')
}

const connParams = computed((): Record<string, any> | null =>
  selectedRule.value?.params_json ?? null,
)

const pendingDevices = computed(() => results.value.filter((d) => !isAlreadyAdded(d)))

const ADD_ALL_BATCH_SIZE = 20

async function addAll() {
  addingAll.value = true
  const toAdd = pendingDevices.value
  let failed = 0
  // Batched, not one giant Promise.allSettled fan-out — at 500 devices that's
  // 500 simultaneous POSTs. silent=true skips the per-device toast/refresh;
  // one summary message and one list refresh cover the whole batch instead.
  for (let i = 0; i < toAdd.length; i += ADD_ALL_BATCH_SIZE) {
    const batch = toAdd.slice(i, i + ADD_ALL_BATCH_SIZE)
    const results = await Promise.allSettled(batch.map((d) => addDevice(d, { silent: true })))
    failed += results.filter((r) => r.status === 'rejected').length
  }
  addingAll.value = false
  const succeeded = toAdd.length - failed
  if (succeeded) message.success(`Added ${succeeded} source${succeeded !== 1 ? 's' : ''}`)
  if (failed) message.error(`Failed to add ${failed} source${failed !== 1 ? 's' : ''}`)
  if (toAdd.length) {
    existingEndpoints.value = await sourcesApi.getAll().catch(() => existingEndpoints.value)
    emit('saved')
  }
}

async function addDevice(device: DiscoveredDevice, opts: { silent?: boolean } = {}) {
  const key = device.fingerprint
  adding.value = new Set([...adding.value, key])
  try {
    await sourcesApi.create({
      name: device.name,
      protocol: device.protocol,
      connection: device.connection,
      data_points: device.dataPoints,
      metadata: device.metadata,
      fingerprint: device.fingerprint,
      poll_interval: 5000,
      enabled: true,
    })
    addedThisSession.value = new Set([...addedThisSession.value, key])
    if (!opts.silent) {
      message.success(`Added "${device.name}"`)
      emit('saved')
    }
  } catch (err: unknown) {
    if (opts.silent) {
      // Rethrow so addAll()'s Promise.allSettled can count it as a failure —
      // a single "Add" button click, by contrast, should always resolve.
      throw err
    }
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to add endpoint')
  } finally {
    const next = new Set(adding.value)
    next.delete(key)
    adding.value = next
  }
}

function close() {
  if (running.value) {
    if (runInBackground.value) {
      message.info('Scan continues running in the background — reopen this rule to see the results.')
      emit('update:open', false)
      return
    }
    stopScan()
  }
  results.value = []
  hasRun.value = false
  awaitingBackgroundResult.value = false
  backgroundRuleUuid.value = null
  emit('update:open', false)
}

// When opened, load rules + existing endpoints, select the pre-selected rule — do NOT auto-run
watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      const [, endpoints] = await Promise.all([
        loadRules(),
        sourcesApi.getAll().catch(() => [] as Endpoint[]),
      ])
      existingEndpoints.value = endpoints
      const targetUuid = props.preSelectedRuleUuid ?? (rules.value.length === 1 ? rules.value[0].uuid : null)
      selectedRuleUuid.value = targetUuid

      // Reopening for the same rule a backgrounded scan was started on — keep
      // its state (still running, or finished with results waiting) instead
      // of wiping it out.
      if (backgroundRuleUuid.value && backgroundRuleUuid.value === targetUuid) {
        if (!running.value) {
          backgroundRuleUuid.value = null
          awaitingBackgroundResult.value = false
        }
        return
      }

      results.value = []
      hasRun.value = false
      addedThisSession.value = new Set()
      pruneEnabled.value = false
      runInBackground.value = false
      pruneConfirmVisible.value = false
      prunePreview.value = []
      lastPrunedCount.value = null
    }
  },
)

// Switching rules mid-drawer invalidates any pending prune preview — it was
// computed against the previous rule's protocol.
watch(selectedRuleUuid, () => {
  pruneConfirmVisible.value = false
  prunePreview.value = []
  lastPrunedCount.value = null
})
</script>

<template>
  <a-drawer
    :open="open"
    title="Run Discovery"
    width="640"
    @close="close"
  >

    <!-- Rule picker -->
    <div style="margin-bottom: 20px">
      <div style="font-size: 12px; color: #888; margin-bottom: 6px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em">
        Discovery Rule
      </div>
      <a-select
        v-model:value="selectedRuleUuid"
        placeholder="Select a rule to run…"
        style="width: 100%"
        :disabled="running"
        :options="rules.map(r => ({ value: r.uuid, label: r.name }))"
        :not-found-content="rules.length === 0 ? 'No rules configured — create one on the Discovery page' : undefined"
        allow-clear
      >
        <template #option="{ value: val, label }">
          <div style="display: flex; justify-content: space-between; align-items: center">
            <span>{{ label }}</span>
            <a-tag
              :color="protocolColor(rules.find(r => r.uuid === val)?.protocol ?? '')"
              style="font-size: 11px; margin: 0"
            >
              {{ protocolLabel(rules.find(r => r.uuid === val)?.protocol ?? '') }}
            </a-tag>
          </div>
        </template>
      </a-select>
    </div>

    <!-- Rule details + run controls -->
    <template v-if="selectedRule">
      <a-descriptions :column="2" size="small" style="margin-bottom: 14px">
        <a-descriptions-item label="Protocol">
          <a-tag :color="protocolColor(selectedRule.protocol)">
            {{ protocolLabel(selectedRule.protocol) }}
          </a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="Interval">
          {{ fmtInterval(selectedRule.interval_seconds) }}
        </a-descriptions-item>
        <a-descriptions-item label="Auto-enable">
          {{ selectedRule.auto_enable ? 'Yes' : 'No' }}
        </a-descriptions-item>
        <a-descriptions-item label="Status">
          <a-badge
            :status="selectedRule.status === 'ok' ? 'success' : selectedRule.status === 'running' ? 'processing' : selectedRule.status === 'error' ? 'error' : 'default'"
            :text="selectedRule.status"
          />
        </a-descriptions-item>
      </a-descriptions>

      <!-- Connection / scan target details -->
      <div class="conn-box" style="margin-bottom: 16px">
        <div class="conn-box-title">Scan Targets</div>

        <!-- BACnet -->
        <template v-if="selectedRule.protocol === 'bacnet'">
          <div class="conn-row">
            <span class="conn-label">Targets</span>
            <span class="conn-value">
              <template v-if="connParams?.discoveryTargets?.length">
                <a-tag
                  v-for="t in (connParams.discoveryTargets as string[])"
                  :key="t"
                  style="font-family: monospace; font-size: 11px; margin-bottom: 2px"
                >{{ t }}</a-tag>
              </template>
              <span v-else class="conn-default">Broadcast — all reachable devices on local network</span>
            </span>
          </div>
          <div v-if="connParams?.timeout" class="conn-row">
            <span class="conn-label">Timeout</span>
            <span class="conn-value">{{ connParams.timeout }} ms</span>
          </div>
          <div v-if="connParams?.maxDevices" class="conn-row">
            <span class="conn-label">Max devices</span>
            <span class="conn-value">{{ connParams.maxDevices }}</span>
          </div>
        </template>

        <!-- Modbus -->
        <template v-else-if="selectedRule.protocol === 'modbus'">
          <div class="conn-row">
            <span class="conn-label">Host</span>
            <span class="conn-value">
              <span v-if="connParams?.tcpHost" class="conn-mono">
                {{ connParams.tcpHost }}{{ connParams.tcpPort ? `:${connParams.tcpPort}` : ':502' }}
              </span>
              <span v-else class="conn-default">Using global Modbus host config</span>
            </span>
          </div>
          <div v-if="connParams?.slaveIdRange" class="conn-row">
            <span class="conn-label">Slave IDs</span>
            <span class="conn-value">{{ (connParams.slaveIdRange as number[])[0] }} – {{ (connParams.slaveIdRange as number[])[1] }}</span>
          </div>
          <div v-if="connParams?.timeout" class="conn-row">
            <span class="conn-label">Timeout</span>
            <span class="conn-value">{{ connParams.timeout }} ms</span>
          </div>
        </template>

        <!-- OPC-UA -->
        <template v-else-if="selectedRule.protocol === 'opcua'">
          <template v-if="connParams?.discoveryUrls?.length">
            <div v-for="url in (connParams.discoveryUrls as string[])" :key="url" class="conn-row">
              <span class="conn-label">URL</span>
              <span class="conn-value conn-mono">{{ url }}</span>
            </div>
          </template>
          <div v-else class="conn-row">
            <span class="conn-label">URLs</span>
            <span class="conn-value conn-default">Local Discovery Server — opc.tcp://localhost:4840</span>
          </div>
        </template>

        <!-- MQTT -->
        <template v-else-if="selectedRule.protocol === 'mqtt'">
          <div class="conn-row">
            <span class="conn-label">Broker</span>
            <span class="conn-value">
              <span v-if="connParams?.brokerUrl" class="conn-mono">{{ connParams.brokerUrl }}</span>
              <span v-else class="conn-default">Using global MQTT broker config</span>
            </span>
          </div>
          <div v-if="connParams?.topics?.length" class="conn-row">
            <span class="conn-label">Topics</span>
            <span class="conn-value">
              <a-tag
                v-for="t in (connParams.topics as string[])"
                :key="t"
                style="font-family: monospace; font-size: 11px; margin-bottom: 2px"
              >{{ t }}</a-tag>
            </span>
          </div>
          <div v-if="connParams?.samplingDurationMs" class="conn-row">
            <span class="conn-label">Sampling</span>
            <span class="conn-value">{{ ((connParams.samplingDurationMs as number) / 1000).toFixed(0) }}s</span>
          </div>
        </template>

        <!-- SNMP / other -->
        <template v-else>
          <span class="conn-default">Using global {{ selectedRule.protocol.toUpperCase() }} defaults</span>
        </template>
      </div>

      <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
        <a-button
          v-if="hasRole('operator')"
          type="primary"
          :loading="running"
          :disabled="running"
          @click="runRuleScan"
        >
          <template #icon><ThunderboltOutlined /></template>
          {{ running ? `Scanning… (${fmtElapsed(scanElapsedSec)})` : hasRun ? 'Run Again' : 'Run Scan' }}
        </a-button>
        <span v-else style="color: #888; font-size: 13px">Viewers cannot run discovery scans.</span>
        <a-button v-if="running" danger @click="stopScan">
          <template #icon><StopOutlined /></template>
          Stop
        </a-button>
        <span style="color: #aaa; font-size: 12px; margin-left: 4px">
          <template v-if="running && runInBackground">Large scans can take a few minutes — you can close this panel, the scan keeps running.</template>
          <template v-else-if="running">Large scans (hundreds of devices) can take a few minutes — this isn't frozen.</template>
          <template v-else>Results are shown below — endpoints are not added automatically.</template>
        </span>
      </div>
      <div style="margin-top: 10px">
        <a-checkbox v-model:checked="runInBackground" :disabled="running">
          Run in background
        </a-checkbox>
        <a-tooltip title="Keep the scan running on the agent after you close this panel — reopen this rule to see the results.">
          <span style="color: #aaa; font-size: 12px; margin-left: 6px; cursor: help">(?)</span>
        </a-tooltip>
      </div>
      <div style="margin-top: 10px">
        <a-checkbox v-model:checked="pruneEnabled" :disabled="running">
          Disable endpoints not found in this scan
        </a-checkbox>
        <a-tooltip title="After the scan, previously-added endpoints for this protocol that no longer show up (renamed, removed, or reassigned) get disabled — not deleted. You'll see exactly what would be disabled and confirm before anything changes.">
          <span style="color: #aaa; font-size: 12px; margin-left: 6px; cursor: help">(?)</span>
        </a-tooltip>
        <div v-if="lastPrunedCount !== null" style="color: #888; font-size: 12px; margin-top: 4px">
          Last run disabled {{ lastPrunedCount }} endpoint{{ lastPrunedCount !== 1 ? 's' : '' }}.
        </div>
      </div>
    </template>

    <!-- No rule selected yet -->
    <a-empty
      v-else-if="rules.length === 0"
      description="No discovery rules configured"
      style="margin: 40px 0"
    >
      <template #extra>
        <span style="color: #888; font-size: 13px">Go to the Discovery page to create a rule first.</span>
      </template>
    </a-empty>

    <!-- ── Results ───────────────────────────────────────────────────── -->
    <template v-if="hasRun">
      <a-divider />
      <div v-if="!results.length" style="color: #999; padding: 24px 0; text-align: center">
        No devices found. Try expanding the scan range or checking network connectivity.
      </div>
      <template v-else>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px">
          <span style="color: #666; font-size: 13px">
            Found {{ results.length }} device{{ results.length !== 1 ? 's' : '' }}
          </span>
          <a-button
            v-if="pendingDevices.length > 0"
            size="small"
            type="primary"
            :loading="addingAll"
            @click="addAll"
          >
            Add All ({{ pendingDevices.length }})
          </a-button>
        </div>
        <a-table
          :columns="columns"
          :data-source="results"
          :pagination="false"
          row-key="fingerprint"
          size="small"
          :scroll="{ x: true }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'protocol'">
              <a-tag :color="protocolColor(record.protocol)">{{ protocolLabel(record.protocol) }}</a-tag>
            </template>
            <template v-else-if="column.key === 'connection'">
              <span style="font-size: 12px; color: #555">{{ connSummary(record) }}</span>
            </template>
            <template v-else-if="column.key === 'confidence'">
              <a-tag :color="CONFIDENCE_COLORS[record.confidence]">{{ record.confidence }}</a-tag>
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-button v-if="isAlreadyAdded(record)" size="small" disabled>
                <template #icon><CheckCircleOutlined style="color: #52c41a" /></template>
              </a-button>
              <a-button
                v-else
                size="small"
                type="primary"
                ghost
                :loading="adding.has(record.fingerprint)"
                @click="addDevice(record)"
              >
                Add
              </a-button>
            </template>
          </template>
        </a-table>
      </template>
    </template>

    <template #footer>
      <a-button @click="close">Close</a-button>
    </template>

    <a-modal
      :open="pruneConfirmVisible"
      title="Disable endpoints not seen in this scan?"
      ok-text="Disable them"
      ok-type="danger"
      :confirm-loading="pruneCommitting"
      :cancel-button-props="{ disabled: pruneCommitting }"
      :closable="!pruneCommitting"
      :mask-closable="false"
      @ok="confirmPrune"
      @cancel="cancelPrune"
    >
      <p>
        This scan didn't find {{ prunePreview.length }} previously-added
        {{ selectedRule?.protocol }} endpoint{{ prunePreview.length !== 1 ? 's' : '' }}. They'll be
        <strong>disabled</strong> (not deleted) — re-run discovery later and they'll come back
        automatically if they reappear.
      </p>
      <ul style="max-height: 200px; overflow-y: auto; margin: 0; padding-left: 20px">
        <li v-for="d in prunePreview" :key="d.name" style="font-family: monospace; font-size: 12px">
          {{ d.name }}
        </li>
      </ul>
    </a-modal>
  </a-drawer>
</template>

<style scoped>
.conn-box {
  padding: 12px 14px;
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 6px;
}

.conn-box-title {
  font-size: 11px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 10px;
}

.conn-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 6px;
  font-size: 13px;
}

.conn-row:last-child {
  margin-bottom: 0;
}

.conn-label {
  width: 84px;
  flex-shrink: 0;
  color: #888;
  font-size: 12px;
  padding-top: 2px;
}

.conn-value {
  flex: 1;
  color: #333;
  line-height: 1.5;
}

.conn-mono {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
}

.conn-default {
  color: #aaa;
  font-style: italic;
}
</style>
