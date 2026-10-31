<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { DeleteOutlined, EditOutlined, PlusOutlined, RocketOutlined, SearchOutlined } from '@ant-design/icons-vue'
import { templatesApi, type AppTemplate } from '@/api/containers'
import { useAuth } from '@/composables/useAuth'
import { useDockerStatus } from '@/composables/useDockerStatus'

const emit = defineEmits<{ deploy: [template: AppTemplate] }>()

const { hasRole } = useAuth()
const { dockerAvailable } = useDockerStatus()
const canManage = computed(() => hasRole('admin'))
const templates = ref<AppTemplate[]>([])
const categories = ref<string[]>(['All'])
const category = ref('All')
const search = ref('')
const loading = ref(false)
const error = ref('')
const formOpen = ref(false)
const saving = ref(false)
const editingId = ref<string | null>(null)

const blankTemplate = (): AppTemplate => ({
  id: '',
  name: '',
  category: '',
  description: '',
  color: '#1677ff',
  letter: '',
  appName: '',
  services: [{ serviceName: '', image: '' }],
})

const form = ref<AppTemplate>(blankTemplate())
const servicesJson = ref('[]')

const CATEGORY_COLOR: Record<string, string> = {
  Automation: 'orange',
  Monitoring: 'blue',
  'Time Series': 'purple',
  MQTT: 'cyan',
  Management: 'geekblue',
  'IoT Platform': 'green',
  Database: 'red',
  AI: 'volcano',
  Iotistica: 'purple',
}

const filteredTemplates = computed(() => {
  const query = search.value.trim().toLowerCase()
  return templates.value.filter(template => {
    const matchesCategory = category.value === 'All' || template.category === category.value
    const matchesSearch = !query ||
      template.name.toLowerCase().includes(query) ||
      template.description.toLowerCase().includes(query) ||
      template.category.toLowerCase().includes(query)
    return matchesCategory && matchesSearch
  })
})

function errorText(error: unknown): string {
  const err = error as { response?: { data?: { error?: string } }; message?: string }
  return err.response?.data?.error ?? err.message ?? 'Marketplace request failed'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await templatesApi.getAll()
    templates.value = result.templates
    categories.value = result.categories
    if (!categories.value.includes(category.value)) category.value = 'All'
  } catch (err) {
    error.value = errorText(err)
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editingId.value = null
  form.value = blankTemplate()
  servicesJson.value = JSON.stringify(form.value.services, null, 2)
  formOpen.value = true
}

function openEdit(template: AppTemplate) {
  editingId.value = template.id
  form.value = JSON.parse(JSON.stringify(template)) as AppTemplate
  servicesJson.value = JSON.stringify(template.services, null, 2)
  formOpen.value = true
}

function requestDeploy(template: AppTemplate) {
  if (dockerAvailable.value) emit('deploy', template)
}

async function save() {
  let services: AppTemplate['services']
  try {
    const parsed: unknown = JSON.parse(servicesJson.value)
    if (!Array.isArray(parsed)) throw new Error('Services must be a JSON array')
    services = parsed as AppTemplate['services']
  } catch (err) {
    message.error(err instanceof Error ? err.message : 'Services must be valid JSON')
    return
  }

  saving.value = true
  try {
    const template = { ...form.value, services }
    if (editingId.value) await templatesApi.update(editingId.value, template)
    else await templatesApi.create(template)
    message.success(editingId.value ? 'Marketplace entry updated' : 'Marketplace entry added')
    formOpen.value = false
    await load()
  } catch (err) {
    message.error(errorText(err))
  } finally {
    saving.value = false
  }
}

function remove(template: AppTemplate) {
  Modal.confirm({
    title: `Delete ${template.name} from the marketplace?`,
    content: 'This only removes the catalog entry. It will not stop or delete deployed applications or their data.',
    okText: 'Delete',
    okType: 'danger',
    async onOk() {
      try {
        await templatesApi.delete(template.id)
        message.success('Marketplace entry deleted')
        await load()
      } catch (err) {
        message.error(errorText(err))
      }
    },
  })
}

onMounted(load)
</script>

