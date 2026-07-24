<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { LogoutOutlined, UserOutlined } from '@ant-design/icons-vue'
import AppSidebar from './AppSidebar.vue'
import { useAuth } from '@/composables/useAuth'
import { useProStatus } from '@/composables/useProStatus'
import { useDockerStatus } from '@/composables/useDockerStatus'
import { settingsApi } from '@/api/settings'

defineProps<{ title?: string; flex?: boolean }>()

const router = useRouter()
const { currentUser, logout } = useAuth()
const { fetchProStatus } = useProStatus()
const { fetchDockerStatus } = useDockerStatus()

const agentVersion = ref<string | null>(null)

async function handleLogout() {
  await logout()
  router.push('/login')
}

onMounted(async () => {
  fetchProStatus()
  fetchDockerStatus()
  try {
    const s = await settingsApi.get()
    agentVersion.value = s.agent?.version ?? null
  } catch {
    // non-fatal
  }
})
</script>

<template>
  <a-layout style="height: 100vh; overflow: hidden">
    <AppSidebar />
    <a-layout style="overflow: hidden">
      <a-layout-header class="page-header">
        <div class="header-left">
          <h2>{{ title }}</h2>
        </div>
        <div class="header-right">
          <a-tag v-if="agentVersion" class="version-badge">v{{ agentVersion }}</a-tag>
          <span class="header-user">
            <UserOutlined style="margin-right: 6px; font-size: 13px" />
            {{ currentUser?.username }}
          </span>
          <a-button type="text" size="small" class="logout-btn" @click="handleLogout">
            <template #icon><LogoutOutlined /></template>
            Sign out
          </a-button>
        </div>
      </a-layout-header>
      <a-layout-content :class="['page-content', { 'page-content--flex': flex }]">
        <slot />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<style scoped>
.page-header {
  background: #fff;
  padding: 0 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #f0f0f0;
  height: 52px;
  line-height: 52px;
}

.page-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-user {
  font-size: 13px;
  color: #666;
}

.version-badge {
  font-size: 11px;
  line-height: 18px;
  padding: 0 7px;
  height: 20px;
  background: #f5f5f5;
  border-color: #e8e8e8;
  color: #888;
  font-weight: 500;
}

.logout-btn {
  color: #888;
}

.logout-btn:hover {
  color: #1677ff !important;
}

.page-content {
  margin: 24px;
  padding: 24px;
  background: #fff;
  border-radius: 8px;
  min-height: 360px;
  overflow-y: auto;
  height: calc(100vh - 52px - 48px);
}

.page-content--flex {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}
</style>
