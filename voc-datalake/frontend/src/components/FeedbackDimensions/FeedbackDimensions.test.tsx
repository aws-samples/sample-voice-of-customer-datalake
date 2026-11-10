/**
 * Dimension chips, the PII policy badge, and "Edit dimensions": only the
 * changed keys (null for a cleared one) and changed tags are sent, and a
 * refusal is explained.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { dimensionsWire } from '@test/dimensionFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { normalizeDimensionsConfig } from '../../api/dimensionsSchema'
import FeedbackDimensionChips from './FeedbackDimensionChips'
import DimensionsEditControl from './DimensionsEditControl'
import { dimensionChips, dimensionsChange } from './feedbackDimensions'

const dimensions = normalizeDimensionsConfig(dimensionsWire).dimensions
const feedback = {
  feedback_id: 'f1',
  dimensions: { product: 'mobile_app', module: 'login', legacy: 'x' },
  dimension_sources: { module: 'manual' },
  tags: ['vip'],
}

beforeEach(() => {
  resetFetchApi()
  routeFetchApi({
    'GET /settings/dimensions': () => dimensionsWire,
    'PUT /feedback/f1/dimensions': () => ({ success: true, feedback_id: 'f1', dimensions: {}, tags: [] }),
  })
})

describe('dimensionChips / dimensionsChange', () => {
  it('labels configured values in config order and humanises an unconfigured key and its value', () => {
    expect(dimensionChips(dimensions, feedback.dimensions)).toStrictEqual([
      { key: 'product', label: 'Product', value: 'Mobile app' },
      { key: 'module', label: 'Module', value: 'Login' },
      { key: 'legacy', label: 'Legacy', value: 'X' },
    ])
  })

  it('humanises a stored value the dimension has no label for (prod: "usage", "tech")', () => {
    expect(dimensionChips(dimensions, { user_type: 'tech_lead', product: 'usage' })).toStrictEqual([
      { key: 'product', label: 'Product', value: 'Usage' },
      { key: 'user_type', label: 'User type', value: 'Tech lead' },
    ])
  })

  it('sends only changed keys, null for a cleared one, and tags only when they changed', () => {
    expect(dimensionsChange(dimensions, feedback, { dimensions: { product: 'web_shop' }, tags: ['vip'] }))
      .toStrictEqual({ dimensions: { product: 'web_shop', module: null } })
    expect(dimensionsChange(dimensions, feedback, { dimensions: feedback.dimensions, tags: ['vip', 'new'] }))
      .toStrictEqual({ tags: ['vip', 'new'] })
    expect(dimensionsChange(dimensions, feedback, { dimensions: feedback.dimensions, tags: ['vip'] })).toBeNull()
  })
})

describe('FeedbackDimensionChips', () => {
  it('shows the values, marks a hand-set one, and lists tags', async () => {
    renderWithQueryClient(<FeedbackDimensionChips feedback={feedback} />)
    expect(await screen.findByText('Mobile app')).toBeInTheDocument()
    expect(screen.getByLabelText('Set by hand')).toBeInTheDocument()
    expect(screen.getByText('vip')).toBeInTheDocument()
  })

  // Labels vs status (design system rule 15): dimensions and tags are
  // descriptive labels, so they are neutral; a hand-set value is told apart by
  // its icon and title, not by a colour.
  it('paints every dimension chip and tag neutral, the hand-set one with a title', async () => {
    renderWithQueryClient(<FeedbackDimensionChips feedback={feedback} />)
    const manualChip = (await screen.findByText('Login')).closest('.badge')
    expect(manualChip).toHaveClass('badge-muted')
    expect(manualChip).toHaveAttribute('title', 'Set by hand')
    expect(screen.getByText('vip').closest('.badge')).toHaveClass('badge-muted')
    expect(document.querySelectorAll('.badge-info, .badge-aim, .badge-accent')).toHaveLength(0)
  })

  it.each([['redact', 'Redacted'], ['summary_only', 'Summary only']] as const)('badges a %s policy as a warn state', (policy, label) => {
    renderWithQueryClient(<FeedbackDimensionChips feedback={{ pii_policy: policy }} />)
    expect(screen.getByText(label)).toHaveClass('badge', 'badge-warn')
  })
})

describe('DimensionsEditControl', () => {
  it('saves a changed parent, clearing the child that no longer fits', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<DimensionsEditControl feedback={feedback} />)
    await user.click(await screen.findByRole('button', { name: 'Edit tags & dimensions' }))
    await user.selectOptions(await screen.findByLabelText('Product'), 'web_shop')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/feedback/f1/dimensions', {
      method: 'PUT', body: JSON.stringify({ dimensions: { product: 'web_shop', module: null } }),
    }))
  })

  it('explains a 409', async () => {
    routeFetchApi({
      'GET /settings/dimensions': () => dimensionsWire,
      'PUT /feedback/f1/dimensions': () => { throw new ApiError(409, 'changed') },
    })
    const user = userEvent.setup()
    renderWithQueryClient(<DimensionsEditControl feedback={feedback} />)
    await user.click(await screen.findByRole('button', { name: 'Edit tags & dimensions' }))
    await user.selectOptions(await screen.findByLabelText('User type'), 'partner')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone changed this review at the same time')
  })
})

describe('the edit trigger says what it edits, and the editor behaves like a dialog', () => {
  it('reads "Edit tags" when no dimension is configured', async () => {
    routeFetchApi({ 'GET /settings/dimensions': () => ({ ...dimensionsWire, dimensions: [] }) })
    renderWithQueryClient(<DimensionsEditControl feedback={feedback} />)
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/settings/dimensions', undefined))
    await fetchApi.mock.results.at(0)?.value
    expect(await screen.findByRole('button', { name: 'Edit tags' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit tags & dimensions' })).not.toBeInTheDocument()
  })

  it('moves focus in, cancels on Escape and gives focus back to the trigger', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<DimensionsEditControl feedback={feedback} />)
    await user.click(await screen.findByRole('button', { name: 'Edit tags & dimensions' }))
    await waitFor(() => expect(screen.getAllByRole('combobox').at(0)).toHaveFocus())

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit tags & dimensions' })).toHaveFocus()
  })

  it('leaves the PII policy to the text note when asked to', () => {
    renderWithQueryClient(<FeedbackDimensionChips feedback={{ pii_policy: 'redact' }} withPolicy={false} />)
    expect(screen.queryByText('Redacted')).not.toBeInTheDocument()
  })
})
