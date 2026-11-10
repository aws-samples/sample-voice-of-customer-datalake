/**
 * @fileoverview Pure list updates the components editor applies to its draft:
 * new components / variants, update-at and remove-at. Never mutates.
 *
 * @module pages/Company/componentDraft
 */
import type { ComponentVariant, DesignComponent } from '../../api/designComponents'

export function emptyVariant(name: string): ComponentVariant {
  return { name, styles: {}, hover: {}, focus: {} }
}

/** A new component starts with one "default" variant, so its preview shows at once. */
export function emptyComponent(): DesignComponent {
  return { name: '', description: '', variants: [emptyVariant('default')] }
}

export function updateAt<T>(items: readonly T[], index: number, change: (item: T) => T): T[] {
  return items.map((item, i) => (i === index ? change(item) : item))
}

export function removeAt<T>(items: readonly T[], index: number): T[] {
  return items.filter((_, i) => i !== index)
}

/** "variant 2", "variant 3"… — the first name not already taken (case-insensitive). */
export function nextVariantName(variants: readonly ComponentVariant[], base: string): string {
  const taken = new Set(variants.map((variant) => variant.name.trim().toLowerCase()))
  const candidates = Array.from({ length: variants.length + 2 }, (_, i) => `${base} ${i + 2}`)
  return candidates.find((candidate) => !taken.has(candidate.toLowerCase())) ?? `${base} ${variants.length + 2}`
}
