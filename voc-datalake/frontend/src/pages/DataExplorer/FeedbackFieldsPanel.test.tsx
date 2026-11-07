import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderWithQueryClient } from '../../test/query-client'
import { configStoreModule } from '../Categories/categories-fixtures'
import { normalizeFeedbackCatalogue } from '../../api/feedbackCatalogueSchema'
import enCommon from '../../../public/locales/en/common.json'

const api = vi.hoisted(() => ({ getFeedbackCatalogue: vi.fn() }))
vi.mock('../../api/feedbackCatalogueApi', () => ({
  FEEDBACK_CATALOGUE_KEY: ['feedback-catalogue'],
  FEEDBACK_CATALOGUE_STALE_MS: 3_600_000,
  getFeedbackCatalogue: api.getFeedbackCatalogue,
}))
vi.mock('../../store/configStore', () => configStoreModule())

import FeedbackFieldsPanel from './FeedbackFieldsPanel'

const WIRE = {
  version: 1, table: 'voc-feedback',
  steps: [{ name: 'producer', meaning: 'Copied from the queue message' }, { name: 'enrichment', meaning: 'The model' }],
  policy_effects: [{ name: 'kept', meaning: 'stored as sent' }],
  fields: [
    { name: 'pk', type: 'string', meaning: 'The partition', set_by: ['processor'], always_present: true, key: true,
      pii: 'none', under_redact: 'kept', under_summary_only: 'kept' },
    { name: 'author', type: 'string', meaning: 'The author name', set_by: ['producer'], pii: 'personal',
      under_redact: 'redacted', under_summary_only: 'dropped' },
    { name: 'urgency', type: 'string', meaning: 'How soon', set_by: ['enrichment'], pii: 'none',
      under_redact: 'kept', under_summary_only: 'kept', values: ['high', 'low', 'medium'] },
    { name: 'dimensions', type: 'map', meaning: 'Dimension values', set_by: ['classification'], pii: 'brand_new_class',
      under_redact: 'kept', under_summary_only: 'kept', builtin_dimensions: { feedback_type: ['bug', 'praise'] } },
    { type: 'string', meaning: 'no name: dropped' },
  ],
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Fields' }))
}

async function openTable(): Promise<HTMLElement> {
  api.getFeedbackCatalogue.mockResolvedValue(normalizeFeedbackCatalogue(WIRE))
  renderWithQueryClient(<FeedbackFieldsPanel />)
  openPanel()
  return screen.findByTestId('feedback-fields-table')
}

function rowOf(table: HTMLElement, name: string): HTMLElement {
  const row = within(table).getByRole('rowheader', { name }).closest('tr')
  if (row === null) throw new Error(`no row ${name}`)
  return row
}

describe('FeedbackFieldsPanel', () => {
  beforeEach(() => {
    api.getFeedbackCatalogue.mockReset()
  })

  it('reads nothing until it is opened', () => {
    api.getFeedbackCatalogue.mockResolvedValue(normalizeFeedbackCatalogue(WIRE))
    renderWithQueryClient(<FeedbackFieldsPanel />)
    expect(screen.getByRole('button', { name: 'Fields' })).toHaveAttribute('aria-expanded', 'false')
    expect(api.getFeedbackCatalogue).not.toHaveBeenCalled()
  })

  it('renders one row per readable field (a row without a name is dropped)', async () => {
    const table = await openTable()
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(4)
  })

  it('names a field\u2019s meaning and personal data', async () => {
    const author = rowOf(await openTable(), 'author')
    expect(author).toHaveTextContent('The author name')
    expect(author).toHaveTextContent('Personal data')
  })

  it('says what each source policy does to a field', async () => {
    const author = rowOf(await openTable(), 'author')
    expect(author).toHaveTextContent('Redact: redacted')
    expect(author).toHaveTextContent('Summary only: dropped')
  })

  it('lists the steps that set a field, each with the server\u2019s meaning', async () => {
    const author = rowOf(await openTable(), 'author')
    expect(within(author).getByText('producer')).toHaveAttribute('title', 'Copied from the queue message')
  })

  it('marks key fields and lists enum and built-in dimension values', async () => {
    const table = await openTable()
    expect(within(table).getByRole('rowheader', { name: /pk/ })).toHaveTextContent('key')
    expect(within(table).getByText('high, low, medium')).toBeInTheDocument()
    expect(within(table).getByText('feedback_type: bug, praise')).toBeInTheDocument()
  })

  it('shows a class this client does not know as the server\u2019s word', async () => {
    api.getFeedbackCatalogue.mockResolvedValue(normalizeFeedbackCatalogue(WIRE))
    renderWithQueryClient(<FeedbackFieldsPanel />)
    openPanel()
    expect(await screen.findByText('brand_new_class')).toBeInTheDocument()
  })

  it('says so when the answer is malformed', async () => {
    api.getFeedbackCatalogue.mockResolvedValue(normalizeFeedbackCatalogue('not a catalogue'))
    renderWithQueryClient(<FeedbackFieldsPanel />)
    openPanel()
    expect(await screen.findByText('The API answered no fields.')).toBeInTheDocument()
  })

  it('offers a retry when the read fails', async () => {
    api.getFeedbackCatalogue.mockRejectedValue(new Error('boom'))
    renderWithQueryClient(<FeedbackFieldsPanel />)
    openPanel()
    expect(await screen.findByRole('alert')).toHaveTextContent(enCommon.loadFailed.message)
    expect(screen.getByRole('button', { name: enCommon.loadFailed.retry })).toBeInTheDocument()
  })
})
