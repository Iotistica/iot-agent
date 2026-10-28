<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, DeleteOutlined, KeyOutlined, StopOutlined, CheckCircleOutlined, WifiOutlined, CrownOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { usersApi, sessionsApi, type User, type Session } from '@/api/users'
import { client as apiClient } from '@/api/client'
import type { UserRole } from '@/api/auth'

// ── Users ─────────────────────────────────────────────────────────────────────

const route = useRoute()
const router = useRouter()

const VALID_TABS = ['users', 'sessions', 'mqtt'] as const
const initTab = VALID_TABS.includes(route.query.tab as any) ? route.query.tab as string : 'users'
const activeTab = ref(initTab)

watch(activeTab, (tab) => {
  router.replace({ query: tab === 'users' ? {} : { tab } })
})

const rows = ref<User[]>([])
const loading = ref(false)
const selectedUsernames = ref<string[]>([])
const deletingUsers = ref(false)
const bulkActivating = ref(false)
const bulkDeactivating = ref(false)

const userRowSelection = computed(() => ({
  selectedRowKeys: selectedUsernames.value,
  onChange: (keys: (string | number)[]) => { selectedUsernames.value = keys as string[] },
}))

const ROLE_OPTIONS: { value: UserRole; label: string; hint: string }[] = [
  { value: 'viewer', label: 'Viewer', hint: 'Read-only — dashboards, live values, alarms. No changes.' },
  { value: 'operator', label: 'Operator', hint: 'Day-to-day control — devices, discovery, destinations, config. Not user/security management.' },
  { value: 'admin', label: 'Admin', hint: 'Full access, including users, sessions, backups, and security settings.' },
]
const ROLE_TAG_COLOR: Record<UserRole, string> = { viewer: 'default', operator: 'blue', admin: 'gold' }

const createOpen = ref(false)
const createForm = ref<{ username: string; password: string; role: UserRole }>({ username: '', password: '', role: 'operator' })
const creating = ref(false)

const resetTarget = ref<string | null>(null)
const resetPassword = ref('')
const resetting = ref(false)

const userColumns: TableColumnType<User>[] = [
  { title: 'Username', dataIndex: 'username', key: 'username' },
  { title: 'Role', key: 'role', width: 130 },
  { title: 'Active', key: 'is_active', width: 90 },
  { title: 'Created', dataIndex: 'created_at', key: 'created_at', width: 180,
    customRender: ({ value }) => new Date(value).toLocaleString() },
  { title: 'Actions', key: 'actions', width: 120, fixed: 'right' },
]

async function loadUsers() {
  loading.value = true
  try {
    rows.value = await usersApi.getAll()
  } finally {
    loading.value = false
  }
}

async function toggleActive(row: User) {
  try {
    await usersApi.update(row.username, { is_active: !row.is_active })
    await loadUsers()
  } catch {
    message.error('Failed to update')
  }
}

function openCreate() {
  createForm.value = { username: '', password: '', role: 'operator' }
  createOpen.value = true
}

async function changeRole(row: User, role: UserRole) {
  try {
    await usersApi.update(row.username, { role })
    message.success('Role updated')
    await loadUsers()
  } catch {
    message.error('Failed to update role')
  }
}

async function submitCreate() {
  if (!createForm.value.username.trim() || !createForm.value.password) return
  creating.value = true
  try {
    await usersApi.create(createForm.value)
    message.success('User created')
    createOpen.value = false
    await loadUsers()
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } } }
    message.error(e?.response?.data?.error ?? 'Failed to create user')
  } finally {
    creating.value = false
  }
}

function openReset(username: string) {
  resetTarget.value = username
  resetPassword.value = ''
}

async function submitReset() {
  if (!resetTarget.value || !resetPassword.value) return
  resetting.value = true
  try {
    await usersApi.update(resetTarget.value, { password: resetPassword.value })
    message.success('Password updated')
    resetTarget.value = null
  } catch {
    message.error('Failed to update password')
  } finally {
    resetting.value = false
  }
}

function confirmDelete(row: User) {
  Modal.confirm({
    title: `Delete user "${row.username}"?`,
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await usersApi.remove(row.username)
      message.success('User deleted')
      await loadUsers()
    },
  })
}

function confirmDeleteSelectedUsers() {
  const count = selectedUsernames.value.length
  Modal.confirm({
    title: `Delete ${count} user${count !== 1 ? 's' : ''}?`,
    okType: 'danger',
    okText: `Delete ${count}`,
    async onOk() {
      deletingUsers.value = true
      try {
        await Promise.allSettled(selectedUsernames.value.map((u) => usersApi.remove(u)))
        selectedUsernames.value = []
        message.success(`Deleted ${count} user${count !== 1 ? 's' : ''}`)
        await loadUsers()
      } finally {
        deletingUsers.value = false
      }
    },
  })
}

