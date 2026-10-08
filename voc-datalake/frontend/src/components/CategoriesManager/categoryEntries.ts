/**
 * @fileoverview Pure helpers over (sub)category entries, shared by the
 * Categories manager and its rows.
 *
 * @module components/CategoriesManager/categoryEntries
 */
import type { Category, Subcategory } from './CategoriesManager'

/** The label a user sees for a (sub)category: its description, else its slug. */
export function displayName(entry: Readonly<{ name: string; description?: string }>): string {
  const { description } = entry
  return description === undefined || description === '' ? entry.name : description
}

/** The stored slug of a typed label: lowercase, whitespace runs → underscores. */
export function toSlug(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '_')
}

/**
 * A category's subcategories. Belt-and-braces for issue #181: the query
 * boundary normalizes, but every read stays safe standalone.
 */
export function subcategoriesOf(category: Category): Subcategory[] {
  return Array.isArray(category.subcategories) ? category.subcategories : []
}
