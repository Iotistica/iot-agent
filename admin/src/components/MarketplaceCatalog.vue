<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { DeleteOutlined, EditOutlined, PlusOutlined, RocketOutlined, SearchOutlined } from '@ant-design/icons-vue'
import { templatesApi, categoriesApi, type MarketplaceImage, type MarketplaceCategory } from '@/api/containers'
import { useAuth } from '@/composables/useAuth'
import { useDockerStatus } from '@/composables/useDockerStatus'

const emit = defineEmits<{ deploy: [template: MarketplaceImage] }>()

const { hasRole } = useAuth()
const { dockerAvailable } = useDockerStatus()
const canManage = computed(() => hasRole('admin'))
const templates = ref<MarketplaceImage[]>([])
const categories = ref<string[]>(['All'])
const dbCategories = ref<MarketplaceCategory[]>([])
const category = ref('All')
const search = ref('')
const loading = ref(false)
const error = ref('')
const formOpen = ref(false)
const saving = ref(false)
const editingId = ref<string | null>(null)

interface FormState {
  id: string
  name: string
  category: string
  description: string
  color: string
  letter: string
  image: string
  ports: { host: string; container: string }[]
  envRows: { name: string; value: string }[]
  volumes: string
  restart: string
  networkMode: string
  command: string
  entrypoint: string
  user: string
  enableSocketDestination: boolean
}

function emptyForm(): FormState {
  return {
    id: '', name: '', category: '', description: '', color: '#1677ff', letter: '',
    image: '', ports: [], envRows: [], volumes: '', restart: 'unless-stopped',
    networkMode: 'bridge', command: '', entrypoint: '', user: '',
    enableSocketDestination: false,
  }
}

const form = ref<FormState>(emptyForm())

const newCatOpen = ref(false)
const newCatName = ref('')
const newCatColor = ref('#1677ff')
const newCatSaving = ref(false)

