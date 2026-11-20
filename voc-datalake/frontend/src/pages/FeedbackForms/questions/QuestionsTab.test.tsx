import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import type { DraftHarnessOptions } from '../test/draftHarness'
import type { FormV2, Question } from '../model/formsV2'
import { FakeBroadcastChannel } from '../test/fakeBroadcastChannel'
import PreviewWindowProvider from '../preview/PreviewWindowProvider'
import QuestionsTab from './QuestionsTab'
import { requestFocus } from './focusRequest'

vi.mock('../preview/PreviewFrame', () => import('../test/previewFrameStub'))
vi.mock('../../../hooks/useCategories', () => ({ useCategoriesConfig: () => ({ data: { categories: [] } }) }))

const ignore = (): void => undefined

/** A screen `width` px wide: the tab's `(min-width: …px)` queries match by it. */
function screenWidth(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= Number.parseInt(query.slice(query.indexOf(':') + 1), 10),
    media: query,
    addEventListener: ignore,
    removeEventListener: ignore,
  }))
}

const text = (id: string, headline: string): Question => ({ id, type: 'open_text', headline: { en: headline }, required: false, long: true, input_type: 'text' })

const threeTexts = (): FormV2 => sampleForm({ questions: [text('q_first', 'First?'), text('q_second', 'Second?'), text('q_third', 'Third?')] })

const renderTab = (form: FormV2, rest: readonly string[], options: DraftHarnessOptions = {}) => renderWithDraft(<QuestionsTab />, form, { rest, ...options })

describe('QuestionsTab on a narrow screen', () => {
  it('is the list until a card is opened', async () => {
    const user = userEvent.setup()
    const harness = renderTab(threeTexts(), [])
    expect(screen.queryByRole('textbox', { name: 'Question' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Question 2 of 3/ }))
    expect(harness.go).toHaveBeenCalledWith('questions', ['q_second'])
  })

  it('opens the card full width, with the way back to the list', async () => {
    const user = userEvent.setup()
    const harness = renderTab(threeTexts(), ['q_second'])
    expect(screen.queryByRole('list', { name: 'Questions' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('Second?')
    await user.click(screen.getByRole('button', { name: 'Questions' }))
    expect(harness.go).toHaveBeenCalledWith('questions', [])
  })

  it('says where the question is, and steps to the previous and next one', async () => {
    const user = userEvent.setup()
    const harness = renderTab(threeTexts(), ['q_second'])
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Previous question' }))
    expect(harness.go).toHaveBeenCalledWith('questions', ['q_first'])
    await user.click(screen.getByRole('button', { name: 'Next question' }))
    expect(harness.go).toHaveBeenCalledWith('questions', ['q_third'])
  })

  it('steps no further than the last question', async () => {
    const user = userEvent.setup()
    const harness = renderTab(threeTexts(), ['q_third'])
    expect(screen.getByRole('button', { name: 'Next question' })).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('button', { name: 'Next question' }))
    expect(harness.go).not.toHaveBeenCalledWith('questions', expect.anything())
  })

  it('opens the preview in a new tab, never in the page', async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    onTestFinished(() => { FakeBroadcastChannel.reset(); window.sessionStorage.clear(); vi.unstubAllGlobals() })
    const open = vi.spyOn(window, 'open').mockReturnValue(window)
    const user = userEvent.setup()
    const form = threeTexts()
    renderWithDraft(<PreviewWindowProvider form={form} formKey="f_test"><QuestionsTab /></PreviewWindowProvider>, form, { rest: ['q_first'] })
    await user.click(screen.getByRole('button', { name: 'Preview, opens in a new tab' }))
    expect(open).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\/form-preview\.html#s=[\w-]+&ui=en&p=phone&/u), 'voc-form-preview')
    expect(screen.queryByRole('complementary', { name: 'Preview' })).not.toBeInTheDocument()
  })

  it('shows the preview in the page on a tablet, only when asked', async () => {
    screenWidth(800)
    onTestFinished(() => { vi.unstubAllGlobals() })
    const user = userEvent.setup()
    renderTab(threeTexts(), ['q_first'])
    expect(screen.queryByRole('complementary', { name: 'Preview' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show preview' }))
    expect(screen.getByRole('complementary', { name: 'Preview' })).toContainElement(screen.getByTestId('preview-frame'))
    expect(screen.getByRole('button', { name: 'Hide preview' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens an ending without a position', () => {
    renderTab(threeTexts(), ['end', 'end_thanks'])
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Thank you!')
    expect(screen.queryByRole('button', { name: 'Previous question' })).not.toBeInTheDocument()
  })

  it('says a card that is gone is no longer in the form', () => {
    renderTab(threeTexts(), ['q_gone'])
    expect(screen.getByText('This card is no longer in the form.')).toBeInTheDocument()
  })

  it('says an ending that is gone is no longer in the form', () => {
    renderTab(threeTexts(), ['end', 'end_gone'])
    expect(screen.getByText('This card is no longer in the form.')).toBeInTheDocument()
  })

  it('clears the AI marker of the card it opens', () => {
    const harness = renderTab(threeTexts(), ['q_second'], {
      isNew: true, handoff: { ai: { notes: [], warnings: [], description: 'A churn survey', channel: 'link', addresses: [] } },
    })
    expect(harness.probe.current?.ai?.marked).toStrictEqual(new Set(['q_first', 'q_third', 'end_thanks']))
  })
})

describe('QuestionsTab with room for the editor', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('selects the first question when none is', () => {
    screenWidth(1100)
    const harness = renderTab(threeTexts(), [])
    expect(harness.go).toHaveBeenCalledWith('questions', ['q_first'], { replace: true })
  })

  it('shows the list beside the editor, the preview behind its toggle', () => {
    screenWidth(1100)
    renderTab(threeTexts(), ['q_second'])
    expect(screen.getByRole('list', { name: 'Questions' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue('Second?')
    expect(screen.getByRole('button', { name: 'Show preview' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows the preview as a third pane from xl, with no toggle', () => {
    screenWidth(1400)
    renderTab(threeTexts(), ['q_second'])
    expect(screen.getByRole('complementary', { name: 'Preview' })).toContainElement(screen.getByTestId('preview-frame'))
    expect(screen.queryByRole('button', { name: 'Show preview' })).not.toBeInTheDocument()
  })
})

describe('QuestionsTab: the welcome card', () => {
  const welcomeOn = (): FormV2 => sampleForm({ welcome: { enabled: true, title: { en: 'Hello' } } })

  it('shows a welcome screen once switched on, and asks for its title', async () => {
    const user = userEvent.setup()
    const harness = renderTab(sampleForm(), ['welcome'])
    await user.click(screen.getByRole('switch', { name: /^Show a welcome screen/ }))
    expect(harness.probe.current?.form.welcome.enabled).toBe(true)
    expect(screen.getByText('The welcome screen needs a title.')).toBeInTheDocument()
  })

  it('writes its title, description and button label', async () => {
    const user = userEvent.setup()
    const harness = renderTab(welcomeOn(), ['welcome'])
    await user.type(screen.getByRole('textbox', { name: 'Title' }), ' there')
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Two minutes')
    await user.type(screen.getByRole('textbox', { name: 'Button label' }), 'Begin')
    expect(harness.probe.current?.form.welcome).toStrictEqual({
      enabled: true, title: { en: 'Hello there' }, description: { en: 'Two minutes' }, button_label: { en: 'Begin' },
    })
  })

  it('focuses its title when the list asked for it', () => {
    requestFocus('welcome')
    renderTab(welcomeOn(), ['welcome'])
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus()
  })
})
