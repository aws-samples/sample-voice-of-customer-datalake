/**
 * @fileoverview The preview pane and its window (PreviewPane, PreviewWindowProvider): a phone only (no Phone |
 * Desktop), its size, Restart, Start here for any card, Style, "Open in window ▾"; the notes under it; and the window
 * it opens, answered on `ready` with the draft, the language, the palette and the card, then kept up to date.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ChoiceQuestion, FormV2 } from '../model/formsV2'
import { newQuestion } from '../model/defaults'
import { blankForm } from '../test/blankForm'
import { FakeBroadcastChannel, listen } from '../test/fakeBroadcastChannel'
import PreviewPane from './PreviewPane'
import type { PreviewPaneProps } from './PreviewPane'
import PreviewWindowProvider from './PreviewWindowProvider'
import { knownPreviewSession, readPreviewMessage } from './previewChannel'

vi.mock('./PreviewFrame', () => import('../test/previewFrameStub'))

const FORM: FormV2 = { ...blankForm('en'), name: 'Exit survey', languages: ['en', 'pl'] }

/** What the window heard, by action. */
const actions = (heard: readonly unknown[]) => heard.map((message) => readPreviewMessage(message)?.action)

function renderPane(props: Partial<PreviewPaneProps> = {}, form: FormV2 = FORM) {
  const pane = (draft: FormV2, more: Partial<PreviewPaneProps>) => (
    <PreviewWindowProvider form={draft} formKey="form_1"><PreviewPane form={draft} selection="q_feedback" {...more} /></PreviewWindowProvider>
  )
  const view = render(pane(form, props))
  return { ...view, rerenderWith: (draft: FormV2, more: Partial<PreviewPaneProps> = props) => view.rerender(pane(draft, more)) }
}

/** Open the window from the pane's menu, at `size`; the window's side of the channel, listening. */
async function openWindow(size: RegExp) {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Open in window' }))
  await user.click(screen.getByRole('menuitem', { name: size }))
  const session = knownPreviewSession('form_1') ?? ''
  return listen(`voc-form-preview:${session}`)
}

beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
})

afterEach(() => {
  FakeBroadcastChannel.reset()
  window.sessionStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PreviewPane', () => {
  it('is a phone only: no Phone | Desktop, its size and zoom, and the toolbar', () => {
    renderPane({ onStyle: vi.fn() })
    expect(screen.queryByRole('button', { name: /^(Phone|Desktop)$/u })).not.toBeInTheDocument()
    expect(screen.getByText('Phone · 390 × 480 · 100 %')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Form preview, phone size, English' })).toBeInTheDocument()
    expect(['Restart', 'Start here', 'Style', 'Open in window'].map((name) => screen.getByRole('button', { name }).textContent)).toHaveLength(4)
  })

  it('shows Style pressed while its panel is open, and says which palette it forces', async () => {
    const onStyle = vi.fn()
    renderPane({ onStyle, styleOpen: true, scheme: 'dark' })
    expect(screen.getByRole('button', { name: 'Style' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Showing: Dark')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Style' }))
    expect(onStyle).toHaveBeenCalledExactlyOnceWith(expect.anything())
  })

  it('says a shuffled question keeps one order for the session, and never repeats the widget\'s "nothing is sent"', () => {
    const choice: ChoiceQuestion = { ...newQuestion('single_select', 'q_reason'), type: 'single_select', options: [], shuffle: 'all', display: 'auto', other: { enabled: false }, none: { enabled: false } }
    renderPane({}, { ...FORM, questions: [...FORM.questions, choice] })
    expect(screen.getByText('Shuffled for each respondent')).toBeInTheDocument()
    expect(screen.queryByText(/nothing is sent/iu)).not.toBeInTheDocument()
  })

  it('opens the window at the size chosen, and says so when the browser blocks it', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderPane()
    await openWindow(/^Tablet · 768 × 1024$/u)
    expect(open).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\/form-preview\.html#s=[\w-]+&ui=en&p=tablet&/u), 'voc-form-preview', 'popup=yes,width=768,height=1064')
    expect(screen.getByRole('alert')).toHaveTextContent('Your browser blocked the preview window.')
  })
})

describe('the preview window, from the builder', () => {
  it('answers the window\'s ready with the draft, its language, the palette and the card selected', async () => {
    vi.spyOn(window, 'open').mockReturnValue(window)
    vi.spyOn(window, 'focus').mockImplementation(() => {})
    renderPane({ selection: 'end:end_thanks', scheme: 'dark' })
    const { channel, heard } = await openWindow(/^Phone · 390 × 844$/u)
    act(() => channel.postMessage({ type: 'voc-form-preview', action: 'ready' }))
    expect(actions(heard)).toStrictEqual(['config', 'language', 'scheme', 'goTo'])
    const config = readPreviewMessage(heard[0])
    expect(config).toMatchObject({ config: { name: 'Exit survey', schema_version: 2 }, name: 'Exit survey' })
    expect([config?.action === 'config' ? config.languages.map((choice) => choice.value) : [], ...heard.slice(1)]).toStrictEqual([
      ['en', 'pl'],
      { type: 'voc-form-preview', action: 'language', language: 'en' },
      { type: 'voc-form-preview', action: 'scheme', scheme: 'dark' },
      { type: 'voc-form-preview', action: 'goTo', questionId: 'end:end_thanks' },
    ])
  })

  it('posts each edit 150 ms after it, and follows the card, the language and the commands', async () => {
    vi.spyOn(window, 'open').mockReturnValue(window)
    vi.spyOn(window, 'focus').mockImplementation(() => {})
    const { rerenderWith } = renderPane()
    const { heard } = await openWindow(/^Phone · 390 × 844$/u)
    vi.useFakeTimers()
    rerenderWith({ ...FORM, name: 'Renamed' }, { selection: 'welcome' })
    expect(heard).toStrictEqual([{ type: 'voc-form-preview', action: 'goTo', questionId: 'welcome' }])
    act(() => { vi.advanceTimersByTime(150) })
    expect(heard[1]).toMatchObject({ action: 'config', name: 'Renamed' })
    vi.useRealTimers()
    await userEvent.setup().selectOptions(within(screen.getByRole('button', { name: 'Restart' }).parentElement ?? document.body).getByRole('combobox'), 'pl')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Restart' }))
    expect(heard.slice(2)).toStrictEqual([{ type: 'voc-form-preview', action: 'language', language: 'pl' }, { type: 'voc-form-preview', action: 'restart' }])
  })

  it('talks to the window again after the builder reloads (the session is kept in this tab)', () => {
    window.sessionStorage.setItem('voc-form-preview-session:form_1', 'kept-session-1')
    const { heard } = listen('voc-form-preview:kept-session-1')
    renderPane()
    expect(actions(heard)).toStrictEqual(['config', 'language', 'scheme', 'goTo'])
  })
})
