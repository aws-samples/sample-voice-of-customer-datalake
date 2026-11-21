/**
 * @fileoverview The deployment's FORM brand (7.04.00): `form_theme` on the `/settings/brand` row
 * (lambda/api/settings_handler.py), the forms builder's "Your brand" preset and the theme a new form starts on; null
 * when none was saved. `GET /settings/brand` answers it beside the brand's own fields (read through the brand's one
 * shared query, hooks/useBrandSettings.ts); `formBrandApi.save` PUTs only it, which the server applies alone (the
 * brand's own fields stay), and a full brand save keeps it. The save is for the `admins` group, as every brand save.
 *
 * @module api/formBrandApi
 */
import { fetchApi } from './client'
import { put } from './requestKit'
import type { FormTheme } from '../pages/FeedbackForms/model/formsV2'
import { themeSchema } from '../pages/FeedbackForms/model/keptFields'

/** The form brand of a `GET /settings/brand` answer, every field read with its default; null when none was saved. */
export function readFormBrand(raw: unknown): FormTheme | null {
  if (typeof raw !== 'object' || raw === null || !('form_theme' in raw)) return null
  const stored = raw.form_theme
  return typeof stored === 'object' && stored !== null ? themeSchema.parse(stored) : null
}

/** The deployment's form brand (the `admins` group only: 403 for anyone else). */
export const formBrandApi = {
  /** Save `theme` as the form brand (null removes it); the brand's own fields stay as they are. */
  save: (theme: FormTheme | null) => fetchApi<unknown>('/settings/brand', put({ form_theme: theme })),
}
