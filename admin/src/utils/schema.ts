import type { JSONSchema } from '@/api/mqtt'

export function generateSchema(value: unknown): JSONSchema {
  if (value === null) return { type: 'null' }
  if (Array.isArray(value)) return generateArraySchema(value)
  switch (typeof value) {
    case 'object': return generateObjectSchema(value as Record<string, unknown>)
    case 'number': return { type: 'number' }
    case 'boolean': return { type: 'boolean' }
    case 'string': return { type: 'string' }
    default: return { type: typeof value }
  }
}

function generateObjectSchema(obj: Record<string, unknown>): JSONSchema {
  const properties: Record<string, JSONSchema> = Object.create(null)
  for (const [key, val] of Object.entries(obj)) {
    properties[key] = generateSchema(val)
  }
  return { type: 'object', properties }
}

function generateArraySchema(arr: unknown[]): JSONSchema {
  if (arr.length === 0) return { type: 'array' }
  let itemsSchema: JSONSchema | undefined
  let consistent = true
  for (let i = 0; i < arr.length; i++) {
    const s = generateSchema(arr[i])
    if (i === 0) {
      itemsSchema = s
    } else if (s.type !== itemsSchema!.type) {
      consistent = false
      break
    } else if (s.type === 'object' && itemsSchema!.properties) {
      for (const key of Object.keys(s.properties || {})) {
        if (!itemsSchema!.properties![key]) {
          itemsSchema!.properties![key] = s.properties![key]
        }
      }
    }
  }
  return consistent && itemsSchema ? { type: 'array', items: itemsSchema } : { type: 'array' }
}
