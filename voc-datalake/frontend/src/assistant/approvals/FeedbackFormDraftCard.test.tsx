/**
 * The draft_feedback_form card (UX §12.5): the drafted form shown editable (its name, leaving a question out with
 * the rules that went to it), Approve held until each suggested address is checked or removed and the person may
 * create forms, "Open in builder" handing the draft to the builder and declining the card with its reason, and the
 * executor creating exactly the form the card shows, Off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { CLIENT_TOOLS } from '@stream/assistant/contract'

const createForm = vi.hoisted(() => vi.fn<(form: unknown) => Promise<unknown>>())
vi.mock('../../api/feedbackFormsV2Api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/feedbackFormsV2Api')>()
  return { ...actual, feedbackFormsV2Api: { ...actual.feedbackFormsV2Api, createForm } }
})

import { FeedbackFormDraftPreview, OPENED_IN_BUILDER_REASON } from './previews/FeedbackFormDraftPreview'
import { DRAFT_FEEDBACK_FORM_TOOL, draftFeedbackFormArgs } from './formSchemas'
import type { DraftFeedbackFormArgs } from './formSchemas'
import { FORM_NOT_SHOWN_MESSAGE, createDraftedForm, draftedFormLink } from './formExecutors'
import { ApprovalDeclineContext, ApprovalHoldContext, ShownContext, createShownRecord } from './shown'
import type { ShownRecord } from './shown'
import { getWriteTool } from './registry'
import { readHandoff } from '../../pages/FeedbackForms/builder/newFormHandoff'
import { stubElementScrollIntoView } from '../../test/stubScrollTo'

const question = (id: string, headline: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'open_text', headline: { en: headline }, required: true, long: false, input_type: 'text', ...extra,
})

const RAW = {
  form: {
    schema_version: 2, name: 'Switching back', enabled: true, language: 'en', languages: ['en'],
    welcome: { enabled: false, title: {} },
    questions: [
      {
        id: 'q_why', type: 'multi_select', headline: { en: 'What made you switch back?' }, required: true,
        options: [{ code: 'missing', label: { en: 'Something is missing' } }, { code: 'slow', label: { en: 'It is slow' } }],
        other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'list',
        logic: [{ when: { op: 'includes_any', value: ['missing'] }, then: { jump_to: 'q_which' } }],
      },
      question('q_which', 'Which function is missing?'),
      question('q_comment', 'Anything else?', { required: false, long: true }),
    ],
    hidden_fields: [{ id: 'user_id' }],
    endings: [{ id: 'end_thanks', title: { en: 'Thank you' }, button: { label: { en: 'Help' }, url: 'https://example.com/help' } }],
    settings: { test: { link_enabled: false, record: 'tag' } },
  },
  notes: ['The reasons are listed in full.'],
  warnings: [{ message: 'An http:// address was removed.', target: 'end_thanks' }],
  channel: 'in_app',
}

const ARGS: DraftFeedbackFormArgs = draftFeedbackFormArgs.parse(RAW)
const ONE_QUESTION: DraftFeedbackFormArgs = { ...ARGS, form: { ...ARGS.form, questions: ARGS.form.questions.slice(2) } }

/** Where the builder handoff landed: the history state the builder would read, as text. */
function BuilderProbe() {
  const location = useLocation()
  return <p data-testid="handoff">{readHandoff(location.state)?.form.name ?? 'none'}</p>
}

interface Card {
  readonly shown: ShownRecord
  readonly hold: ReturnType<typeof vi.fn<(held: boolean) => void>>
  readonly decline: ReturnType<typeof vi.fn<(reason: string) => void>>
  readonly user: ReturnType<typeof userEvent.setup>
}

function renderCard(args: DraftFeedbackFormArgs = ARGS): Card {
  const shown = createShownRecord()
  const hold = vi.fn<(held: boolean) => void>()
  const decline = vi.fn<(reason: string) => void>()
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/chat']}>
        <Routes>
          <Route path="/chat" element={(
            <ShownContext.Provider value={shown}>
              <ApprovalHoldContext.Provider value={hold}>
                <ApprovalDeclineContext.Provider value={decline}>
                  <FeedbackFormDraftPreview args={args} />
                </ApprovalDeclineContext.Provider>
              </ApprovalHoldContext.Provider>
            </ShownContext.Provider>
          )} />
          <Route path="/feedback-forms/new/questions" element={<BuilderProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { shown, hold, decline, user: userEvent.setup() }
}

const tickAddress = async (user: Card['user']) => user.click(screen.getByRole('checkbox', { name: "I've checked this address" }))

beforeEach(() => {
  stubElementScrollIntoView()
})

afterEach(() => {
  createForm.mockReset()
})

describe('the draft_feedback_form args', () => {
  it('reads the drafted form, Off whatever the model sent, with its notes and channel', () => {
    expect(ARGS.form.enabled).toBe(false)
    expect(ARGS.form.questions.map((q) => q.id)).toStrictEqual(['q_why', 'q_which', 'q_comment'])
    expect(ARGS.notes).toStrictEqual([{ message: 'The reasons are listed in full.' }])
    expect(ARGS.channel).toBe('in_app')
  })

  it('refuses a form with a problem that blocks a save, in the validator’s words', () => {
    const blank = { ...RAW, form: { ...RAW.form, questions: [question('q_one', '')] } }
    const parsed = draftFeedbackFormArgs.safeParse(blank)
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((issue) => issue.message)).toStrictEqual(['Q1: Write the question.'])
  })

  it('refuses args that are not a form at all, and unknown keys', () => {
    expect(draftFeedbackFormArgs.safeParse({ form: 'a form' }).success).toBe(false)
    expect(draftFeedbackFormArgs.safeParse({ ...RAW, extra: 1 }).success).toBe(false)
  })
})

