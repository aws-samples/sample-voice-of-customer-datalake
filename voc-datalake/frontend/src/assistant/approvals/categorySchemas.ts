/**
 * @fileoverview The SPA approval boundary of `save_categories` (docs/categories.md "Proposed by the assistant"): the
 * categories the assistant proposed, as the card edits them, and what its Approve adds to the stored categories.
 *
 * The limits and the label rules are the stream Lambda's (`@stream/assistant/tools/client/category-schemas`, pinned
 * there to `lambda/shared/category_config.py`); this file words the card's own messages
 * (`categorySchemas.lockstep.test.ts` checks it accepts what the stream accepts). The route re-validates everything.
 *
 * A proposal becomes stored categories as the categories editor makes them (CategoriesManager): the label is the
 * description every screen shows, the stored name is its slug, and each category and subcategory gets a fresh
 * `cat_` / `sub_` id. A stored category is never changed: the new ones are added after them.
 *
 * @module assistant/approvals/categorySchemas
 */
import { z } from 'zod'
import {
  CATEGORY_PROPOSAL_LIMITS as L, categorySlug, foldedLabel, isCategoryLabel, repeatedSlugs,
} from '@stream/assistant/tools/client/category-schemas'
import type { Category } from '../../components/CategoriesManager/CategoriesManager'

/** A raw label or product is capped before its whitespace is folded (the stream's input cap). */
const MAX_TEXT_INPUT = 200

/**
 * What is wrong with a field of the edited set, as the card words it (`preview.saveCategories.problems.<kind>`): a
 * label the route does not take, a product too long, a name twice, a name configured already, no category left.
 */
const PROBLEMS = ['label', 'product', 'repeated', 'taken', 'none'] as const
export type DraftProblem = (typeof PROBLEMS)[number]
const isProblem = (value: string): value is DraftProblem => PROBLEMS.some((problem) => problem === value)

const label = z.string().max(MAX_TEXT_INPUT, 'label').transform(foldedLabel)
  .pipe(z.string().refine(isCategoryLabel, 'label'))
const product = z.string().max(MAX_TEXT_INPUT, 'product').transform(foldedLabel)
  .pipe(z.string().max(L.maxProductChars, 'product')).optional()

/** One category of a valid set: its folded label, its product when it has one, its subcategories' labels. */
interface CategoryProposal {
  label: string
  product?: string
  subcategories: string[]
}

const categoryProposalArgs = z.strictObject({
  label,
  product,
  subcategories: z.array(label).max(L.maxSubcategories),
}).check((ctx) => {
  ctx.issues.push(...repeatedSlugs(ctx.value.subcategories).map((index) => ({
    code: 'custom' as const, path: ['subcategories', index], input: ctx.value, message: 'repeated',
  })))
}).transform(({ product: stated, ...rest }): CategoryProposal => (stated === undefined || stated === '' ? rest : { ...rest, product: stated }))

export const saveCategoriesArgs = z.strictObject({
  categories: z.array(categoryProposalArgs).min(1).max(L.maxCategories),
}).check((ctx) => {
  ctx.issues.push(...repeatedSlugs(ctx.value.categories.map((category) => category.label)).map((index) => ({
    code: 'custom' as const, path: ['categories', index, 'label'], input: ctx.value, message: 'repeated',
  })))
})
export type SaveCategoriesArgs = z.infer<typeof saveCategoriesArgs>

/** One category as the card edits it: the text the person typed, checked only as a whole (`checkedDraft`). */
export interface CategoryDraft {
  readonly label: string
  readonly product: string
  readonly subcategories: readonly string[]
}

/** The proposal as the card starts editing it. */
export function draftOf(args: SaveCategoriesArgs): CategoryDraft[] {
  return args.categories.map((category) => ({
    label: category.label, product: category.product ?? '', subcategories: category.subcategories,
  }))
}

/**
 * The edited set as the route would get it, or what is wrong with it: each field's path (`categories.1.label`,
 * `categories.1.subcategories.0`, `categories.1.product`, or `categories` for an empty set) and its problem.
 */
type CheckedDraft =
  | { readonly ok: true; readonly set: SaveCategoriesArgs }
  | { readonly ok: false; readonly problems: ReadonlyMap<string, DraftProblem> }

const problemOf = (message: string): DraftProblem => (isProblem(message) ? message : 'label')

export function checkedDraft(draft: readonly CategoryDraft[], stored: readonly Category[]): CheckedDraft {
  const parsed = saveCategoriesArgs.safeParse({
    categories: draft.map((category) => ({ ...category, subcategories: [...category.subcategories] })),
  })
  const problems = new Map<string, DraftProblem>()
  if (draft.length === 0) problems.set('categories', 'none')
  else if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.set(issue.path.join('.'), problemOf(issue.message))
  }
  const taken = takenNames(stored)
  draft.forEach((category, index) => {
    if (taken.has(categorySlug(foldedLabel(category.label)).toLowerCase())) problems.set(`categories.${index}.label`, 'taken')
  })
  return parsed.success && problems.size === 0 ? { ok: true, set: parsed.data } : { ok: false, problems }
}

/** The stored names, compared without regard to case (a new "delivery" beside a stored "Delivery" is refused). */
function takenNames(stored: readonly Category[]): ReadonlySet<string> {
  return new Set(stored.map((category) => category.name.toLowerCase()))
}

/** The stored categories' fingerprint: what the card read, so an Approve after they changed saves nothing. */
export function categoriesFingerprint(stored: readonly Category[]): string {
  return JSON.stringify(stored)
}

/** The stored names the set makes that a stored category already has. */
export function namesTaken(set: SaveCategoriesArgs, stored: readonly Category[]): string[] {
  const taken = takenNames(stored)
  return set.categories.map((category) => categorySlug(category.label)).filter((name) => taken.has(name.toLowerCase()))
}

/** The new categories as the categories editor stores them (fresh ids, the slug as the name, the label shown). */
export function newCategories(set: SaveCategoriesArgs, newId: (prefix: 'cat' | 'sub') => string): Category[] {
  return set.categories.map((category) => ({
    id: newId('cat'),
    name: categorySlug(category.label),
    description: category.label,
    ...(category.product === undefined ? {} : { product: category.product }),
    subcategories: category.subcategories.map((sub) => ({ id: newId('sub'), name: categorySlug(sub), description: sub })),
  }))
}
