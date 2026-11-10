/**
 * Dimension defaults + tags for a form or scraper, and their lenient reads on
 * the form and scraper records (absent stays absent so a record round-trips).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen } from '@testing-library/react'
import { dimensionsWire } from '@test/dimensionFixtures'
import { renderWithQueryClient } from '@test/query-client'
import { normalizeFeedbackForms } from '../../pages/FeedbackForms/formSchema'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { normalizeScrapers } from '../../api/scrapersSchema'
import DimensionDefaultsSection from './DimensionDefaultsSection'

/** Serve `config` as the stored dimensions. */
function serveDimensions(config: unknown): void {
  routeFetchApi({ 'GET /settings/dimensions': () => config })
}

beforeEach(() => {
  resetFetchApi()
  serveDimensions(dimensionsWire)
})

describe('DimensionDefaultsSection', () => {
  it('reports a picked default and typed tags as patches', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithQueryClient(<DimensionDefaultsSection dimensionDefaults={undefined} tags={undefined} onChange={onChange} />)
    await user.selectOptions(await screen.findByLabelText('User type'), 'partner')
    expect(onChange).toHaveBeenCalledWith({ dimension_defaults: { user_type: 'partner' } })
    await user.type(screen.getByLabelText('Tags'), 'beta')
    expect(onChange).toHaveBeenLastCalledWith({ tags: ['beta'] })
  })

  it('says where to configure dimensions when there are none', async () => {
    serveDimensions({ dimensions: [] })
    renderWithQueryClient(<DimensionDefaultsSection dimensionDefaults={{}} tags={[]} onChange={vi.fn()} />)
    expect(await screen.findByText(/No dimensions are configured yet/)).toBeInTheDocument()
  })
})

describe('form and scraper records', () => {
  it('keep stored defaults and tags, and leave absent ones absent', () => {
    const [form, bare] = normalizeFeedbackForms([
      { form_id: 'f1', dimension_defaults: { product: 'web_shop', n: 1 }, tags: ['web', 2] },
      { form_id: 'f2' },
    ])
    expect([form?.dimension_defaults, form?.tags]).toStrictEqual([{ product: 'web_shop' }, ['web']])
    expect([bare?.dimension_defaults, bare?.tags]).toStrictEqual([undefined, undefined])
    expect(normalizeScrapers([{ id: 's1', tags: ['reviews'] }])[0]?.tags).toStrictEqual(['reviews'])
  })
})
