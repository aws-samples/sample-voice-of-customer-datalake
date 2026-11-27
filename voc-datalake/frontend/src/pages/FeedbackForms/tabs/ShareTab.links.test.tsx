/**
 * Share's link builder and link checks: a value for each hidden field goes into the link and the embeds, a
 * hidden field the form's texts recall that the link leaves empty is warned about (and no longer once filled, nor a
 * field no text recalls), and a link that never filled a hidden field is said, with the way to Hidden fields.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const getResults = vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => {
  const { parseFormResults } = await import('../../../api/feedbackFormsV2Results')
  return (await import('../test/formsApiMock')).formsApiWith(importOriginal, { getResults: async (...args: unknown[]) => parseFormResults(await getResults(...args)) })
})

import { useConfigStore } from '../../../store/configStore'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import { LINK_HEALTH, PHASES } from '../results/results-fixtures'
import ShareTab from './ShareTab'

const LIVE = 'https://api.example.com/feedback-forms/f_test/iframe'
const RECALLING = sampleForm({
  enabled: true, questions: [PHASES], hidden_fields: [{ id: 'event', label: 'Event' }, { id: 'customer' }],
  endings: [{ id: 'end_thanks', title: { en: 'Thanks for joining {{event}}!' } }],
})

describe('ShareTab links', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getResults.mockResolvedValue({})
    useConfigStore.setState({ config: { ...useConfigStore.getState().config, apiEndpoint: 'https://api.example.com' } })
  })

  it('warns about a recalled hidden field the link leaves empty, never about one no text recalls', () => {
    renderWithDraft(<ShareTab />, RECALLING)
    const warnings = screen.getByRole('list', { name: 'Hidden fields this link leaves empty' })
    expect(within(warnings).getAllByRole('listitem').map((item) => item.textContent))
      .toStrictEqual(['This link leaves event empty: respondents see the text without it.'])
  })

  it('puts the values given into the link and the script embed, and stops warning once filled', async () => {
    const user = userEvent.setup()
    renderWithDraft(<ShareTab />, RECALLING)
    await user.type(screen.getByRole('textbox', { name: 'Event hf_event' }), 'Lisbon & Porto')
    expect(screen.getByRole('textbox', { name: 'Link' })).toHaveValue(`${LIVE}?hf_event=Lisbon%20%26%20Porto`)
    expect(screen.getByRole('region', { name: 'Script embed' })).toHaveTextContent("hidden: { event: 'Lisbon & Porto', customer: '{CUSTOMER}' },")
    expect(screen.queryByRole('list', { name: 'Hidden fields this link leaves empty' })).not.toBeInTheDocument()
  })

  it('has no link builder for a form without hidden fields', () => {
    renderWithDraft(<ShareTab />, sampleForm({ enabled: true }))
    expect(screen.queryByRole('group', { name: 'Values in this link' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Link' })).toHaveValue(LIVE)
  })

  it("says when the form's links never filled a hidden field, over every real response, with the way to Hidden fields", async () => {
    const user = userEvent.setup()
    getResults.mockResolvedValue({ link_health: LINK_HEALTH })
    const harness = renderWithDraft(<ShareTab />, RECALLING)
    expect(await screen.findByRole('note')).toHaveTextContent('0 of 26 responses had customer: check your link.')
    await user.click(screen.getByRole('button', { name: 'Open Hidden fields' }))
    expect(harness.go).toHaveBeenCalledWith('hidden-fields')
    expect(getResults).toHaveBeenCalledWith('f_test', { days: null, language: '', ending: '', hidden: {}, includeTest: false })
  })
})
