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
  describe, it, expect, vi, beforeAll, afterAll, beforeEach,
} from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProductTab from './ProductTab'
import { emptyProductContext } from './productContextFields'
import { stubElementScrollTo } from '../../test/stubScrollTo'
import { MAX_INTERVIEW_HISTORY_ENTRIES } from '../../constants/chat'

const mockInterview = vi.fn()
const mockGetProductContext = vi.fn()
const mockListProductDocs = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getProductContext: (...args: unknown[]) => mockGetProductContext(...args),
    updateProductContext: vi.fn(),
    listProductDocs: (...args: unknown[]) => mockListProductDocs(...args),
    productContextInterview: (...args: unknown[]) => mockInterview(...args),
    generateProductReport: vi.fn(),
    getProductDocUploadUrl: vi.fn(),
  },
}))

interface SentHistoryEntry {
  role: string
  content: string
}

function isHistoryEntry(value: unknown): value is SentHistoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const record: Record<string, unknown> = { ...value }
  return typeof record.role === 'string' && typeof record.content === 'string'
}

/**
 * Read the history the tab passed to the interview endpoint, validated with a
 * type guard rather than an `as` cast so a payload-shape change fails here.
 */
function sentHistory(callIndex: number): SentHistoryEntry[] {
  const call: unknown[] | undefined = mockInterview.mock.calls[callIndex]
  if (call === undefined) throw new Error(`interview was not called ${callIndex + 1} time(s)`)
  const body: unknown = call[1]
  if (typeof body !== 'object' || body === null || !('history' in body)) {
    throw new Error('interview body did not include a history field')
  }
  const { history } = body
  if (!Array.isArray(history) || !history.every(isHistoryEntry)) {
    throw new Error('history was not an array of {role, content} entries')
  }
  return history
}

async function askInterview(question: string): Promise<void> {
  const user = userEvent.setup()
  await user.type(await screen.findByPlaceholderText(/tell me about your product/i), question)
  await user.click(screen.getByRole('button', { name: /send/i }))
}

describe('ProductTab interview history', () => {
  // The interview effect scrolls the transcript; jsdom has no Element.scrollTo
  // and the exception would render the tab as an empty div, turning these
  // assertions into vacuous passes.
  let restoreScrollTo: () => void
  beforeAll(() => {
    restoreScrollTo = stubElementScrollTo()
  })
  afterAll(() => {
    restoreScrollTo()
  })

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
    render(<ProductTab projectId="proj-interview" />)

    await askInterview('we sell telemetry dashboards')
    await waitFor(() => expect(mockInterview).toHaveBeenCalledTimes(1))

    // The greeting is the only stored turn and it is an assistant turn, so
    // nothing survives. Sending it would put an assistant turn first; sending
    // the new message would duplicate what the server appends.
    expect(sentHistory(0)).toEqual([])
  })

  it('sends prior turns starting with a user turn and never repeats the new message', async () => {
    render(<ProductTab projectId="proj-interview" />)

    await askInterview('we sell telemetry dashboards')
    await waitFor(() => expect(mockInterview).toHaveBeenCalledTimes(1))
    // Wait for the reply to land in the transcript before asking again.
    await screen.findByText(/what problem does it solve/i)

    await askInterview('teams miss outages')
    await waitFor(() => expect(mockInterview).toHaveBeenCalledTimes(2))

    const history = sentHistory(1)
    // Not vacuous: the second send has a real answered turn to carry.
    expect(history.length).toBeGreaterThan(0)
    expect(history[0].role).toBe('user')
    // The greeting must not lead the list.
    expect(history[0].content).toContain('telemetry dashboards')
    // The message being sent must not also appear in the history.
    expect(history.some((entry) => entry.content.includes('teams miss outages'))).toBe(false)
    // Strict alternation, which is what Bedrock Converse requires.
    history.forEach((entry, i) => {
      if (i > 0) expect(entry.role).not.toBe(history[i - 1].role)
    })
    expect(history.length).toBeLessThanOrEqual(MAX_INTERVIEW_HISTORY_ENTRIES)
  })
})
