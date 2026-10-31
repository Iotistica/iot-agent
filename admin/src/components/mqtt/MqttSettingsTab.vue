<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { message } from 'ant-design-vue'
import { SaveOutlined, CheckCircleOutlined, WifiOutlined, KeyOutlined } from '@ant-design/icons-vue'
import { client as apiClient } from '@/api/client'
import { useAuth } from '@/composables/useAuth'

const { hasRole } = useAuth()

const brokerUrl = ref('mqtt://localhost:1883')
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ connected: boolean } | null>(null)
const testError = ref<string | null>(null)

const resetOpen = ref(false)
const resetPassword = ref('')
const resetting = ref(false)

async function load() {
  try {
    const { data } = await apiClient.get('/v1/settings')
    if (data.mqttMonitor?.url) brokerUrl.value = data.mqttMonitor.url
  } catch {}
}

async function save() {
  saving.value = true
  testResult.value = null
  testError.value = null
  try {
    await apiClient.patch('/v1/mqtt/broker/config', { url: brokerUrl.value.trim() })
    message.success('MQTT broker configuration saved')
  } catch (e: any) {
    message.error(e?.response?.data?.error ?? e?.message ?? 'Save failed')
  } finally {
    saving.value = false
  }
}

async function testConnection() {
  testing.value = true
  testResult.value = null
  testError.value = null
  try {
    const { data } = await apiClient.post('/v1/mqtt/broker/test', { url: brokerUrl.value.trim() })
    if (data.ok) {
      testResult.value = { connected: true }
    } else {
      testError.value = data.error ?? 'Connection failed'
    }
  } catch (e: any) {
    testError.value = e?.response?.data?.error ?? e?.message ?? 'Test failed'
  } finally {
    testing.value = false
  }
}

function openResetPassword() {
  resetPassword.value = ''
  resetOpen.value = true
}

async function submitResetPassword() {
  if (!resetPassword.value.trim() || resetPassword.value.length < 4) return
  resetting.value = true
  try {
    await apiClient.post('/v1/mqtt/users/admin/reset-password', { password: resetPassword.value.trim() })
    message.success('Admin broker password updated — MQTT adapter will reconnect')
    resetOpen.value = false
  } catch (e: any) {
    message.error(e?.response?.data?.error ?? 'Failed to reset password')
  } finally {
    resetting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="mqtt-settings">
    <p class="intro">
      Connection settings for the local MQTT broker the agent monitors.
      Changes take effect immediately — the monitor reconnects without a restart.
    </p>

    <a-card size="small" class="settings-card" title="Local Broker Connection">
      <a-form layout="vertical">
        <a-row :gutter="[16, 0]">
          <a-col :xs="24" :lg="16">
            <a-form-item label="Broker URL" required>
              <a-input
                v-model:value="brokerUrl"
                placeholder="mqtt://localhost:1883"
                style="font-family: monospace; font-size: 13px"
              />
              <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 4px">
                Use <code>mqtt://</code> for plain TCP or <code>mqtts://</code> for TLS.
                In Docker deployments use the container hostname (e.g. <code>mqtt://iotistic-mosquitto-agent:1883</code>).
              </div>
            </a-form-item>
          </a-col>
        </a-row>

        <a-alert
          v-if="testResult?.connected"
          type="success"
          show-icon
          style="margin-bottom: 12px"
        >
          <template #icon><CheckCircleOutlined /></template>
          <template #message>Connection successful</template>
        </a-alert>
        <a-alert
          v-else-if="testError"
          type="error"
          :message="testError"
          show-icon
          style="margin-bottom: 12px"
        />
      </a-form>
    </a-card>

    <div class="save-bar">
      <a-button :loading="testing" @click="testConnection">
        <template #icon><WifiOutlined /></template>
        Test Connection
      </a-button>
      <a-button v-if="hasRole('admin')" type="primary" :loading="saving" :disabled="!brokerUrl.trim()" @click="save">
        <template #icon><SaveOutlined /></template>
        Save
      </a-button>
    </div>

    <a-card v-if="hasRole('admin')" size="small" class="settings-card" title="Broker Admin Account" style="margin-top: 20px">
      <p style="color: var(--text-secondary); margin-bottom: 12px; font-size: 13px">
        Reset the password for the MQTT broker admin account. The agent's MQTT adapter and broker monitor will automatically reconnect with the updated credentials.
      </p>
      <a-button @click="openResetPassword">
        <template #icon><KeyOutlined /></template>
        Reset Admin Password
      </a-button>
    </a-card>

    <a-drawer
      v-model:open="resetOpen"
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
            v-model:value="resetPassword"
            placeholder="New password (min 4 characters)"
            autocomplete="new-password"
            @keydown.enter.prevent="submitResetPassword"
          />
        </a-form-item>
      </a-form>
      <template #footer>
        <a-space style="justify-content: flex-end; width: 100%">
          <a-button @click="resetOpen = false">Cancel</a-button>
          <a-button
            type="primary"
            :loading="resetting"
            :disabled="!resetPassword.trim() || resetPassword.length < 4"
            @click="submitResetPassword"
          >
            <template #icon><KeyOutlined /></template>
            Update Password
          </a-button>
        </a-space>
      </template>
    </a-drawer>
  </div>
</template>

<style scoped>
.mqtt-settings { max-width: 800px; }
.intro { color: var(--text-tertiary); margin-bottom: 16px; }
.settings-card { margin-bottom: 16px; }
.settings-card :deep(.ant-card-head-title) { font-size: 14px; }
.save-bar { display: flex; gap: 8px; margin-bottom: 8px; }
</style>
