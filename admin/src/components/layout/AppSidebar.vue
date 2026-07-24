<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  DashboardOutlined,
  CloudUploadOutlined,
  PartitionOutlined,
  ApartmentOutlined,
  RadarChartOutlined,
  FundOutlined,
  FileTextOutlined,
  ContainerOutlined,
  SettingOutlined,
  TeamOutlined,
  SafetyOutlined,
  UserOutlined,
  KeyOutlined,
  QuestionCircleOutlined,
  CustomerServiceOutlined,
  WifiOutlined,
  ApiOutlined,
  ClusterOutlined,
  DatabaseOutlined,
  CodeOutlined,
  NodeIndexOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons-vue'
import IotisticaLogo from '@/components/IotisticaLogo.vue'
import { useProStatus } from '@/composables/useProStatus'
import { useSidebar } from '@/composables/useSidebar'

const route = useRoute()
const router = useRouter()

const { proInstalled } = useProStatus()
const { collapsed, toggle } = useSidebar()

const selectedKey = computed(() => route.path)

const openKeys = computed(() => {
  const keys: string[] = []
  if (route.path.startsWith('/admin')) keys.push('administration')
  if (route.path.startsWith('/user')) keys.push('user-settings')
  return keys
})

function onMenuClick({ key }: { key: string }) {
  if (key === 'help') {
    window.open('https://docs.iotistica.com/docs/intro', '_blank')
    return
  }
  router.push(key)
}
</script>

<template>
  <a-layout-sider
    :width="220"
    :collapsed="collapsed"
    :collapsed-width="64"
    collapsible
    :trigger="null"
    theme="dark"
    style="height: 100vh; background: #0a0a0a; display: flex; flex-direction: column; flex-shrink: 0;"
  >
    <div class="logo" :class="{ 'logo--collapsed': collapsed }">
      <div class="logo-row">
        <IotisticaLogo :size="24" />
        <template v-if="!collapsed">
          <span class="logo-title">Iotistica</span>
          <a-tag v-if="proInstalled" class="pro-badge">PRO</a-tag>
        </template>
      </div>
    </div>

    <div class="nav-main">
      <a-menu
        theme="dark"
        mode="inline"
        :inline-collapsed="collapsed"
        :selected-keys="[selectedKey]"
        :open-keys="openKeys"
        @click="onMenuClick"
      >
        <a-menu-item key="/dashboard">
          <template #icon><DashboardOutlined /></template>
          Dashboard
        </a-menu-item>

        <a-menu-item key="/sources">
          <template #icon><ApartmentOutlined /></template>
          Sources
        </a-menu-item>

        <a-menu-item key="/destinations">
          <template #icon><CloudUploadOutlined /></template>
          Destinations
        </a-menu-item>

        <a-menu-item key="/subscriptions">
          <template #icon><PartitionOutlined /></template>
          Subscriptions
        </a-menu-item>

        <a-menu-item key="/data-flow">
          <template #icon><NodeIndexOutlined /></template>
          Data Flow
        </a-menu-item>

        <a-menu-item key="/devices">
          <template #icon><ClusterOutlined /></template>
          Devices
        </a-menu-item>

        <a-menu-item key="/discovery-rules">
          <template #icon><RadarChartOutlined /></template>
          Discovery
          <a-tag v-if="!proInstalled" class="pro-badge">PRO</a-tag>
        </a-menu-item>

        <a-menu-item key="/applications">
          <template #icon><ContainerOutlined /></template>
          Applications
        </a-menu-item>

        <a-menu-item key="/anomaly">
          <template #icon><FundOutlined /></template>
          Anomalies
          <a-tag v-if="!proInstalled" class="pro-badge">PRO</a-tag>
        </a-menu-item>

        <a-menu-item key="/mqtt-broker">
          <template #icon><WifiOutlined /></template>
          MQTT Monitor
          <a-tag v-if="!proInstalled" class="pro-badge">PRO</a-tag>
        </a-menu-item>

        <a-menu-item key="/terminal">
          <template #icon><CodeOutlined /></template>
          Terminal
        </a-menu-item>

        <a-menu-item key="/logs">
          <template #icon><FileTextOutlined /></template>
          Logs
        </a-menu-item>

        <a-menu-item key="/settings">
          <template #icon><SettingOutlined /></template>
          Settings
        </a-menu-item>

        <a-sub-menu key="administration">
          <template #icon><SafetyOutlined /></template>
          <template #title>Administration</template>

          <a-menu-item key="/admin/users">
            <template #icon><TeamOutlined /></template>
            Users
          </a-menu-item>

          <a-menu-item key="/admin/mqtt-users">
            <template #icon><ApiOutlined /></template>
            MQTT Users
          </a-menu-item>

          <a-menu-item key="/admin/backups">
            <template #icon><DatabaseOutlined /></template>
            Backups
          </a-menu-item>
        </a-sub-menu>
      </a-menu>
    </div>

    <div class="nav-bottom">
      <a-menu
        theme="dark"
        mode="inline"
        :inline-collapsed="collapsed"
        :selected-keys="[selectedKey]"
        :open-keys="openKeys"
        @click="onMenuClick"
      >
        <a-sub-menu key="user-settings">
          <template #icon><UserOutlined /></template>
          <template #title>User</template>

          <a-menu-item key="/user/profile">
            <template #icon><UserOutlined /></template>
            Profile
          </a-menu-item>

          <a-menu-item key="/user/api-tokens">
            <template #icon><KeyOutlined /></template>
            API Tokens
          </a-menu-item>
        </a-sub-menu>

        <a-menu-item key="help">
          <template #icon><QuestionCircleOutlined /></template>
          Help
        </a-menu-item>

        <a-menu-item key="/support">
          <template #icon><CustomerServiceOutlined /></template>
          Support
          <a-tag v-if="!proInstalled" class="pro-badge">PRO</a-tag>
        </a-menu-item>
      </a-menu>
    </div>

    <div class="sidebar-footer">
      <a-button type="text" size="small" class="collapse-btn" @click="toggle">
        <template #icon>
          <MenuUnfoldOutlined v-if="collapsed" />
          <MenuFoldOutlined v-else />
        </template>
      </a-button>
    </div>

  </a-layout-sider>
