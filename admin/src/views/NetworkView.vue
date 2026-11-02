<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message, Modal } from 'ant-design-vue'
import type { TableColumnType } from 'ant-design-vue'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  SafetyCertificateOutlined,
  ApiOutlined,
} from '@ant-design/icons-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import {
  networkApi,
  type FirewallRule,
  type FirewallResponse,
  type PortEntry,
  type ReservedPort,
  type FirewallRuleInput,
} from '@/api/network'

const route = useRoute()
const router = useRouter()

const VALID_TABS = ['firewall', 'ports'] as const
const activeTab = ref(
  typeof route.query.tab === 'string' && (VALID_TABS as readonly string[]).includes(route.query.tab)
    ? route.query.tab
    : 'firewall',
)

watch(activeTab, (tab) => {
  router.replace({ query: tab === 'firewall' ? {} : { tab } })
})

// ── Firewall ────────────────────────────────────────────────────────────────

const firewallData = ref<FirewallResponse | null>(null)
const firewallLoading = ref(false)

const drawerOpen = ref(false)
const editingRule = ref<FirewallRule | null>(null)
const ruleForm = ref<FirewallRuleInput>({ port: '', protocol: 'tcp', interface_name: '', description: '' })
const saving = ref(false)

const firewallColumns: TableColumnType<FirewallRule>[] = [
  { title: 'Port', dataIndex: 'port', key: 'port', width: 120 },
  { title: 'Protocol', dataIndex: 'protocol', key: 'protocol', width: 100 },
  { title: 'Interface', dataIndex: 'interface_name', key: 'interface_name', width: 120 },
  { title: 'Description', dataIndex: 'description', key: 'description' },
  {
    title: 'Created',
    dataIndex: 'created_at',
    key: 'created_at',
    width: 180,
    customRender: ({ value }) => (value ? new Date(value).toLocaleString() : ''),
  },
  { title: 'Actions', key: 'actions', width: 100, fixed: 'right' },
]

const reservedColumns: TableColumnType<ReservedPort>[] = [
  { title: 'Port', dataIndex: 'port', key: 'port', width: 120 },
  { title: 'Service', dataIndex: 'service', key: 'service' },
]

async function loadFirewall() {
  firewallLoading.value = true
  try {
    firewallData.value = await networkApi.getFirewall()
  } finally {
    firewallLoading.value = false
  }
}

function openAddRule() {
  editingRule.value = null
  ruleForm.value = { port: '', protocol: 'tcp', interface_name: '', description: '' }
  drawerOpen.value = true
}

function openEditRule(rule: FirewallRule) {
  editingRule.value = rule
  ruleForm.value = {
    port: rule.port,
    protocol: rule.protocol,
    interface_name: rule.interface_name || '',
    description: rule.description || '',
  }
  drawerOpen.value = true
}

async function submitRule() {
  if (!ruleForm.value.port.trim()) {
    message.warning('Port is required')
    return
  }
  saving.value = true
  try {
    if (editingRule.value) {
      await networkApi.updateRule(editingRule.value.id, ruleForm.value)
      message.success('Rule updated')
    } else {
      await networkApi.addRule(ruleForm.value)
      message.success('Rule added')
    }
    drawerOpen.value = false
    await loadFirewall()
  } catch (err: any) {
    message.error(err?.message || 'Failed to save rule')
  } finally {
    saving.value = false
  }
}

function confirmDelete(rule: FirewallRule) {
  Modal.confirm({
    title: 'Delete Firewall Rule',
    icon: () => null,
    content: `Delete rule for port ${rule.port}/${rule.protocol}?`,
    okText: 'Delete',
    okType: 'danger',
    async onOk() {
      try {
        await networkApi.deleteRule(rule.id)
        message.success('Rule deleted')
        await loadFirewall()
      } catch (err: any) {
        message.error(err?.message || 'Failed to delete rule')
      }
    },
  })
}

// ── Ports ────────────────────────────────────────────────────────────────────

const ports = ref<PortEntry[]>([])
const portsReserved = ref<ReservedPort[]>([])
const portsLoading = ref(false)

const portsColumns: TableColumnType<PortEntry>[] = [
  { title: 'Port', dataIndex: 'port', key: 'port', width: 100, sorter: (a: PortEntry, b: PortEntry) => a.port - b.port, defaultSortOrder: 'ascend' },
  { title: 'Protocol', dataIndex: 'protocol', key: 'protocol', width: 100 },
  { title: 'Address', dataIndex: 'address', key: 'address', width: 160 },
  { title: 'Process / Container', dataIndex: 'process', key: 'process' },
  { title: 'Source', key: 'source', width: 100 },
]

async function loadPorts() {
  portsLoading.value = true
  try {
    const data = await networkApi.getPorts()
    ports.value = data.ports
    portsReserved.value = data.reservedPorts
  } finally {
    portsLoading.value = false
  }
}

