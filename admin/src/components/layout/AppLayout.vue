<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { LogoutOutlined, UserOutlined, BulbOutlined, BulbFilled } from '@ant-design/icons-vue'
import AppSidebar from './AppSidebar.vue'
import { useAuth } from '@/composables/useAuth'
import { useProStatus } from '@/composables/useProStatus'
import { useDockerStatus } from '@/composables/useDockerStatus'
import { useTheme } from '@/composables/useTheme'
import { settingsApi } from '@/api/settings'

defineProps<{ title?: string; flex?: boolean }>()

const router = useRouter()
const { currentUser, logout } = useAuth()
const { fetchProStatus } = useProStatus()
const { fetchDockerStatus } = useDockerStatus()
const { isDark, toggle: toggleTheme } = useTheme()

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
  <a-layout style="height: 100vh; overflow: hidden; background: var(--bg-body)">
    <AppSidebar />
    <a-layout style="overflow: hidden; background: var(--bg-body)">
      <a-layout-header class="page-header">
        <div class="header-left">
          <h2>{{ title }}</h2>
        </div>
        <div class="header-right">
          <a-button type="text" size="small" class="theme-btn" :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'" @click="toggleTheme">
            <template #icon>
              <BulbFilled v-if="isDark" />
              <BulbOutlined v-else />
            </template>
          </a-button>
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
  background: var(--bg-container);
  padding: 0 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border-color);
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
  color: var(--text-tertiary);
}

.version-badge {
  font-size: 11px;
  line-height: 18px;
  padding: 0 7px;
  height: 20px;
  background: var(--bg-subtle);
  border-color: var(--border-color);
  color: var(--text-tertiary);
  font-weight: 500;
}

.theme-btn {
  color: var(--text-tertiary);
  font-size: 16px;
}

.theme-btn:hover {
  color: #faad14 !important;
}

.logout-btn {
  color: var(--text-tertiary);
}

.logout-btn:hover {
  color: #1677ff !important;
}

.page-content {
  margin: 24px;
  padding: 24px;
  background: var(--bg-container);
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
