/**
 * `getFeedbackCatalogue` reads `GET /feedback/catalogue` and hands the page the normalized catalogue: a
 * malformed answer never reaches the Fields panel as anything but the empty catalogue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi } from '@test/fetchApiRoutes'
import { getFeedbackCatalogue } from './feedbackCatalogueApi'
import { normalizeFeedbackCatalogue } from './feedbackCatalogueSchema'

describe('getFeedbackCatalogue', () => {
  beforeEach(() => { fetchApi.mockReset() })

  it('reads the catalogue route and normalizes its answer', async () => {
    const raw = { version: 1, table: 'voc-feedback', fields: [{ name: 'sentiment_label', type: 'string', meaning: 'Overall tone' }] }
    fetchApi.mockResolvedValue(raw)

    const catalogue = await getFeedbackCatalogue()

    expect(fetchApi).toHaveBeenCalledExactlyOnceWith('/feedback/catalogue', undefined)
    expect(catalogue).toStrictEqual(normalizeFeedbackCatalogue(raw))
  })

  it('answers the empty catalogue for a malformed answer', async () => {
    fetchApi.mockResolvedValue('not a catalogue')

    expect(await getFeedbackCatalogue()).toStrictEqual(normalizeFeedbackCatalogue(undefined))
  })
})
