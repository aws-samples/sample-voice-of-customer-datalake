/**
 * @fileoverview The product interview must send a valid Bedrock history too.
 *
 * This surface posts to `/product-context/interview` rather than `/chat/stream`,
 * so it escaped the shared history builder at first. It still reaches Bedrock
 * Converse the same way: `interview_turn`
 * (`voc-datalake/lambda/api/product_context.py`) maps the entries 1:1 and then
 * appends the new message itself, with no repair. Two defects followed from
 * building the payload by hand here:
 *
 *   - the transcript opens with an assistant greeting, so the first turn sent
 *     was an assistant turn, which Bedrock rejects;
 *   - the payload included the new user message, which the server appends
 *     again, producing two consecutive user turns.
 *
 * Both are the alternation ValidationException that reaches the user as an
 * opaque error — the class of failure this PR exists to close.
 */
import {
  describe, it, expect, vi, beforeEach,
} from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { productTabApiModule, productTabMocks } from './product-tab-fixtures'
// After the fixtures on purpose: this imports ProductTab, whose module graph runs
// the `vi.mock` factory below, which needs the fixture module evaluated.
import ProductTab from './ProductTab'
import { emptyProductContext } from './productContextFields'
import { stubScrollToForSuite } from './project-detail-fixtures'
import { readSentHistory } from '../../test/historyPayload'
import { MAX_INTERVIEW_HISTORY_ENTRIES } from '../../constants/chat'

vi.mock('../../api/projectsApi', () => productTabApiModule())
const {
  productContextInterview: mockInterview,
  getProductContext: mockGetProductContext,
  listProductDocs: mockListProductDocs,
} = productTabMocks

/** Read the history the tab passed to the interview endpoint, guarded not cast. */
const sentHistory = (callIndex: number) => readSentHistory(mockInterview, callIndex)

async function askInterview(question: string): Promise<void> {
  const user = userEvent.setup()
  await user.type(await screen.findByPlaceholderText(/tell me about your product/i), question)
  await user.click(screen.getByRole('button', { name: /send/i }))
}

describe('ProductTab interview history', () => {
  // jsdom has no Element.scrollTo; see stubScrollToForSuite for why that matters here.
  stubScrollToForSuite()

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetProductContext.mockResolvedValue({ context: emptyProductContext() })
    mockListProductDocs.mockResolvedValue({ docs: [] })
    mockInterview.mockResolvedValue({
      assistant_message: 'and what problem does it solve?',
      applied_patch: {},
      context: emptyProductContext(),
    })
  })

  it('omits the assistant greeting and the new message from the first payload', async () => {
    render(<ProductTab canEdit projectId="proj-interview" />)

    await askInterview('we sell telemetry dashboards')
    await waitFor(() => expect(mockInterview).toHaveBeenCalledTimes(1))

    // The greeting is the only stored turn and it is an assistant turn, so
    // nothing survives. Sending it would put an assistant turn first; sending
    // the new message would duplicate what the server appends.
    //
    // The empty payload is the *intended* outcome, not merely the observed one:
    // `interview_turn` rebuilds the interview instructions and CURRENT CONTEXT
    // into its system prompt on every turn, so turn 1 is self-sufficient
    // without the greeting. See the comment at the call site in ProductTab.tsx.
    expect(sentHistory(0)).toStrictEqual([])
  })

  it('sends prior turns starting with a user turn and never repeats the new message', async () => {
    render(<ProductTab canEdit projectId="proj-interview" />)

    await askInterview('we sell telemetry dashboards')
    await waitFor(() => expect(mockInterview).toHaveBeenCalledTimes(1))
    // Wait for the reply to land in the transcript before asking again.
    await screen.findByText(/what problem does it solve/i)

    await askInterview('teams miss outages')
    await waitFor(() => expect(mockInterview).toHaveBeenCalledTimes(2))

    const history = sentHistory(1)
    const roles = history.map((entry) => entry.role)
    expect({
      // Not vacuous: the second send has a real answered turn to carry, and the
      // greeting must not lead the list — the first entry is the user's own answer.
      firstRole: history.at(0)?.role,
      firstIsTheAnswer: history.at(0)?.content.includes('telemetry dashboards'),
      // The message being sent must not also appear in the history.
      repeatsNewMessage: history.some((entry) => entry.content.includes('teams miss outages')),
      // Strict alternation, which is what Bedrock Converse requires.
      sameRoleTwiceInARow: roles.slice(1).filter((role, i) => role === roles[i]),
      withinCap: history.length <= MAX_INTERVIEW_HISTORY_ENTRIES,
    }).toStrictEqual({
      firstRole: 'user',
      firstIsTheAnswer: true,
      repeatsNewMessage: false,
      sameRoleTwiceInARow: [],
      withinCap: true,
    })
  })

  it('marks a failed turn with an alert icon and keeps the display-only flag out of the next payload', async () => {
    mockInterview.mockRejectedValueOnce(new Error('model unavailable'))
    render(<ProductTab canEdit projectId="proj-interview" />)

    await askInterview('we sell telemetry dashboards')
    const errorBubble = await screen.findByText('model unavailable')
    expect(errorBubble.querySelector('svg.lucide-triangle-alert')).not.toBeNull()

    await askInterview('teams miss outages')
    await waitFor(() => expect(mockInterview).toHaveBeenCalledTimes(2))

    const history = sentHistory(1)
    expect({
      // The failed reply is still a real assistant turn, so it is carried...
      carriesFailedTurn: history.some((entry) => entry.content === 'model unavailable'),
      // ...but only as role + content: `failed` is UI state, not wire shape.
      keys: [...new Set(history.flatMap((entry) => Object.keys(entry)))].sort((a, b) => a.localeCompare(b)),
    }).toStrictEqual({ carriesFailedTurn: true, keys: ['content', 'role'] })
  })
})
