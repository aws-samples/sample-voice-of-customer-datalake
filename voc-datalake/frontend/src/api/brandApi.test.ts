/**
 * The deployment's brand client: both calls are deployment-wide requests (the client's explicit opt-out of
 * `X-Workspace-Id`), and the answer is read leniently.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { DEFAULT_THEME } from '../pages/FeedbackForms/model/formsV2'
import { deploymentBrandApi, formBrandApi, readBrand, readFormBrand } from './brandApi'

const BRAND = { brand_name: 'Acme Outfitters', brand_handles: ['@acme'], hashtags: ['#trail'], urls_to_track: ['https://example.com/reviews'] }
const EMPTY = { brand_name: '', brand_handles: [], hashtags: [], urls_to_track: [] }

beforeEach(() => resetFetchApi())

describe('readBrand', () => {
  it('keeps a well-formed brand', () => {
    expect(readBrand(BRAND)).toStrictEqual(BRAND)
  })

  it('reads a field of the wrong type as empty, and anything else as an empty brand', () => {
    expect(readBrand({ ...BRAND, hashtags: 'nope', brand_name: 7 })).toStrictEqual({ ...BRAND, hashtags: [], brand_name: '' })
    expect(readBrand(null)).toStrictEqual(EMPTY)
  })
})

describe('deploymentBrandApi', () => {
  it('reads GET /settings/brand as a deployment-wide request', async () => {
    routeFetchApi({ 'GET /settings/brand': () => BRAND })
    await expect(deploymentBrandApi.get()).resolves.toStrictEqual(BRAND)
    expect(fetchApi).toHaveBeenCalledWith('/settings/brand', { method: 'GET' }, 'deployment')
  })

  it('saves with PUT /settings/brand as a deployment-wide request', async () => {
    routeFetchApi({ 'PUT /settings/brand': () => ({ success: true }) })
    await deploymentBrandApi.save(BRAND)
    expect(fetchApi).toHaveBeenCalledWith('/settings/brand', { method: 'PUT', body: JSON.stringify(BRAND) }, 'deployment')
  })
})

describe('the form brand', () => {
  it('reads a saved one whole, its missing fields with their defaults, and null when none was saved', () => {
    expect(readFormBrand({ ...BRAND, form_theme: { primary_color: '#0552c2', mode: 'auto' } }))
      .toStrictEqual({ ...DEFAULT_THEME, primary_color: '#0552c2', mode: 'auto' })
    expect(readFormBrand({ ...BRAND, form_theme: null })).toBeNull()
    expect(readFormBrand(BRAND)).toBeNull()
    expect(readFormBrand({ error: 'boom' })).toBeNull()
  })

  it('saves only the form theme, in the current workspace', async () => {
    routeFetchApi({ 'PUT /settings/brand': () => ({ success: true }) })
    await formBrandApi.save(DEFAULT_THEME)
    expect(fetchApi).toHaveBeenCalledWith('/settings/brand', { method: 'PUT', body: JSON.stringify({ form_theme: DEFAULT_THEME }) })
  })
})
