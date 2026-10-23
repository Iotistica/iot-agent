
<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  LogoutOutlined,
  UserOutlined,
  BulbOutlined,
  BulbFilled,
  DownOutlined,
} from '@ant-design/icons-vue'

import AppSidebar from './AppSidebar.vue'
import { useAuth } from '@/composables/useAuth'
import { useProStatus } from '@/composables/useProStatus'
import { useDockerStatus } from '@/composables/useDockerStatus'
import { useTheme } from '@/composables/useTheme'
import { settingsApi } from '@/api/settings'

defineProps<{
  title?: string
  flex?: boolean
}>()

const router = useRouter()

const { currentUser, logout } = useAuth()
const { fetchProStatus } = useProStatus()
const { fetchDockerStatus } = useDockerStatus()
const { isDark, toggle: toggleTheme } = useTheme()

const agentVersion = ref<string | null>(null)

const username = computed(() => {
  return currentUser.value?.username || 'User'
})

const userInitial = computed(() => {
  return username.value.charAt(0).toUpperCase()
})

async function handleLogout() {
  await logout()
  await router.push('/login')
}

function handleUserMenu({
  key,
}: {
  key: string | number
}) {
  if (key === 'logout') {
    void handleLogout()
  }
}

onMounted(async () => {
  fetchProStatus()
  fetchDockerStatus()

  try {
    const settings = await settingsApi.get()
    agentVersion.value = settings.agent?.version ?? null
  } catch {
    // Version is optional
  }
})
</script>

<template>
  <a-layout class="app-layout">
    <AppSidebar />

    <a-layout class="main-layout">
      <!-- Main application header -->
      <a-layout-header class="page-header">
        <div class="header-left">
          <span
            v-if="title"
            class="title-accent"
            aria-hidden="true"
          />

          <h2 v-if="title" class="page-title">
            {{ title }}
          </h2>
        </div>

        <div class="header-right">
          <!-- Theme toggle -->
          <a-tooltip
            :title="
              isDark
                ? 'Switch to light mode'
                : 'Switch to dark mode'
            "
          >
            <a-button
              type="text"
              class="theme-btn"
              :aria-label="
                isDark
                  ? 'Switch to light mode'
                  : 'Switch to dark mode'
              "
              @click="toggleTheme"
            >
              <template #icon>
                <BulbFilled v-if="isDark" />
                <BulbOutlined v-else />
              </template>
            </a-button>
          </a-tooltip>

          <!-- Version -->
          <a-tag
            v-if="agentVersion"
            class="version-badge"
          >
            v{{ agentVersion }}
          </a-tag>

          <span
            class="header-divider"
            aria-hidden="true"
          />

          <!-- Account menu -->
          <a-dropdown
            :trigger="['click']"
            placement="bottomRight"
          >
            <button
              type="button"
              class="user-trigger"
              aria-label="Open account menu"
              aria-haspopup="menu"
            >
              <a-avatar
                :size="36"
                class="user-avatar"
              >
                {{ userInitial }}
              </a-avatar>

              <span class="username">
                {{ username }}
              </span>

              <DownOutlined class="dropdown-arrow" />
            </button>

            <template #overlay>
              <a-menu @click="handleUserMenu">
                <a-menu-item
                  key="user-info"
                  disabled
                >
                  <UserOutlined />
                  {{ username }}
                </a-menu-item>

                <a-menu-divider />

                <a-menu-item key="logout">
                  <LogoutOutlined />
                  Sign out
                </a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
        </div>
      </a-layout-header>

      <!-- Page content -->
      <a-layout-content
        :class="[
          'page-content',
          { 'page-content--flex': flex },
        ]"
      >
        <slot />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<style scoped>
/* ============================
   APPLICATION LAYOUT
============================ */

.app-layout {
  height: 100vh;
  overflow: hidden;
  background: var(--bg-body);
}

.main-layout {
  min-width: 0;
  height: 100%;
  overflow: hidden;
  background: var(--bg-body);
}

/* ============================
   HEADER
============================ */

.page-header {
  height: var(--app-header-height, 72px);
  min-height: var(--app-header-height, 72px);
  flex: 0 0 var(--app-header-height, 72px);

  padding: 0 24px;
  box-sizing: border-box;

  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;

  line-height: normal;

  background: var(--bg-app-header);
  border-bottom: 1px solid var(--border-app-header);
}

/* ============================
   LEFT HEADER
============================ */

.header-left {
  display: flex;
  align-items: center;
  gap: 14px;

  min-width: 0;
  height: 100%;
}

.title-accent {
  display: block;

  width: 4px;
  height: 30px;

  flex-shrink: 0;

  border-radius: 2px;
  background: var(--app-header-accent, #1677ff);
}

.page-title {
  margin: 0;

  font-size: 18px;
  font-weight: 600;
  line-height: 22px;

  color: var(--text-primary);

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ============================
   RIGHT HEADER
============================ */

.header-right {
  display: flex;
  align-items: center;
  gap: 20px;

  flex-shrink: 0;
}

/* Theme toggle */

.theme-btn {
  width: 32px;
  height: 32px;

  display: inline-flex;
  align-items: center;
  justify-content: center;

  padding: 0;

  color: var(--text-tertiary);
  font-size: 16px;
}

.theme-btn:hover {
  color: #faad14 !important;
}

/* Version badge */

.version-badge {
  margin: 0;

  height: 28px;
  padding: 0 8px;

  display: inline-flex;
  align-items: center;

  font-size: 13px;
  line-height: 1;
  font-weight: 500;

  color: var(--text-tertiary);
  background: var(--bg-subtle);

  border: 1px solid var(--border-color);
  border-radius: 5px;
}

/* Divider */

.header-divider {
  width: 1px;
  height: 20px;

  background: var(--border-app-header);
}

/* ============================
   ACCOUNT DROPDOWN
============================ */

.user-trigger {
  display: inline-flex;
  align-items: center;
  gap: 9px;

  padding: 4px 6px;

  border: none;
  border-radius: 6px;

  background: transparent;
  color: var(--text-primary);

  font: inherit;
  cursor: pointer;

  transition: background-color 0.2s ease;
}

.user-trigger:hover {
  background: var(--bg-subtle);
}

.user-trigger:focus-visible {
  outline: 2px solid #1677ff;
  outline-offset: 2px;
}

.user-avatar {
  background: #596fb5;
  color: #ffffff;

  font-size: 14px;
  font-weight: 600;

  flex-shrink: 0;
}

.username {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.dropdown-arrow {
  margin-left: 2px;

  font-size: 10px;
  color: var(--text-tertiary);
}

/* ============================
   PAGE CONTENT
============================ */

.page-content {
  flex: 1;
  min-height: 0;

  margin: 20px;
  padding: 24px;

  background: var(--bg-container);
  border-radius: 8px;

  overflow-y: auto;
}

.page-content--flex {
  display: flex;
  flex-direction: column;

  min-height: 0;
  overflow: hidden;
}

/* ============================
   RESPONSIVE
============================ */

@media (max-width: 768px) {
  .page-header {
    padding: 0 16px;
  }

  .header-right {
    gap: 8px;
  }

  .username,
  .dropdown-arrow,
  .header-divider {
    display: none;
  }

  .page-content {
    margin: 12px;
    padding: 16px;
  }
}
</style>