</template>

<style scoped>
.logo {
  min-height: 48px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 8px 16px 8px 24px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 16px;
  font-weight: 600;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  margin-bottom: 8px;
  flex-shrink: 0;
  overflow: hidden;
}

.logo--collapsed {
  padding: 8px 0;
  align-items: center;
}

.logo--collapsed .logo-row {
  justify-content: center;
}

.logo-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.logo-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.nav-main {
  flex: 1;
  overflow-y: auto;
  background: #141414;
}

.sidebar-footer {
  flex-shrink: 0;
  padding: 8px;
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: #141414;
}

.collapse-btn {
  color: rgba(255, 255, 255, 0.45);
  font-size: 16px;
}

.collapse-btn:hover {
  color: #fff !important;
}

:deep(.ant-menu-dark),
:deep(.ant-menu-dark .ant-menu-sub),
:deep(.ant-menu-dark.ant-menu-inline) {
  background: #141414 !important;
}

.nav-bottom {
  flex-shrink: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 4px;
}

:deep(.ant-layout-sider) {
  background: #0a0a0a !important;
}

:deep(.ant-layout-sider-children) {
  display: flex;
  flex-direction: column;
}


:deep(.ant-menu-dark .ant-menu-item:not(.ant-menu-item-selected):hover) {
  background: #111111 !important;
}

.pro-badge {
  background: linear-gradient(135deg, #dc2626, #ef4444) !important;
  border: none !important;
  color: #fff !important;
  font-size: 9px !important;
  font-weight: 700 !important;
  letter-spacing: 0.06em !important;
  line-height: 14px !important;
  padding: 0 5px !important;
  height: 14px !important;
  margin-left: 6px !important;
  flex-shrink: 0 !important;
  white-space: nowrap !important;
  vertical-align: middle !important;
  border-radius: 3px !important;
}
</style>
