/**
 * Share (UX §9.4): the live link and its snippets, the Off banner with Publish, and Live | Test swapping every
 * snippet to the test link (or saying where to turn it on).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useConfigStore } from '../../../store/configStore'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import ShareTab from './ShareTab'

const LIVE = 'https://api.example.com/feedback-forms/f_test/iframe'

describe('ShareTab', () => {
  beforeEach(() => {
    useConfigStore.setState({ config: { ...useConfigStore.getState().config, apiEndpoint: 'https://api.example.com' } })
  })

  it('shows the live link, its iframe and the script embed', () => {
    renderWithDraft(<ShareTab />, sampleForm({ enabled: true }))
    expect(screen.getByRole('textbox', { name: 'Link' })).toHaveValue(LIVE)
    expect(screen.getByRole('region', { name: 'Embed (iframe)' })).toHaveTextContent(`src="${LIVE}"`)
    expect(screen.getByRole('region', { name: 'Script embed' })).toHaveTextContent("formId: 'f_test'")
  })

  it('says what the live link of an Off form shows, with Publish', () => {
    renderWithDraft(<ShareTab />, sampleForm({ enabled: false }))
    expect(screen.getByRole('note')).toHaveTextContent('This form is Off: its link shows “Feedback form unavailable.”')
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument()
  })

  it('swaps every snippet to the test link, which works while the form is Off', async () => {
    const user = userEvent.setup()
    renderWithDraft(<ShareTab />, sampleForm({ enabled: false, settings: { test: { link_enabled: true, record: 'tag' } } }))
    await user.click(screen.getByRole('button', { name: 'Test' }))
    expect(screen.getByRole('textbox', { name: 'Link' })).toHaveValue(`${LIVE}?test=tk_test`)
    expect(screen.getByRole('region', { name: 'Script embed' })).toHaveTextContent("test: 'tk_test'")
    expect(screen.getByText('Showing the test link: it works while the form is Off.')).toBeInTheDocument()
  })

  it('says where to turn the test link on when it is off', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<ShareTab />, sampleForm({ enabled: true }))
    await user.click(screen.getByRole('button', { name: 'Test' }))
    await user.click(screen.getByRole('button', { name: 'Open Test' }))
    expect(harness.go).toHaveBeenCalledWith('test')
  })
})
