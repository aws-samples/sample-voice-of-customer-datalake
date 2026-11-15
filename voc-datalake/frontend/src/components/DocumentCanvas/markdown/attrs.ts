/** Typed reads of ProseMirror JSON attributes (JSONContent types them `any`). */
import type { JSONContent } from '@tiptap/core'

type Attrs = JSONContent['attrs']

const read = (attrs: Attrs, key: string): unknown => attrs?.[key]

export function attrString(attrs: Attrs, key: string): string | null {
  const value = read(attrs, key)
  return typeof value === 'string' ? value : null
}

export function attrNumber(attrs: Attrs, key: string): number | null {
  const value = read(attrs, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function attrBoolean(attrs: Attrs, key: string): boolean | null {
  const value = read(attrs, key)
  return typeof value === 'boolean' ? value : null
}

export function attrArray(attrs: Attrs, key: string): readonly unknown[] | null {
  const value = read(attrs, key)
  return Array.isArray(value) ? value : null
}