function isReservedPort(port: number): boolean {
  return portsReserved.value.some((r) => r.port === port)
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

onMounted(() => {
  loadFirewall()
  loadPorts()
})
</script>

<template>
  <AppLayout title="Network">
    <a-tabs v-model:activeKey="activeTab">
      <a-tab-pane key="firewall">
        <template #tab><SafetyCertificateOutlined /> Firewall</template>

        <a-alert
          v-if="firewallData && !firewallData.available"
          message="Firewall management is not available in this deployment mode"
          type="info"
          show-icon
          style="margin-bottom: 16px"
        />

        <template v-if="firewallData?.available && firewallData.status">
          <div class="status-bar">
            <a-tag :color="firewallData.status.mode === 'on' ? 'green' : firewallData.status.mode === 'off' ? 'red' : 'blue'">
              Mode: {{ firewallData.status.mode }}
            </a-tag>
            <a-tag :color="firewallData.status.initialized ? 'green' : 'default'">
              {{ firewallData.status.initialized ? 'Active' : 'Inactive' }}
            </a-tag>
            <span class="status-label">Device API: {{ firewallData.status.deviceApiPort }}</span>
            <span v-if="firewallData.status.mqttPort" class="status-label">MQTT: {{ firewallData.status.mqttPort }}</span>
          </div>
        </template>

        <div class="section-header">
          <h3>Inbound Rules</h3>
          <a-button type="primary" :disabled="!firewallData?.available" @click="openAddRule">
            <template #icon><PlusOutlined /></template>
            Add Rule
          </a-button>
        </div>

        <a-table
          :columns="firewallColumns"
          :data-source="firewallData?.rules ?? []"
          :loading="firewallLoading"
          :pagination="false"
          row-key="id"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'protocol'">
              <a-tag>{{ (record as FirewallRule).protocol.toUpperCase() }}</a-tag>
            </template>
            <template v-else-if="column.key === 'interface_name'">
              {{ (record as FirewallRule).interface_name || '—' }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-space>
                <a-button type="text" size="small" @click="openEditRule(record as FirewallRule)">
                  <template #icon><EditOutlined /></template>
                </a-button>
                <a-button type="text" size="small" danger @click="confirmDelete(record as FirewallRule)">
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </a-space>
            </template>
          </template>
        </a-table>

        <template v-if="firewallData?.reservedPorts?.length">
          <h3 style="margin-top: 24px">Reserved Ports</h3>
          <a-table
            :columns="reservedColumns"
            :data-source="firewallData.reservedPorts"
            :pagination="false"
            row-key="port"
            size="small"
          />
        </template>
      </a-tab-pane>

      <a-tab-pane key="ports">
        <template #tab><ApiOutlined /> Ports</template>

        <a-table
          :columns="portsColumns"
          :data-source="ports"
          :loading="portsLoading"
          :pagination="false"
          row-key="port"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'port'">
              <span>{{ (record as PortEntry).port }}</span>
              <a-tag v-if="isReservedPort((record as PortEntry).port)" color="orange" style="margin-left: 6px">reserved</a-tag>
            </template>
            <template v-else-if="column.key === 'source'">
              <a-tag :color="(record as PortEntry).source === 'docker' ? 'blue' : 'default'">
                {{ (record as PortEntry).source }}
              </a-tag>
            </template>
          </template>
        </a-table>
      </a-tab-pane>
    </a-tabs>

    <!-- Add / Edit Rule Drawer -->
    <a-drawer
      :open="drawerOpen"
      :title="editingRule ? 'Edit Firewall Rule' : 'Add Inbound Rule'"
      placement="right"
      :width="420"
      @close="drawerOpen = false"
    >
      <a-form layout="vertical">
        <a-form-item label="Port or Port Range" required>
          <a-input v-model:value="ruleForm.port" placeholder="e.g. 8080 or 8080-8090" />
        </a-form-item>
        <a-form-item label="Protocol">
          <a-select v-model:value="ruleForm.protocol" :get-popup-container="(t: HTMLElement) => t.parentElement!">
            <a-select-option value="tcp">TCP</a-select-option>
            <a-select-option value="udp">UDP</a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="Interface">
          <a-input v-model:value="ruleForm.interface_name" placeholder="e.g. eth0 (optional)" />
        </a-form-item>
        <a-form-item label="Description">
          <a-input v-model:value="ruleForm.description" placeholder="Optional description" />
        </a-form-item>
      </a-form>

      <template #footer>
        <div class="drawer-footer">
          <a-button @click="drawerOpen = false">Cancel</a-button>
          <a-button type="primary" :loading="saving" @click="submitRule">
            {{ editingRule ? 'Update' : 'Add' }}
          </a-button>
        </div>
      </template>
    </a-drawer>
  </AppLayout>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.status-label {
  font-size: 13px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.65));
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.section-header h3 {
  margin: 0;
}

.drawer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
