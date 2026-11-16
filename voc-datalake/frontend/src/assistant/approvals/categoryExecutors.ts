/**
 * @fileoverview The Approve of a `save_categories` card (docs/categories.md "Proposed by the assistant"): it ADDS the
 * categories the card shows, as the person edited them (shown.ts `categories`), to the current workspace's
 * categories (the deployment's outside a workspace), through the categories editor's own route with the person's own
 * session: `GET` then `PUT /settings/categories` in the workspace scope (with `X-Workspace-Id` inside a workspace).
 * The route checks the person at the click (`require_settings_admin`: in a workspace its admins, else the
 * deployment's).
 *
 * Add, never replace: every stored category is sent back as read (normalised as the editor normalises it), and the
 * new ones follow. It saves nothing when the card had no valid set yet, when the stored categories changed since the
 * card read them (another person's edit is never overwritten), or when a new name is configured already. Only an
 * administrator of the workspace reads the whole list (others are served their categories only), and only one may
 * save, so what goes back is never a part of the list.
 *
 * @module assistant/approvals/categoryExecutors
 */
import { api } from '../../api/client'
import { categoriesConfigKey } from '../../hooks/useCategories'
import { normalizeCategories } from '../../components/CategoriesManager/categoriesSchema'
import { invalidateKeys } from './invalidation'
import { StaleApprovalError, requireUnchangedSinceShown, shownOf } from './shown'
import { categoriesFingerprint, namesTaken, newCategories } from './categorySchemas'
import type { Category } from '../../components/CategoriesManager/CategoriesManager'
import type { WriteToolExecutionContext } from '../types'
import type { SaveCategoriesArgs } from './categorySchemas'

const CATEGORIES_NOT_SHOWN_MESSAGE = 'The card had no valid set of categories to save yet; nothing was saved. '
  + 'Propose save_categories again.'
export const CATEGORIES_CHANGED_MESSAGE = 'The categories changed since this approval was shown; nothing was saved. '
  + 'Call list_categories again and propose save_categories with the categories that are not configured yet.'
/** The card-local read of the stored categories (never the editor's cache, so the card reads them fresh). */
export const CATEGORIES_PREVIEW_KEY = ['assistant', 'categories-preview'] as const

/** The stored categories, as the categories editor reads and saves them back (the current workspace's). */
export async function readStoredCategories(): Promise<Category[]> {
  const answer = await api.getCategoriesConfig()
  // (the real GET answers the row verbatim: `categories` may be absent)
  const raw: unknown = answer.categories
  return normalizeCategories(Array.isArray(raw) ? raw : [])
}

const newEntryId = (prefix: 'cat' | 'sub') => `${prefix}_${crypto.randomUUID()}`

/** What the model is told was saved: the names it filters by and the labels people read. */
function savedLine(category: Category): string {
  const subcategories = category.subcategories.map((sub) => sub.name).join(', ')
  const named = subcategories === '' ? category.name : `${category.name}: ${subcategories}`
  return `${category.description ?? category.name} (${named})`
}

export async function saveCategories(_args: SaveCategoriesArgs, ctx: WriteToolExecutionContext) {
  // (the card's edited set, never the model's: the person may have changed it)
  const shown = shownOf(ctx)?.categories
  if (shown === undefined) throw new StaleApprovalError(CATEGORIES_NOT_SHOWN_MESSAGE)
  const stored = await readStoredCategories()
  requireUnchangedSinceShown(shown.base, categoriesFingerprint(stored), CATEGORIES_CHANGED_MESSAGE)
  if (namesTaken(shown.set, stored).length > 0) throw new StaleApprovalError(CATEGORIES_CHANGED_MESSAGE)
  const added = newCategories(shown.set, newEntryId)
  await api.saveCategoriesConfig({ categories: [...stored, ...added] })
  void invalidateKeys(ctx.queryClient, [categoriesConfigKey(), CATEGORIES_PREVIEW_KEY])
  return {
    summary: `Added ${String(added.length)} categor${added.length === 1 ? 'y' : 'ies'} after the ${String(stored.length)} `
      + `configured: ${added.map(savedLine).join('; ')}. New reviews are classified into them; call list_categories `
      + 'to read them.',
    data: { categories: added.map((category) => ({
      name: category.name, label: category.description ?? category.name,
      subcategories: category.subcategories.map((sub) => sub.name),
    })) },
  }
}
