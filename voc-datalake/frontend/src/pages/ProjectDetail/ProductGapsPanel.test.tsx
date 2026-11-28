/**
 * The gaps panel (7.104.00): before any extract one default question per empty field (all 12 fields have one), after
 * it the extract's own questions; "Type answers" then "Save answers" (one typed interview source, its proposal named),
 * then "Extract again"; "Talk it through" only with `features.voice`; the assistant's chat interview beside it (owner
 * decision 12); and a viewer who reads the questions only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { useAssistantUiStore } from '../../assistant/store/assistantStore'
import { PRODUCT_CONTEXT_FIELDS } from '../../api/productSourcesSchema'
import { PROJECT, extractStub, proposalOf } from './product-sources-fixtures'
import ProductGapsPanel from './ProductGapsPanel'
import { emptyProductContext } from './productContextFields'
import { useGapQuestions } from './useProductProposal'
import type { GapQuestion } from './useProductProposal'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
const voice = vi.hoisted(() => ({ on: false }))
vi.mock('../../runtimeConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../runtimeConfig')>(),
  isVoiceAvailable: () => voice.on,
}))

const QUESTIONS: readonly GapQuestion[] = [
  { field: 'differentiators', question: 'What makes it different?' },
  { field: 'success_metrics', question: 'Which numbers show it works?' },
]
const ANSWERS = `/projects/${PROJECT}/product-docs/answers`

interface PanelOptions {
  readonly canEdit?: boolean
  readonly typing?: boolean
  readonly extract?: ReturnType<typeof extractStub>
}

function renderPanel({ canEdit = true, typing = false, extract = extractStub() }: PanelOptions = {}) {
  const proposalId = 'pp-1'
  const onTypingChange = vi.fn()
  renderWithQueryClient(<ProductGapsPanel projectId={PROJECT} projectName="Parcel Pilot" questions={QUESTIONS} proposalId={proposalId}
    canEdit={canEdit} extract={extract} typing={typing} onTypingChange={onTypingChange} />)
  return onTypingChange
}

beforeEach(() => {
  resetFetchApi()
  voice.on = false
  useAssistantUiStore.getState().reset()
})

describe('useGapQuestions', () => {
  it('asks one default question for each empty field before any extract, all 12 fields covered', () => {
    const { result } = renderHook(() => useGapQuestions(null, emptyProductContext()))
    expect(result.current.map((one) => one.field)).toStrictEqual(PRODUCT_CONTEXT_FIELDS)
    expect(result.current.every((one) => one.question.endsWith('?'))).toBe(true)
  })

  it('leaves out a filled field, and takes the extract\'s own questions when it has some', () => {
    const filled = { ...emptyProductContext(), product_name: 'Parcel Pilot' }
    const { result: defaults } = renderHook(() => useGapQuestions(null, filled))
    expect(defaults.current.map((one) => one.field)).not.toContain('product_name')
    const { result: asked } = renderHook(() => useGapQuestions(proposalOf({}, { questions: [...QUESTIONS] }), filled))
    expect(asked.current).toStrictEqual(QUESTIONS)
  })
})

describe('ProductGapsPanel', () => {
  it('lists the questions with the three ways to answer; no voice without features.voice', () => {
    renderPanel()
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toStrictEqual(['What makes it different?', 'Which numbers show it works?'])
    expect(screen.getByRole('button', { name: 'Type answers' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Answer in the AI chat' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Talk it through' })).not.toBeInTheDocument()
  })

  it('offers Talk it through with features.voice: the product interviewer\'s consent first, and Cancel closes it', async () => {
    voice.on = true
    routeFetchApi({ [`GET /projects/${PROJECT}/product-interview/voice-sessions`]: () => ({ enabled: true, minutes_left: 100, sessions_left_today: 5 }) })
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('button', { name: 'Talk it through' }))
    expect(await screen.findByRole('dialog', { name: 'Talk it through' })).toHaveTextContent(/An AI interviewer asks the questions/)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('opens the assistant\'s chat interview, drafted and not sent', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('button', { name: 'Answer in the AI chat' }))
    expect(useAssistantUiStore.getState().pendingDraft?.text).toBe("Interview me to fill in this project's product description.")
  })

  it('saves the typed answers as one source, naming the proposal, then offers Extract again', async () => {
    routeFetchApi({ [`POST ${ANSWERS}`]: () => ({ doc: { doc_id: 'doc-5', status: 'ready', source_kind: 'interview' } }) })
    const extract = extractStub()
    const user = userEvent.setup()
    const onTypingChange = renderPanel({ typing: true, extract })
    expect(screen.getByRole('button', { name: 'Save answers' })).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: /What makes it different\?/ }), 'Works with every carrier')
    await user.click(screen.getByRole('button', { name: 'Save answers' }))
    await waitFor(() => expect(sentFetchApiBody(ANSWERS, 'POST')).toStrictEqual({
      proposal_id: 'pp-1', mode: 'typed',
      answers: [{ field: 'differentiators', question: 'What makes it different?', answer: 'Works with every carrier' }],
    }))
    expect(onTypingChange).toHaveBeenCalledWith(false)
  })

  it('offers Extract again once the answers are saved', async () => {
    routeFetchApi({ [`POST ${ANSWERS}`]: () => ({ doc: { doc_id: 'doc-5', status: 'ready' } }) })
    const extract = extractStub()
    const user = userEvent.setup()
    const props = { projectId: PROJECT, projectName: 'P', questions: QUESTIONS, proposalId: undefined, canEdit: true, extract }
    const { rerender } = renderWithQueryClient(<ProductGapsPanel {...props} typing onTypingChange={vi.fn()} />)
    await user.type(screen.getAllByRole('textbox')[0] ?? document.body, 'An answer')
    await user.click(screen.getByRole('button', { name: 'Save answers' }))
    await waitFor(() => expect(sentFetchApiBody(ANSWERS, 'POST')).toMatchObject({ mode: 'typed' }))
    rerender(<ProductGapsPanel {...props} typing={false} onTypingChange={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Extract again' }))
    expect(extract.start).toHaveBeenCalledTimes(1)
  })

  it('for a viewer, lists the questions and offers no way to answer', () => {
    renderPanel({ canEdit: false })
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryAllByRole('button')).toStrictEqual([])
  })
})
