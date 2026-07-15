/**
 * @fileoverview Runtime validation/normalization for the categories config.
 *
 * The real GET /settings/categories returns the DynamoDB item verbatim
 * (settings_handler.py: `item.get('categories', [])`), so nothing enforces
 * the declared Category shape at runtime — legacy or hand-written rows lack
 * `id`/`subcategories`, and reading `subcategories.length` off such a row
 * crashed the Settings Categories tab (issue #181). Same class as
 * #167/#169/#171; same architecture as formSchema.ts / scrapersSchema.ts.
 *
 * Identity strategy deliberately differs from those two: categories are
 * user-editable config that the save flow round-trips WHOLESALE, so
 * dropping an id-less row would silently delete it on the next save.
 * Instead a missing id is DERIVED from the name (stable slug). A row is
 * dropped only when both id and name are unusable — nothing to render,
 * key on, or save.
 *
 * @module components/CategoriesManager/categoriesSchema
 */
import { z } from 'zod'
import type { Category, Subcategory } from './CategoriesManager'

/** Stable id for legacy rows that never had one: slug of the name. */
function deriveId(prefix: string, name: string): string {
  return `${prefix}_${name.trim().toLowerCase().replace(/\s+/g, '_')}`
}

// Loose objects: legacy fields (display_name, color, ...) survive the edit
// round-trip — the save flow PUTs the whole list back.
const rawSubcategorySchema = z.looseObject({
  id: z.string().optional().catch(undefined),
  name: z.string().catch(''),
  description: z.string().optional().catch(undefined),
})

const rawCategorySchema = z.looseObject({
  id: z.string().optional().catch(undefined),
  name: z.string().catch(''),
  description: z.string().optional().catch(undefined),
  subcategories: z.array(z.unknown()).catch(() => []),
})

function normalizeSubcategory(raw: unknown): Subcategory[] {
  const parsed = rawSubcategorySchema.safeParse(raw)
  if (!parsed.success) return []
  const { id, name } = parsed.data
  if ((id === undefined || id === '') && name === '') return []
  return [{ ...parsed.data, id: id !== undefined && id !== '' ? id : deriveId('sub', name), name }]
}

/**
 * Make the declared Category contract true for one wire row, or drop it
 * (empty array) when there is no usable identity at all.
 */
function normalizeCategory(raw: unknown): Category[] {
  const parsed = rawCategorySchema.safeParse(raw)
  if (!parsed.success) {
    console.warn('Dropping category record that failed schema validation:', parsed.error.issues)
    return []
  }
  const { id, name, subcategories } = parsed.data
  if ((id === undefined || id === '') && name === '') {
    console.warn('Dropping category record without usable id or name:', parsed.data)
    return []
  }
  return [{
    ...parsed.data,
    id: id !== undefined && id !== '' ? id : deriveId('cat', name),
    name,
    subcategories: subcategories.flatMap(normalizeSubcategory),
  }]
}

/**
 * Normalize the categories list at the query boundary: legacy rows get a
 * derived id and an empty subcategories array instead of crashing the tab;
 * unknown legacy fields pass through so saves lose nothing.
 */
export function normalizeCategories(rawCategories: readonly unknown[]): Category[] {
  return rawCategories.flatMap(normalizeCategory)
}
