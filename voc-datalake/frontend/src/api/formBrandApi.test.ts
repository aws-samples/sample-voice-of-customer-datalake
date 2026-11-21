/**
 * The deployment's form brand: read leniently from the brand's answer, saved alone with a PUT of only `form_theme`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { DEFAULT_THEME } from '../pages/FeedbackForms/model/formsV2'
import { formBrandApi, readFormBrand } from './formBrandApi'

const BRAND = { brand_name: 'Acme Outfitters', brand_handles: ['@acme'], hashtags: ['#trail'], urls_to_track: ['https://example.com/reviews'] }

beforeEach(() => resetFetchApi())

describe('the form brand', () => {
  it('reads a saved one whole, its missing fields with their defaults, and null when none was saved', () => {
    expect(readFormBrand({ ...BRAND, form_theme: { primary_color: '#0552c2', mode: 'auto' } }))
      .toStrictEqual({ ...DEFAULT_THEME, primary_color: '#0552c2', mode: 'auto' })
    expect(readFormBrand({ ...BRAND, form_theme: null })).toBeNull()
    expect(readFormBrand(BRAND)).toBeNull()
    expect([readFormBrand({ error: 'boom' }), readFormBrand(null)]).toStrictEqual([null, null])
  })

  it('saves only the form theme', async () => {
    routeFetchApi({ 'PUT /settings/brand': () => ({ success: true }) })
    await formBrandApi.save(DEFAULT_THEME)
    expect(fetchApi).toHaveBeenCalledWith('/settings/brand', { method: 'PUT', body: JSON.stringify({ form_theme: DEFAULT_THEME }) })
  })
})
