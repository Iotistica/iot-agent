<script setup lang="ts">
import { computed } from 'vue'
import type { JSONSchema } from '@/api/mqtt'

const props = defineProps<{
  schema: JSONSchema | null | undefined
}>()

const TYPE_COLORS: Record<string, string> = {
  string: '#79c0ff',
  number: '#f2cc60',
  boolean: '#ff7b72',
  null: '#8b949e',
  object: '#d2a8ff',
  array: '#56d4dd',
}

interface SchemaField {
  name: string
  schema: JSONSchema
  depth: number
}

function flattenSchema(schema: JSONSchema, depth = 0, prefix = ''): SchemaField[] {
  const fields: SchemaField[] = []
  if (schema.type === 'object' && schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      const name = prefix ? `${prefix}.${key}` : key
      fields.push({ name: key, schema: child, depth })
      if (child.type === 'object' && child.properties) {
        fields.push(...flattenSchema(child, depth + 1, name))
      } else if (child.type === 'array' && child.items?.type === 'object' && child.items.properties) {
        fields.push(...flattenSchema(child.items, depth + 1, `${name}[]`))
      }
    }
  }
  return fields
}

const fields = computed(() => {
  if (!props.schema) return []
  return flattenSchema(props.schema)
})

function typeLabel(schema: JSONSchema): string {
  if (schema.type === 'array') {
    if (schema.items) return `${schema.items.type}[]`
    return 'array'
  }
  return schema.type
}

function typeColor(schema: JSONSchema): string {
  if (schema.type === 'array' && schema.items) {
    return TYPE_COLORS[schema.items.type] || TYPE_COLORS.array
  }
  return TYPE_COLORS[schema.type] || '#8b949e'
}

const fieldCount = computed(() => {
  if (!props.schema?.properties) return 0
  return Object.keys(props.schema.properties).length
})
</script>

<template>
  <div v-if="!schema || schema.type !== 'object'" class="schema-empty">
    <div class="empty-icon">{ }</div>
    <div>No schema — select a topic with JSON messages</div>
  </div>

  <div v-else class="schema-viewer">
    <div class="schema-header">
      <span class="schema-count">{{ fieldCount }} top-level field{{ fieldCount !== 1 ? 's' : '' }}</span>
    </div>
    <div class="schema-tree">
      <div
        v-for="(field, i) in fields"
        :key="i"
        class="schema-row"
        :style="{ paddingLeft: `${16 + field.depth * 20}px` }"
      >
        <span v-if="field.schema.type === 'object'" class="row-bracket">{</span>
        <span v-else-if="field.schema.type === 'array' && field.schema.items?.type === 'object'" class="row-bracket">[{</span>
        <span class="field-name">{{ field.name }}</span>
        <span class="field-type" :style="{ color: typeColor(field.schema) }">{{ typeLabel(field.schema) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.schema-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-placeholder);
  font-size: 13px;
  gap: 10px;
  padding: 40px;
}

.empty-icon {
  font-size: 28px;
  opacity: 0.3;
  font-family: 'SFMono-Regular', 'Consolas', 'Courier New', monospace;
}

.schema-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.schema-header {
  padding: 10px 16px 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}

.schema-count {
  font-variant-numeric: tabular-nums;
}

.schema-tree {
  flex: 1;
  overflow: auto;
  background: #0d1117;
  margin: 0 16px 16px;
  border-radius: 6px;
  padding: 10px 0;
  font-family: 'SFMono-Regular', 'Consolas', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.8;
}

.schema-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 16px;
}

.schema-row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.row-bracket {
  color: #8b949e;
  font-size: 11px;
  opacity: 0.5;
}

.field-name {
  color: #79c0ff;
}

.field-type {
  font-size: 11px;
  opacity: 0.7;
  margin-left: auto;
}
</style>
