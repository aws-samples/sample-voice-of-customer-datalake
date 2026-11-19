/**
 * Share (UX §9.4): the live link and its snippets (the iframe with its resizer, the whole script embed), the Off
 * banner with Publish, Live | Test swapping every snippet to the test link (or saying where to turn it on), and a new
 * form's Save saying why it is off (F27).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useConfigStore } from '../../../store/configStore'
import { OPEN_PROBLEMS_EVENT } from '../builder/problemText'
import type { Question } from '../model/formsV2'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import ShareTab from './ShareTab'

/** An open question with no headline: one problem that blocks Save. */
const untitled = (id: string): Question => ({ id, type: 'open_text', headline: { en: '' }, required: true, long: true, input_type: 'text' })

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

  it('gives the whole script embed: the element, the widget file from this app and the init call', () => {
    renderWithDraft(<ShareTab />, sampleForm({ enabled: true }))
    const script = screen.getByRole('region', { name: 'Script embed' })
    const app = window.location.origin
    // tabs/snippets.test.ts pins the whole text; here, its three parts as the tab shows them.
    expect(script).toHaveTextContent(`<div id="voc-feedback-form"></div>`)
    expect(script).toHaveTextContent(`<script src="${app}/widget/feedback-widget.js"></script>`)
    expect(script).toHaveTextContent("VoCFeedbackForm.init({")
    expect(screen.getByText(`Paste it where the form should appear. The widget file comes from this app and updates with each release. If your site sets a Content-Security-Policy, allow script-src ${app} and connect-src https://api.example.com.`))
      .toBeInTheDocument()
  })

  it("gives the iframe a resizer that takes only the frame's own height messages from the API", () => {
    renderWithDraft(<ShareTab />, sampleForm({ enabled: true }))
    const iframe = screen.getByRole('region', { name: 'Embed (iframe)' })
    expect(iframe).toHaveTextContent('id="voc-form-f_test"')
    expect(iframe).toHaveTextContent("event.source !== frame.contentWindow || event.origin !== 'https://api.example.com'")
    expect(iframe).toHaveTextContent("data.type === 'voc-form-height'")
    expect(screen.getByText("The script after the frame sets its height to the form's. Without it, the frame stays 480 px tall and the form scrolls inside it."))
      .toBeInTheDocument()
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

  it("says why a new form's Save is off, and Go to selects the one problem", async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<ShareTab />, sampleForm({ questions: [untitled('q_empty')] }), { isNew: true })
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toHaveAttribute('aria-disabled', 'true')
    expect(save).toHaveAccessibleDescription('Fix 1 problem to save.')
    await user.click(save)
    expect(harness.onCreated).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Go to' }))
    expect(harness.go).toHaveBeenCalledWith('questions', ['q_empty'])
  })

  it('opens the problems list when several problems block Save', async () => {
    const user = userEvent.setup()
    const opened = vi.fn()
    window.addEventListener(OPEN_PROBLEMS_EVENT, opened)
    renderWithDraft(<ShareTab />, sampleForm({ questions: [untitled('q_one'), untitled('q_two')] }), { isNew: true })
    expect(screen.getByText('Fix 2 problems to save.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show problems' }))
    window.removeEventListener(OPEN_PROBLEMS_EVENT, opened)
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('lets a new form without problems save from here, with no reason shown', () => {
    renderWithDraft(<ShareTab />, sampleForm(), { isNew: true })
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'false')
    expect(screen.queryByText(/to save\./)).not.toBeInTheDocument()
  })

  it('says where to turn the test link on when it is off', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<ShareTab />, sampleForm({ enabled: true }))
    await user.click(screen.getByRole('button', { name: 'Test' }))
    await user.click(screen.getByRole('button', { name: 'Open Test' }))
    expect(harness.go).toHaveBeenCalledWith('test')
  })
})