function categoryColor(name: string): string {
  const cat = dbCategories.value.find(c => c.name === name)
  return cat?.color ?? 'default'
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
    const [result, cats] = await Promise.all([templatesApi.getAll(), categoriesApi.getAll()])
    templates.value = result.templates
    categories.value = result.categories
    dbCategories.value = cats
    if (!categories.value.includes(category.value)) category.value = 'All'
  } catch (err) {
    error.value = errorText(err)
  } finally {
    loading.value = false
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

watch(() => form.value.name, (name) => {
  if (!editingId.value) {
    form.value.id = slugify(name)
  }
})

function openCreate() {
  editingId.value = null
  form.value = emptyForm()
  formOpen.value = true
}

function portsToRows(ports?: string[]): { host: string; container: string }[] {
  return (ports ?? []).map(port => {
    const sep = port.lastIndexOf(':')
    return sep === -1
      ? { host: '', container: port }
      : { host: port.slice(0, sep), container: port.slice(sep + 1) }
  })
}

function openEdit(template: MarketplaceImage) {
  editingId.value = template.id
  form.value = {
    id: template.id,
    name: template.name,
    category: template.category,
    description: template.description,
    color: template.color,
    letter: template.letter,
    image: template.image,
    ports: portsToRows(template.ports),
    envRows: template.environment
      ? Object.entries(template.environment).map(([name, value]) => ({ name, value }))
      : [],
    volumes: (template.volumes ?? []).join('\n'),
    restart: template.restart ?? 'unless-stopped',
    networkMode: template.networkMode ?? 'bridge',
    command: template.command ?? '',
    entrypoint: template.entrypoint ?? '',
    user: template.user ?? '',
    enableSocketDestination: template.enableSocketDestination ?? false,
  }
  formOpen.value = true
}

function requestDeploy(template: MarketplaceImage) {
  if (dockerAvailable.value) emit('deploy', template)
}

function cleanPorts(rows: { host: string; container: string }[]): string[] {
  return rows
    .map(({ host, container }) => {
      const h = host.trim(), c = container.trim()
      if (h && c) return `${h}:${c}`
      return h || c
    })
    .filter(Boolean)
}

async function save() {
  if (!form.value.name.trim()) { message.error('Name is required'); return }
  if (!form.value.image.trim()) { message.error('Docker image is required'); return }
  if (!form.value.category) { message.error('Category is required'); return }

  saving.value = true
  try {
    const ports = cleanPorts(form.value.ports)
    const volumes = form.value.volumes.split('\n').map(l => l.trim()).filter(Boolean)
    const environment: Record<string, string> = {}
    for (const row of form.value.envRows) {
      const k = row.name.trim()
      if (k) environment[k] = row.value
    }

    const entry: MarketplaceImage = {
      id: form.value.id || slugify(form.value.name),
      name: form.value.name.trim(),
      category: form.value.category,
      description: form.value.description.trim(),
      color: form.value.color,
      letter: form.value.letter.trim(),
      image: form.value.image.trim(),
      ...(ports.length ? { ports } : {}),
      ...(volumes.length ? { volumes } : {}),
      ...(Object.keys(environment).length ? { environment } : {}),
      restart: form.value.restart || undefined,
      ...(form.value.command.trim() ? { command: form.value.command.trim() } : {}),
      ...(form.value.entrypoint.trim() ? { entrypoint: form.value.entrypoint.trim() } : {}),
      ...(form.value.user.trim() ? { user: form.value.user.trim() } : {}),
      ...(form.value.networkMode && form.value.networkMode !== 'bridge' ? { networkMode: form.value.networkMode } : {}),
      ...(form.value.enableSocketDestination ? { enableSocketDestination: true } : {}),
    }

    if (editingId.value) await templatesApi.update(editingId.value, entry)
    else await templatesApi.create(entry)
    message.success(editingId.value ? 'Marketplace entry updated' : 'Marketplace entry added')
    formOpen.value = false
    await load()
  } catch (err) {
    message.error(errorText(err))
  } finally {
    saving.value = false
  }
}

function remove(template: MarketplaceImage) {
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

async function addCategory() {
  if (!newCatName.value.trim()) return
  newCatSaving.value = true
  try {
    await categoriesApi.create(newCatName.value.trim(), newCatColor.value)
    newCatOpen.value = false
    newCatName.value = ''
    newCatColor.value = '#1677ff'
    await load()
  } catch (err) {
    message.error(errorText(err))
  } finally {
    newCatSaving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="marketplace">
    <div class="marketplace-toolbar">
      <a-input
        v-model:value="search"
        placeholder="Search images…"
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
          {{ error ? 'Marketplace entries could not be loaded' : 'No images found' }}
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
                <a-tag :color="categoryColor(template.category)" class="market-category">
                  {{ template.category }}
                </a-tag>
              </div>
            </div>
            <div class="market-desc">{{ template.description }}</div>
            <div class="market-footer">
              <span class="market-image">{{ template.image }}</span>
            </div>
            <div class="market-actions">
              <div class="market-actions-left">
                <template v-if="canManage">
                  <a-button size="small" @click.stop="openEdit(template)">
                    <template #icon><EditOutlined /></template>
                    Edit
                  </a-button>
                </template>
              </div>
              <a-button
                type="primary"
                size="small"
                :disabled="!dockerAvailable"
                @click.stop="requestDeploy(template)"
              >
                <template #icon><RocketOutlined /></template>
                Deploy
              </a-button>
            </div>
          </div>
        </div>
      </a-spin>
    </div>

    <a-modal
      v-model:open="formOpen"
      :title="editingId ? 'Edit Marketplace Image' : 'Add Marketplace Image'"
      width="600px"
      :footer="null"
    >
      <a-form layout="vertical">
        <!-- Display section -->
        <a-form-item label="Name" required>
          <a-input v-model:value="form.name" placeholder="e.g. Redis" />
        </a-form-item>
        <a-form-item v-if="!editingId" label="ID">
          <a-input v-model:value="form.id" placeholder="auto-generated from name" />
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">Lowercase slug, auto-generated from name</div>
        </a-form-item>
        <a-form-item label="Description">
          <a-textarea v-model:value="form.description" :rows="2" placeholder="Short description of this image" />
        </a-form-item>
        <a-form-item label="Category" required>
          <a-select v-model:value="form.category" placeholder="Select a category" style="width: 100%"
            :dropdown-render="undefined"
          >
            <a-select-option v-for="cat in dbCategories" :key="cat.name" :value="cat.name">
              <div style="display: flex; align-items: center; gap: 8px">
                <span v-if="cat.color" class="cat-dot" :style="{ background: cat.color }" />
                {{ cat.name }}
              </div>
            </a-select-option>
          </a-select>
          <a-button type="link" size="small" style="padding: 0; margin-top: 4px; height: auto" @click="newCatOpen = true">
            <template #icon><PlusOutlined /></template>
            Add category
          </a-button>
        </a-form-item>
        <div class="market-form-row">
          <a-form-item label="Icon letters" required>
            <a-input v-model:value="form.letter" maxlength="5" placeholder="NR" />
          </a-form-item>
          <a-form-item label="Icon color" required>
            <div style="display: flex; gap: 8px; align-items: center">
              <input type="color" :value="form.color" class="color-picker-swatch" @input="form.color = ($event.target as HTMLInputElement).value" />
              <a-input v-model:value="form.color" placeholder="#1677ff" style="flex: 1" />
            </div>
          </a-form-item>
        </div>

        <a-divider style="margin: 12px 0" />

        <!-- Docker image section -->
        <a-form-item label="Docker image" required>
          <a-input v-model:value="form.image" placeholder="nginx:latest" style="font-family: monospace; font-size: 12px" />
        </a-form-item>
        <a-form-item label="Port mappings">
          <div style="display: flex; flex-direction: column; gap: 6px">
            <div v-for="(port, pi) in form.ports" :key="pi" style="display: flex; gap: 8px; align-items: center">
              <a-input v-model:value="port.host" placeholder="Host port" style="flex: 2; font-family: monospace; font-size: 12px" />
              <a-input v-model:value="port.container" placeholder="Container port" style="flex: 3; font-family: monospace; font-size: 12px" />
              <a-button type="text" size="small" danger @click="form.ports.splice(pi, 1)">
                <template #icon><DeleteOutlined /></template>
              </a-button>
            </div>
            <a-button type="dashed" size="small" @click="form.ports.push({ host: '', container: '' })" style="width: fit-content">
              <template #icon><PlusOutlined /></template> Add port
            </a-button>
          </div>
        </a-form-item>
        <a-form-item label="Environment variables">
          <div style="display: flex; flex-direction: column; gap: 6px">
            <div v-for="(row, i) in form.envRows" :key="i" style="display: flex; gap: 8px; align-items: center">
              <a-input v-model:value="row.name" placeholder="NAME" style="flex: 2; font-family: monospace; font-size: 12px" />
              <a-input v-model:value="row.value" placeholder="Value" style="flex: 3; font-family: monospace; font-size: 12px" />
              <a-button type="text" size="small" danger @click="form.envRows.splice(i, 1)">
                <template #icon><DeleteOutlined /></template>
              </a-button>
            </div>
            <a-button type="dashed" size="small" @click="form.envRows.push({ name: '', value: '' })" style="width: fit-content">
              <template #icon><PlusOutlined /></template> Add variable
            </a-button>
          </div>
        </a-form-item>
        <a-form-item label="Volume mounts">
          <a-textarea v-model:value="form.volumes" placeholder="/host/path:/container/path" :rows="2" />
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">One per line</div>
        </a-form-item>
        <a-form-item label="Restart policy">
          <a-select v-model:value="form.restart" style="width: 100%">
            <a-select-option value="unless-stopped">Unless stopped</a-select-option>
            <a-select-option value="always">Always</a-select-option>
            <a-select-option value="on-failure">On failure</a-select-option>
            <a-select-option value="no">No restart</a-select-option>
          </a-select>
        </a-form-item>

        <!-- Advanced section -->
        <a-collapse :bordered="false" ghost style="margin-top: 8px">
          <a-collapse-panel key="advanced" header="Advanced">
            <a-form-item label="Network mode">
              <a-select v-model:value="form.networkMode" style="width: 100%">
                <a-select-option value="bridge">bridge (default)</a-select-option>
                <a-select-option value="host">host</a-select-option>
                <a-select-option value="none">none</a-select-option>
              </a-select>
            </a-form-item>
            <a-form-item label="Command">
              <a-input v-model:value="form.command" placeholder="Override container CMD" style="font-family: monospace; font-size: 12px" />
            </a-form-item>
            <a-form-item label="Entrypoint">
              <a-input v-model:value="form.entrypoint" placeholder="Override ENTRYPOINT" style="font-family: monospace; font-size: 12px" />
            </a-form-item>
            <a-form-item label="User">
              <a-input v-model:value="form.user" placeholder="e.g. 1000:1000 or node" />
            </a-form-item>
            <a-form-item>
              <a-checkbox v-model:checked="form.enableSocketDestination">Enable socket destination</a-checkbox>
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">Mount a Unix socket into the container so the agent can publish data to it</div>
            </a-form-item>
          </a-collapse-panel>
        </a-collapse>
      </a-form>
      <div class="modal-footer">
        <a-button v-if="editingId" danger @click="remove(templates.find(t => t.id === editingId)!)">
          <template #icon><DeleteOutlined /></template>
          Delete
        </a-button>
        <div style="flex: 1" />
        <a-button @click="formOpen = false">Cancel</a-button>
        <a-button type="primary" :loading="saving" @click="save">Save</a-button>
      </div>
    </a-modal>

    <!-- Add Category mini-modal -->
    <a-modal
      v-model:open="newCatOpen"
      title="Add Category"
      :confirm-loading="newCatSaving"
      ok-text="Add"
      @ok="addCategory"
    >
      <a-form layout="vertical">
        <a-form-item label="Category name" required>
          <a-input v-model:value="newCatName" placeholder="e.g. Networking" />
        </a-form-item>
        <a-form-item label="Color">
          <a-input v-model:value="newCatColor" placeholder="#1677ff" />
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
  display: block;
}

.market-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
}

.market-actions-left {
  display: flex;
  gap: 6px;
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

.cat-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.color-picker-swatch {
  width: 36px;
  height: 32px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 2px;
  cursor: pointer;
  background: none;
  flex-shrink: 0;
}

.color-picker-swatch::-webkit-color-swatch-wrapper {
  padding: 0;
}

.color-picker-swatch::-webkit-color-swatch {
  border: none;
  border-radius: 4px;
}

.color-picker-swatch::-moz-color-swatch {
  border: none;
  border-radius: 4px;
}

.modal-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 0 0;
  border-top: 1px solid var(--border-color);
  margin-top: 16px;
}
</style>