<template>
  <div class="marketplace">
    <div class="marketplace-toolbar">
      <a-input
        v-model:value="search"
        placeholder="Search apps…"
        allow-clear
        size="large"
        class="market-search"
      >
        <template #prefix><SearchOutlined style="color: var(--text-placeholder)" /></template>
      </a-input>
      <a-button v-if="canManage" type="primary" @click="openCreate">
        <template #icon><PlusOutlined /></template>
        Add Image
      </a-button>
    </div>

    <div class="market-categories">
      <a-tabs v-model:activeKey="category" size="small" :tab-bar-style="{ marginBottom: 0 }">
        <a-tab-pane v-for="item in categories" :key="item" :tab="item" />
      </a-tabs>
    </div>

    <div class="market-cards">
      <a-spin :spinning="loading">
        <a-alert v-if="error" type="error" :message="error" show-icon style="margin-bottom: 16px" />
        <div v-if="filteredTemplates.length === 0 && !loading" class="market-empty">
          {{ error ? 'Marketplace entries could not be loaded' : 'No apps found' }}
        </div>
        <div class="market-grid">
          <div
            v-for="template in filteredTemplates"
            :key="template.id"
            class="market-card"
            @click="requestDeploy(template)"
          >
            <div class="market-card-top">
              <div class="market-avatar" :style="{ background: template.color }">{{ template.letter }}</div>
              <div class="market-meta">
                <div class="market-name">{{ template.name }}</div>
                <a-tag :color="CATEGORY_COLOR[template.category] ?? 'default'" class="market-category">
                  {{ template.category }}
                </a-tag>
              </div>
            </div>
            <div class="market-desc">{{ template.description }}</div>
            <div class="market-footer">
              <span class="market-image">{{ template.services[0]?.image }}</span>
              <a-button
                type="primary"
                size="small"
                class="market-deploy-btn"
                :disabled="!dockerAvailable"
                @click.stop="requestDeploy(template)"
              >
                <template #icon><RocketOutlined /></template>
                Deploy
              </a-button>
            </div>
            <div v-if="canManage" class="market-management">
              <a-button size="small" @click.stop="openEdit(template)">
                <template #icon><EditOutlined /></template>
                Edit
              </a-button>
              <a-button danger size="small" @click.stop="remove(template)">
                <template #icon><DeleteOutlined /></template>
                Delete
              </a-button>
            </div>
          </div>
        </div>
      </a-spin>
    </div>

    <a-modal
      v-model:open="formOpen"
      :title="editingId ? 'Edit Marketplace Image' : 'Add Marketplace Image'"
      :confirm-loading="saving"
      ok-text="Save"
      @ok="save"
    >
      <a-form layout="vertical">
        <a-form-item label="ID" required>
          <a-input v-model:value="form.id" :disabled="!!editingId" placeholder="my-image" />
        </a-form-item>
        <a-form-item label="Name" required>
          <a-input v-model:value="form.name" />
        </a-form-item>
        <a-form-item label="Category" required>
          <a-input v-model:value="form.category" />
        </a-form-item>
        <a-form-item label="Description" required>
          <a-textarea v-model:value="form.description" :rows="2" />
        </a-form-item>
        <a-form-item label="Application name" required>
          <a-input v-model:value="form.appName" />
        </a-form-item>
        <div class="market-form-row">
          <a-form-item label="Icon letters" required>
            <a-input v-model:value="form.letter" maxlength="5" />
          </a-form-item>
          <a-form-item label="Icon color" required>
            <a-input v-model:value="form.color" placeholder="#1677ff" />
          </a-form-item>
        </div>
        <a-form-item label="Services (JSON)" required>
          <a-textarea v-model:value="servicesJson" :rows="9" />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.marketplace {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.marketplace-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px 0;
  flex-shrink: 0;
}

.market-search {
  flex: 1;
  min-width: 0;
}

.market-categories {
  padding: 0 20px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color);
  margin-top: 12px;
}

.market-cards {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px;
}

.market-empty {
  text-align: center;
  padding: 48px 0;
  color: var(--text-placeholder);
}

.market-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 14px;
}

.market-card {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 16px;
  background: var(--bg-container);
  display: flex;
  flex-direction: column;
  gap: 10px;
  cursor: pointer;
  transition: box-shadow 0.18s, border-color 0.18s, transform 0.12s;
}

.market-card:hover {
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
  border-color: #1677ff;
  transform: translateY(-1px);
}

.market-card-top {
  display: flex;
  align-items: center;
  gap: 12px;
}

.market-avatar {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.5px;
  flex-shrink: 0;
  font-family: 'SFMono-Regular', Consolas, monospace;
}

.market-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.market-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-heading);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.market-category {
  font-size: 11px;
  line-height: 18px;
  padding: 0 6px;
  margin: 0;
  width: fit-content;
}

.market-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  flex: 1;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.market-footer,
.market-management {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.market-footer {
  margin-top: 2px;
}

.market-image {
  font-size: 10px;
  color: var(--text-muted);
  font-family: monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.market-deploy-btn {
  flex-shrink: 0;
}

.market-management {
  justify-content: flex-end;
}

.market-form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.market-form-row :deep(.ant-form-item) {
  min-width: 0;
  flex: 1;
}
</style>