async function bulkActivate() {
  const usernames = [...selectedUsernames.value]
  bulkActivating.value = true
  try {
    await Promise.allSettled(usernames.map((u) => usersApi.update(u, { is_active: true })))
    selectedUsernames.value = []
    message.success(`Activated ${usernames.length} user${usernames.length !== 1 ? 's' : ''}`)
    await loadUsers()
  } finally {
    bulkActivating.value = false
  }
}

async function bulkDeactivate() {
  const usernames = [...selectedUsernames.value]
  bulkDeactivating.value = true
  try {
    await Promise.allSettled(usernames.map((u) => usersApi.update(u, { is_active: false })))
    selectedUsernames.value = []
    message.success(`Deactivated ${usernames.length} user${usernames.length !== 1 ? 's' : ''}`)
    await loadUsers()
  } finally {
    bulkDeactivating.value = false
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────────

const sessions = ref<Session[]>([])
const sessionsLoading = ref(false)

const sessionColumns: TableColumnType<Session>[] = [
  { title: 'User', dataIndex: 'username', key: 'username' },
  { title: 'Logged in', dataIndex: 'created_at', key: 'created_at', width: 180,
    customRender: ({ value }) => new Date(value).toLocaleString() },
  { title: 'Expires', dataIndex: 'expires_at', key: 'expires_at', width: 180,
    customRender: ({ value }) => new Date(value).toLocaleString() },
  { title: 'Status', key: 'active', width: 100 },
  { title: 'Actions', key: 'actions', width: 90, fixed: 'right' },
]

async function loadSessions() {
  sessionsLoading.value = true
  try {
    sessions.value = await sessionsApi.getAll()
  } finally {
    sessionsLoading.value = false
  }
}

function confirmRevoke(row: Session) {
  Modal.confirm({
    title: `Revoke session for "${row.username}"?`,
    content: 'The user will be logged out immediately.',
    okType: 'danger',
    okText: 'Revoke',
    async onOk() {
      await sessionsApi.revoke(row.token_id)
      message.success('Session revoked')
      await loadSessions()
    },
  })
}

// ── MQTT Users ───────────────────────────────────────────────────────────────

interface MqttUser {
  username: string
  topic: string
  access: 'read' | 'write' | 'readwrite'
  superuser: boolean
  endpointUuid: string | null
  endpointName: string | null
}

const mqttRows = ref<MqttUser[]>([])
const mqttLoading = ref(false)
const mqttSelectedUsernames = ref<string[]>([])
const mqttDeleting = ref(false)

const mqttRowSelection = computed(() => ({
  selectedRowKeys: mqttSelectedUsernames.value,
  onChange: (keys: (string | number)[]) => { mqttSelectedUsernames.value = keys as string[] },
  getCheckboxProps: (record: MqttUser) => ({ disabled: record.superuser }),
}))

const mqttCreateOpen = ref(false)
const mqttCreateForm = ref({ username: '', password: '', topic: '' })
const mqttCreating = ref(false)

const mqttColumns: TableColumnType<MqttUser>[] = [
  { title: 'Username', dataIndex: 'username', key: 'username' },
  { title: 'Topic Pattern', dataIndex: 'topic', key: 'topic' },
  { title: 'Access', dataIndex: 'access', key: 'access', width: 110 },
  { title: 'Role', key: 'role', width: 100 },
  { title: 'Actions', key: 'actions', width: 150, fixed: 'right' },
]

async function loadMqttUsers() {
  mqttLoading.value = true
  try {
    const { data } = await apiClient.get('/v1/mqtt/users')
    mqttRows.value = data.users
  } finally {
    mqttLoading.value = false
  }
}

function openMqttCreate() {
  mqttCreateForm.value = { username: '', password: '', topic: '' }
  mqttCreateOpen.value = true
}

async function submitMqttCreate() {
  if (!mqttCreateForm.value.username.trim() || !mqttCreateForm.value.password.trim()) return
  mqttCreating.value = true
  try {
    await apiClient.post('/v1/mqtt/users', {
      username: mqttCreateForm.value.username.trim(),
      password: mqttCreateForm.value.password.trim(),
      ...(mqttCreateForm.value.topic.trim() ? { topic: mqttCreateForm.value.topic.trim() } : {}),
    })
    message.success('MQTT user created')
    mqttCreateOpen.value = false
    await loadMqttUsers()
  } catch (e: any) {
    message.error(e?.response?.data?.error ?? 'Failed to create user')
  } finally {
    mqttCreating.value = false
  }
}

function confirmMqttDelete(row: MqttUser) {
  Modal.confirm({
    title: `Delete "${row.username}"?`,
    content: 'This will remove the user from the MQTT broker. Connected clients using these credentials will be disconnected.',
    okText: 'Delete',
    okType: 'danger',
    onOk: () => deleteMqttUser(row),
  })
}

async function deleteMqttUser(row: MqttUser) {
  try {
    await apiClient.delete(`/v1/mqtt/users/${encodeURIComponent(row.username)}`)
    message.success(`User "${row.username}" removed`)
    await loadMqttUsers()
  } catch (e: any) {
    message.error(e?.response?.data?.error ?? 'Failed to delete user')
  }
}

function confirmDeleteSelectedMqttUsers() {
  const count = mqttSelectedUsernames.value.length
  Modal.confirm({
    title: `Delete ${count} MQTT user${count !== 1 ? 's' : ''}?`,
    content: 'Connected clients using these credentials will be disconnected.',
    okType: 'danger',
    okText: `Delete ${count}`,
    async onOk() {
      mqttDeleting.value = true
      try {
        await Promise.allSettled(
          mqttSelectedUsernames.value.map((u) => apiClient.delete(`/v1/mqtt/users/${encodeURIComponent(u)}`))
        )
        mqttSelectedUsernames.value = []
        message.success(`Deleted ${count} MQTT user${count !== 1 ? 's' : ''}`)
        await loadMqttUsers()
      } finally {
        mqttDeleting.value = false
      }
    },
  })
}

const mqttResetOpen = ref(false)
const mqttResetPassword = ref('')
const mqttResetting = ref(false)

function openMqttResetPassword() {
  mqttResetPassword.value = ''
  mqttResetOpen.value = true
}

async function submitMqttResetPassword() {
  if (!mqttResetPassword.value.trim() || mqttResetPassword.value.length < 4) return
  mqttResetting.value = true
  try {
    await apiClient.post('/v1/mqtt/users/admin/reset-password', { password: mqttResetPassword.value.trim() })
    message.success('Admin broker password updated — MQTT adapter will reconnect')
    mqttResetOpen.value = false
  } catch (e: any) {
    message.error(e?.response?.data?.error ?? 'Failed to reset password')
  } finally {
    mqttResetting.value = false
  }
}

function onTabChange(key: string) {
  if (key === 'sessions') loadSessions()
  if (key === 'mqtt') loadMqttUsers()
}

onMounted(() => {
  loadUsers()
  if (activeTab.value === 'sessions') loadSessions()
  if (activeTab.value === 'mqtt') loadMqttUsers()
})
</script>

<template>
  <AppLayout title="Users">
    <div class="heading">
      <p>Manage admin panel accounts, sessions, and MQTT broker credentials.</p>
      <div class="header-actions">
        <template v-if="activeTab === 'users' && selectedUsernames.length > 0">
          <span style="font-size: 13px; color: var(--text-secondary)">{{ selectedUsernames.length }} selected</span>
          <a-button :loading="bulkActivating" @click="bulkActivate"><template #icon><CheckCircleOutlined /></template>Activate</a-button>
          <a-button :loading="bulkDeactivating" @click="bulkDeactivate"><template #icon><StopOutlined /></template>Deactivate</a-button>
          <a-button danger :loading="deletingUsers" @click="confirmDeleteSelectedUsers"><template #icon><DeleteOutlined /></template>Delete</a-button>
        </template>
        <a-button v-if="activeTab === 'users'" type="primary" @click="openCreate"><template #icon><PlusOutlined /></template>New User</a-button>

        <template v-if="activeTab === 'mqtt' && mqttSelectedUsernames.length > 0">
          <span style="font-size: 13px; color: var(--text-secondary)">{{ mqttSelectedUsernames.length }} selected</span>
          <a-button danger :loading="mqttDeleting" @click="confirmDeleteSelectedMqttUsers"><template #icon><DeleteOutlined /></template>Delete</a-button>
        </template>
        <a-button v-if="activeTab === 'mqtt'" type="primary" @click="openMqttCreate"><template #icon><PlusOutlined /></template>Add MQTT User</a-button>
      </div>
    </div>

    <a-tabs v-model:activeKey="activeTab" @change="onTabChange">

      <!-- ── Users tab ──────────────────────────────────────────────────────── -->
      <a-tab-pane key="users" tab="Users">
        <a-card size="small" class="list-card">
        <a-table
          :columns="userColumns"
          :data-source="rows"
          :loading="loading"
          :pagination="{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }"
          :row-selection="userRowSelection"
          row-key="username"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'role'">
              <a-select
                :value="record.role"
                size="small"
                style="width: 110px"
                @change="(v: unknown) => changeRole(record, v as UserRole)"
              >
                <a-select-option v-for="opt in ROLE_OPTIONS" :key="opt.value" :value="opt.value">
                  <a-tag :color="ROLE_TAG_COLOR[opt.value]" style="margin: 0">{{ opt.label }}</a-tag>
                </a-select-option>
              </a-select>
            </template>

            <template v-else-if="column.key === 'is_active'">
              <a-switch
                :checked="record.is_active"
                size="small"
                @change="toggleActive(record)"
              />
            </template>

            <template v-else-if="column.key === 'actions'">
              <a-space>
                <a-tooltip title="Reset password">
                  <a-button size="small" @click="openReset(record.username)">
                    <template #icon><KeyOutlined /></template>
                  </a-button>
                </a-tooltip>
                <a-button size="small" danger @click="confirmDelete(record)">
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </a-space>
            </template>
          </template>
        </a-table>
        </a-card>
      </a-tab-pane>

      <!-- ── Sessions tab ───────────────────────────────────────────────────── -->
      <a-tab-pane key="sessions" tab="Sessions">
        <a-card size="small" class="list-card">
        <div class="toolbar-info" style="display: flex; justify-content: space-between; align-items: center">
          <span>{{ sessions.length }} session{{ sessions.length !== 1 ? 's' : '' }}</span>
          <a-button size="small" :loading="sessionsLoading" @click="loadSessions">Refresh</a-button>
        </div>
        <a-table
          :columns="sessionColumns"
          :data-source="sessions"
          :loading="sessionsLoading"
          :pagination="{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }"
          row-key="token_id"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'active'">
              <a-tag :color="record.active ? 'green' : 'default'">
                {{ record.active ? 'Active' : 'Expired' }}
              </a-tag>
            </template>

            <template v-else-if="column.key === 'actions'">
              <a-tooltip :title="record.active ? 'Revoke session' : 'Already expired'">
                <a-button
                  size="small"
                  danger
                  :disabled="!record.active"
                  @click="confirmRevoke(record)"
                >
                  <template #icon><StopOutlined /></template>
                </a-button>
              </a-tooltip>
            </template>
          </template>
        </a-table>
        </a-card>
      </a-tab-pane>

      <!-- ── MQTT Users tab ────────────────────────────────────────────────── -->
      <a-tab-pane key="mqtt" tab="MQTT Users">
        <a-card size="small" class="list-card">
        <a-table
          :dataSource="mqttRows"
          :columns="mqttColumns"
          :loading="mqttLoading"
          :pagination="{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }"
          :row-selection="mqttRowSelection"
          rowKey="username"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'topic'">
              <code style="font-size: 12px; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px;">{{ record.topic }}</code>
            </template>

            <template v-else-if="column.key === 'access'">
              <a-tag :color="record.access === 'readwrite' ? 'blue' : record.access === 'write' ? 'green' : 'default'">
                {{ record.access }}
              </a-tag>
            </template>

            <template v-else-if="column.key === 'role'">
              <span v-if="record.superuser" style="color: #faad14; display: flex; align-items: center; gap: 4px;">
                <CrownOutlined /> Admin
              </span>
              <span v-else style="color: var(--text-tertiary);">Client</span>
            </template>

            <template v-else-if="column.key === 'actions'">
              <a-button v-if="record.superuser" size="small" type="link" @click="openMqttResetPassword">
                <template #icon><KeyOutlined /></template>
                Reset Password
              </a-button>
              <a-button v-else size="small" danger @click="confirmMqttDelete(record)">
                <template #icon><DeleteOutlined /></template>
              </a-button>
            </template>
          </template>
        </a-table>
        </a-card>
      </a-tab-pane>

    </a-tabs>

    <!-- Create user drawer -->
    <a-drawer
      :open="createOpen"
      title="New User"
      width="400"
      @close="createOpen = false"
    >
      <a-form layout="vertical" autocomplete="off">
        <a-form-item label="Username" required>
          <a-input v-model:value="createForm.username" placeholder="e.g. operator1" />
        </a-form-item>
        <a-form-item label="Password" required extra="Minimum 6 characters">
          <a-input-password v-model:value="createForm.password" />
        </a-form-item>
        <a-form-item label="Role">
          <a-select v-model:value="createForm.role" style="width: 100%">
            <a-select-option v-for="opt in ROLE_OPTIONS" :key="opt.value" :value="opt.value">
              <div>
                <a-tag :color="ROLE_TAG_COLOR[opt.value]" style="margin: 0">{{ opt.label }}</a-tag>
              </div>
            </a-select-option>
          </a-select>
          <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 6px">
            {{ ROLE_OPTIONS.find(o => o.value === createForm.role)?.hint }}
          </div>
        </a-form-item>
      </a-form>
      <template #footer>
        <a-space style="justify-content: flex-end; width: 100%">
          <a-button @click="createOpen = false">Cancel</a-button>
          <a-button type="primary" :loading="creating" @click="submitCreate">Create</a-button>
        </a-space>
      </template>
    </a-drawer>

    <!-- Reset password modal -->
    <a-modal
      :open="resetTarget !== null"
      :title="`Reset password — ${resetTarget}`"
      ok-text="Update"
      :confirm-loading="resetting"
      @ok="submitReset"
      @cancel="resetTarget = null"
    >
      <a-form layout="vertical" style="margin-top: 8px">
        <a-form-item label="New password" extra="Minimum 6 characters">
          <a-input-password v-model:value="resetPassword" />
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- Add MQTT User Drawer -->
    <a-drawer
      v-model:open="mqttCreateOpen"
      title="Add MQTT User"
      placement="right"
      :width="400"
    >
      <a-form layout="vertical">
        <a-form-item label="Username" required>
          <a-input
            v-model:value="mqttCreateForm.username"
            placeholder="e.g. my-device"
            autocomplete="off"
          />
        </a-form-item>

        <a-form-item label="Password" required>
          <a-input-password
            v-model:value="mqttCreateForm.password"
            placeholder="Strong password"
            autocomplete="new-password"
          />
        </a-form-item>

        <a-form-item label="Topic Pattern" extra="Leave blank to allow publish to all topics under i/#">
          <a-input
            v-model:value="mqttCreateForm.topic"
            placeholder="i/tenant/a/agent/d/device (optional)"
          />
        </a-form-item>
      </a-form>

      <template #footer>
        <a-space style="justify-content: flex-end; width: 100%">
          <a-button @click="mqttCreateOpen = false">Cancel</a-button>
          <a-button
            type="primary"
            :loading="mqttCreating"
            :disabled="!mqttCreateForm.username.trim() || !mqttCreateForm.password.trim()"
            @click="submitMqttCreate"
          >
            <template #icon><WifiOutlined /></template>
            Create User
          </a-button>
        </a-space>
      </template>
    </a-drawer>

    <!-- Reset MQTT Admin Password Drawer -->
    <a-drawer
      v-model:open="mqttResetOpen"
      title="Reset Broker Password"
      placement="right"
      :width="400"
    >
      <p style="color: var(--text-secondary); margin-bottom: 16px;">
        Set a new password for the MQTT broker admin account. The agent's MQTT adapter will automatically reconnect with the updated credentials.
      </p>
      <a-form layout="vertical">
        <a-form-item label="New Password" required>
          <a-input-password
            v-model:value="mqttResetPassword"
            placeholder="New password (min 4 characters)"
            autocomplete="new-password"
            @keydown.enter.prevent="submitMqttResetPassword"
          />
        </a-form-item>
      </a-form>
      <template #footer>
        <a-space style="justify-content: flex-end; width: 100%">
          <a-button @click="mqttResetOpen = false">Cancel</a-button>
          <a-button
            type="primary"
            :loading="mqttResetting"
            :disabled="!mqttResetPassword.trim() || mqttResetPassword.length < 4"
            @click="submitMqttResetPassword"
          >
            <template #icon><KeyOutlined /></template>
            Update Password
          </a-button>
        </a-space>
      </template>
    </a-drawer>
  </AppLayout>
</template>

<style scoped>
.heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
.heading p { color: var(--text-tertiary); margin: 0; }
.header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.list-card { border-radius: 9px; }
.list-card :deep(.ant-table-thead > tr > th) { background: var(--bg-table-header); font-size: 12px; font-weight: 650; }
.list-card :deep(.ant-table-tbody > tr:hover > td) { background: var(--bg-table-hover); }
.toolbar-info { color: var(--text-tertiary); font-size: 12px; margin-bottom: 10px; }
</style>
