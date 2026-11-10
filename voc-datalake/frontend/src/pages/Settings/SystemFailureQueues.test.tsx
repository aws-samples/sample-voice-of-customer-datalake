/**
 * @fileoverview SystemFailureQueues: the "Failure queues" card lists only the
 * queues holding messages (depth, oldest age) and expands each to its redacted
 * sample bodies; all-empty and unreadable answers read differently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { normalizeSystemFailureQueues } from '../../api/systemDiagnostics'
import SystemFailureQueues from './SystemFailureQueues'

const mockGetQueues = vi.fn<() => Promise<unknown>>()
vi.mock('../../api/client', () => ({
  api: { getSystemFailureQueues: () => mockGetQueues().then(normalizeSystemFailureQueues) },
}))

const SAMPLE = '{"id":"rev_9f2c","text":"[REDACTED:EMAIL] says checkout times out"}'

describe('SystemFailureQueues', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists the queues holding messages with their count and oldest age, and expands to the samples', async () => {
    const user = userEvent.setup()
    mockGetQueues.mockResolvedValue({ queues: [
      { name: 'voc-processing-dlq', messages: 2, oldest_age_seconds: 3 * 3600 + 60, sample: [SAMPLE] },
      { name: 'voc-agent-run-failures', messages: 0, sample: [] },
    ] })
    renderWithQueryClient(<SystemFailureQueues />)

    const row = await screen.findByRole('button', { name: /voc-processing-dlq/ })
    expect(['voc-agent-run-failures', 'oldest 3h ago'].map((text) => screen.queryByText(text) !== null))
      .toStrictEqual([false, true])
    expect(screen.getByText('2 messages')).toHaveClass('badge-danger')

    await user.click(row)

    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect([SAMPLE, /Reading a sample does not remove it/].map((text) => screen.queryByText(text) !== null))
      .toStrictEqual([true, true])
  })

  it('shows a queue the route could not read, so the card never claims every queue is empty', async () => {
    mockGetQueues.mockResolvedValue({ queues: [
      { name: 'voc-processing-dlq', messages: 0, sample: [] },
      { name: 'voc-briefing-dlq', messages: null, sample: [], error: 'The queue could not be read.' },
    ] })
    renderWithQueryClient(<SystemFailureQueues />)

    expect(await screen.findByText('Could not be read')).toHaveClass('badge-warn')
    expect([screen.getByText('voc-briefing-dlq'), screen.queryByText('voc-processing-dlq'), screen.queryByText(/failure queues are empty/i)]
      .map((el) => el !== null)).toStrictEqual([true, false, false])
  })

  it('says every queue is empty when none holds a message', async () => {
    mockGetQueues.mockResolvedValue({ queues: [
      { name: 'voc-processing-dlq', messages: 0, sample: [] },
      { name: 'voc-memory-extract-dlq', messages: 0, sample: [] },
    ] })
    renderWithQueryClient(<SystemFailureQueues />)

    expect(await screen.findByText('All 2 failure queues are empty')).toBeInTheDocument()
  })

  it('shows a load error for an answer without a queue list, never "empty"', async () => {
    mockGetQueues.mockResolvedValue({ unexpected: true })
    renderWithQueryClient(<SystemFailureQueues />)

    expect(await screen.findByRole('alert')).toHaveTextContent('The failure queues could not be read.')
    expect(screen.queryByText(/are empty/)).toBeNull()
  })

  it('says when a queue had no readable sample', async () => {
    const user = userEvent.setup()
    mockGetQueues.mockResolvedValue({ queues: [{ name: 'voc-memory-extract-dlq', messages: 1, sample: [] }] })
    renderWithQueryClient(<SystemFailureQueues />)

    await user.click(await screen.findByRole('button', { name: /voc-memory-extract-dlq/ }))

    expect(screen.getByText('1 message')).toBeInTheDocument()
    expect(screen.getByText('No message could be read for a sample.')).toBeInTheDocument()
  })
})
