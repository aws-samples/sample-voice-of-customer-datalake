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

/**
 * Two-pass id allocation: every usable STORED id is reserved up front, so a
 * derived id can never claim — and therefore silently rewrite — a stored
 * identity that appears later in the list (the save flow round-trips
 * wholesale, so a rewrite would persist). Within that constraint ids are
 * de-duplicated first-come with numeric suffixes (cat_app, cat_app_2, ...),
 * covering same-named legacy rows and pathological duplicate stored ids.
 */
function createIdAllocator(reservedStoredIds: ReadonlySet<string>) {
  const assigned = new Set<string>()
  const nextFree = (candidate: string, attempt: number): string => {
    const proposal = attempt === 1 ? candidate : `${candidate}_${attempt}`
    if (!assigned.has(proposal) && !reservedStoredIds.has(proposal)) {
      assigned.add(proposal)
      return proposal
    }
    return nextFree(candidate, attempt + 1)
  }
  return {
    /** A stored id keeps itself; only a duplicate stored id gets suffixed. */
    stored(id: string): string {
      if (!assigned.has(id)) {
        assigned.add(id)
        return id
      }
      return nextFree(id, 2)
    },
    /** A derived id must not collide with anything stored or assigned. */
    derived(candidate: string): string {
      return nextFree(candidate, 1)
    },
  }
}

type IdAllocator = ReturnType<typeof createIdAllocator>

const usableStoredId = (id: string | undefined): id is string => id !== undefined && id.trim() !== ''

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

type RawCategory = z.infer<typeof rawCategorySchema>

/** Allocate this row's id: stored ids keep themselves, missing ones are
 * derived from the slugged name — or null when neither is usable. */
function allocateIdentity(
  prefix: string, id: string | undefined, name: string, allocator: IdAllocator,
): string | null {
  if (usableStoredId(id)) return allocator.stored(id)
  const slug = slugify(name)
  return slug === '' ? null : allocator.derived(`${prefix}_${slug}`)
}

function normalizeSubcategories(rawSubs: readonly unknown[]): Subcategory[] {
  const parsed = rawSubs
    .map((raw) => rawSubcategorySchema.safeParse(raw))
    .flatMap((result) => (result.success ? [result.data] : []))
  const allocator = createIdAllocator(
    new Set(parsed.map((sub) => sub.id).filter(usableStoredId)),
  )
  return parsed.flatMap((sub) => {
    const identity = allocateIdentity('sub', sub.id, sub.name, allocator)
    return identity === null ? [] : [{ ...sub, id: identity, name: sub.name }]
  })
}

function normalizeCategory(parsed: RawCategory, allocator: IdAllocator): Category[] {
  const identity = allocateIdentity('cat', parsed.id, parsed.name, allocator)
  if (identity === null) {
    console.warn('Dropping category record without usable id or name; keys present:', Object.keys(parsed))
    return []
  }
  return [{
    ...parsed,
    id: identity,
    name: parsed.name,
    subcategories: normalizeSubcategories(parsed.subcategories),
  }]
}

/**
 * Normalize the categories list at the query boundary: legacy rows get a
 * derived id and an empty subcategories array instead of crashing the tab;
 * unknown legacy fields pass through so saves lose nothing. Stored ids are
 * never rewritten (reserved before any derivation); all ids are unique
 * across the list so row actions can never cross-target.
 */
export function normalizeCategories(rawCategories: readonly unknown[]): Category[] {
  const parsedRows = rawCategories.flatMap((raw) => {
    const result = rawCategorySchema.safeParse(raw)
    if (!result.success) {
      console.warn('Dropping category record that failed schema validation:', result.error.issues)
      return []
    }
    return [result.data]
  })
  const allocator = createIdAllocator(
    new Set(parsedRows.map((row) => row.id).filter(usableStoredId)),
  )
  return parsedRows.flatMap((row) => normalizeCategory(row, allocator))
}