describe('the draft_feedback_form card', () => {
  it('shows the form: its name, a summary, the questions, the ending, the hidden fields and the AI’s notes', () => {
    renderCard()
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Switching back')
    expect(screen.getByText('English · In-app · 3 questions · 1 ending · 1 hidden field')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Questions' }).children).toHaveLength(3)
    expect(screen.getByText('An http:// address was removed.')).toBeInTheDocument()
  })

  it('holds Approve until the suggested address is checked, then records the form to create', async () => {
    const { hold, shown, user } = renderCard()
    expect(hold).toHaveBeenLastCalledWith(true)
    await tickAddress(user)
    expect(hold).toHaveBeenLastCalledWith(false)
    expect(shown.feedbackFormDraft?.form.name).toBe('Switching back')
  })

  it('lets the address be removed instead, and creates the ending without its button', async () => {
    const { hold, shown, user } = renderCard()
    await user.click(screen.getByRole('button', { name: 'Remove the address https://example.com/help' }))
    expect(hold).toHaveBeenLastCalledWith(false)
    expect(shown.feedbackFormDraft?.form.endings[0]?.button).toBeUndefined()
  })

  it('leaves a question out with the rule that went to it, and says so', async () => {
    const { shown, user } = renderCard()
    await tickAddress(user)
    await user.click(screen.getByRole('button', { name: 'Leave out question 2' }))
    expect(screen.getByRole('status')).toHaveTextContent('Question 2 is left out. The rule on 1 that went to it is dropped too.')
    expect(shown.feedbackFormDraft?.form.questions.map((q) => q.id)).toStrictEqual(['q_why', 'q_comment'])
    expect(shown.feedbackFormDraft?.form.questions[0]?.logic).toBeUndefined()
  })

  it('never leaves out the last question, and says why', async () => {
    const { user } = renderCard(ONE_QUESTION)
    const button = screen.getByRole('button', { name: 'Leave out question 1' })
    await user.click(button)
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText("A form needs at least one question, so the last one can't be left out.")).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Questions' }).children).toHaveLength(1)
  })

  it('creates the form under the name the person typed, and holds Approve while it has none', async () => {
    const { hold, shown, user } = renderCard()
    await tickAddress(user)
    const name = screen.getByRole('textbox', { name: 'Name' })
    await user.clear(name)
    expect(hold).toHaveBeenLastCalledWith(true)
    await user.type(name, 'Powrót')
    expect(shown.feedbackFormDraft?.form.name).toBe('Powrót')
  })

  it('opens the draft in the builder, unsaved, and declines the card with the reason', async () => {
    const { decline, user } = renderCard()
    await user.click(screen.getByRole('button', { name: 'Open in builder' }))
    expect(await screen.findByTestId('handoff')).toHaveTextContent('Switching back')
    expect(decline).toHaveBeenCalledWith(OPENED_IN_BUILDER_REASON)
  })

})

describe('the draft_feedback_form executor', () => {
  const ctx = (shown: ShownRecord) => ({ queryClient: new QueryClient(), shown })

  it('creates exactly the form the card shows, Off, and says so to the model', async () => {
    createForm.mockResolvedValue({ form: { ...ARGS.form, name: 'Renamed' }, meta: { form_id: 'f_new' } })
    const shown = createShownRecord()
    shown.feedbackFormDraft = { form: { ...ARGS.form, name: 'Renamed', enabled: true } }
    const result = await createDraftedForm(ARGS, ctx(shown))
    expect(createForm).toHaveBeenCalledWith({ ...ARGS.form, name: 'Renamed', enabled: false })
    expect(result.data).toStrictEqual({ form_id: 'f_new', name: 'Renamed' })
    expect(result.summary).toMatch(/^Created the feedback form “Renamed” \(f_new\), Off, with 3 questions and 1 ending\./)
  })

  it('creates nothing when the card had no form that could be created', async () => {
    await expect(createDraftedForm(ARGS, ctx(createShownRecord()))).rejects.toThrow(FORM_NOT_SHOWN_MESSAGE)
    expect(createForm).not.toHaveBeenCalled()
  })

  it('links the resolved card to the new form’s questions, once it exists', () => {
    expect(draftedFormLink(ARGS, { form_id: 'f_new', name: 'Renamed' })).toStrictEqual({
      to: '/feedback-forms/f_new/questions', labelKey: 'assistantTools:card.openForm',
    })
    expect(draftedFormLink(ARGS)).toBeUndefined()
  })

  it('is registered as a card exactly when the stream contract lists the tool', () => {
    const listed = Object.values(CLIENT_TOOLS).flat().some((tool: string) => tool === DRAFT_FEEDBACK_FORM_TOOL)
    expect(getWriteTool(DRAFT_FEEDBACK_FORM_TOOL) !== undefined).toBe(listed)
  })
})
