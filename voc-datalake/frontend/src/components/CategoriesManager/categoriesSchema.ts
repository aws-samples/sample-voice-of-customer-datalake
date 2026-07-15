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

/** Slug of a name for derived ids: lowercase, non-alphanumerics collapsed
 * to underscores, trimmed — 'billing/refunds' → 'billing_refunds'. */
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/** Reserve a unique id: first-come keeps the plain candidate, later
 * collisions get a numeric suffix (cat_app, cat_app_2, ...) so two legacy
 * rows named 'App' and 'app' can't share delete/expand/edit actions. */
function uniqueId(candidate: string, used: Set<string>, attempt = 1): string {
  const proposal = attempt === 1 ? candidate : `${candidate}_${attempt}`
  if (!used.has(proposal)) {
    used.add(proposal)
    return proposal
  }
  return uniqueId(candidate, used, attempt + 1)
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

/** A usable identity source: a non-empty stored id, or a name that slugs
 * to something non-empty (whitespace-only and symbol-only names don't). */
function identityFor(prefix: string, id: string | undefined, name: string): string | null {
  if (id !== undefined && id.trim() !== '') return id
  const slug = slugify(name)
  return slug === '' ? null : `${prefix}_${slug}`
}

function normalizeSubcategory(raw: unknown, usedIds: Set<string>): Subcategory[] {
  const parsed = rawSubcategorySchema.safeParse(raw)
  if (!parsed.success) return []
  const identity = identityFor('sub', parsed.data.id, parsed.data.name)
  if (identity === null) return []
  return [{ ...parsed.data, id: uniqueId(identity, usedIds), name: parsed.data.name }]
}

/**
 * Make the declared Category contract true for one wire row, or drop it
 * (empty array) when there is no usable identity at all.
 */
function normalizeCategory(raw: unknown, usedIds: Set<string>): Category[] {
  const parsed = rawCategorySchema.safeParse(raw)
  if (!parsed.success) {
    console.warn('Dropping category record that failed schema validation:', parsed.error.issues)
    return []
  }
  const identity = identityFor('cat', parsed.data.id, parsed.data.name)
  if (identity === null) {
    console.warn('Dropping category record without usable id or name; keys present:', Object.keys(parsed.data))
    return []
  }
  const usedSubIds = new Set<string>()
  return [{
    ...parsed.data,
    id: uniqueId(identity, usedIds),
    name: parsed.data.name,
    subcategories: parsed.data.subcategories.flatMap((sub) => normalizeSubcategory(sub, usedSubIds)),
  }]
}

/**
 * Normalize the categories list at the query boundary: legacy rows get a
 * derived id and an empty subcategories array instead of crashing the tab;
 * unknown legacy fields pass through so saves lose nothing. Ids are
 * de-duplicated across the list (derived or stored) so row actions can
 * never cross-target.
 */
export function normalizeCategories(rawCategories: readonly unknown[]): Category[] {
  const usedIds = new Set<string>()
  return rawCategories.flatMap((raw) => normalizeCategory(raw, usedIds))
}
