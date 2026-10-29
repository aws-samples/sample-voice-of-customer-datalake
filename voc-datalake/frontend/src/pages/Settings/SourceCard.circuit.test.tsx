/**
 * @fileoverview SourceCard's "Paused after repeated failures" notice: a tripped
 * plugin circuit breaker, its Reset action, and enable closing it too.
 * @module pages/Settings/SourceCard.circuit.test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import SourceCard from './SourceCard'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import type { PluginManifest } from '../../plugins/types'

const mockGetSourcesStatus = vi.fn<(...args: unknown[]) => unknown>()
const mockEnableSource = vi.fn<(source: string) => unknown>()
const mockResetSource = vi.fn<(source: string) => unknown>()

vi.mock('../../api/client', () => ({
  api: {
    getIntegrationStatus: () => Promise.resolve({}),
    getSourcesStatus: () => mockGetSourcesStatus(),
    enableSource: (source: string) => mockEnableSource(source),
    disableSource: () => Promise.resolve({ success: true, enabled: false }),
    resetSource: (source: string) => mockResetSource(source),
    updateIntegrationCredentials: vi.fn(),
    testIntegration: vi.fn(),
  },
}))

vi.mock('../../components/S3ImportExplorer/S3ImportExplorer', () => ({ default: () => null }))

const manifest: PluginManifest = {
  id: 'app_reviews_android',
  name: 'Android Reviews',
  icon: 'Android',
  enabled: true,
  description: 'Play Store reviews',
  config: [],
  hasIngestor: true,
  hasWebhook: false,
  hasS3Trigger: false,
}

const CLOSED = { tripped: false, tripped_at: null, failure_count: 0, last_error: null }
const TRIPPED = {
  tripped: true,
  tripped_at: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
  failure_count: 5,
  last_error: 'HTTPError: 429 Too Many Requests',
}

function statusWith(circuit: object) {
  return { sources: { app_reviews_android: { enabled: false, exists: true, circuit } } }
}

function renderCard(isAdmin = true) {
  return renderWithQueryClient(<SourceCard manifest={manifest} apiEndpoint="https://api.example.com" isAdmin={isAdmin} />)
}

/** Renders the card for an admin and clicks Reset once it shows. */
async function renderAndReset() {
  const user = userEvent.setup()
  renderCard()
  await user.click(await screen.findByRole('button', { name: 'Reset' }))
}

/** Renders the paused card for an admin and turns the source on. */
async function renderAndEnable() {
  const user = userEvent.setup()
  renderCard()
  await screen.findByText('Paused after repeated failures')
  await user.click(screen.getByRole('checkbox', { name: /Android App Reviews Disabled/i }))
}

describe('SourceCard circuit breaker notice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSourcesStatus.mockResolvedValue(statusWith(TRIPPED))
  })

  it('shows a tripped source as paused, with when, how many failures and the reason', async () => {
    renderCard()

    expect(await screen.findByText('Paused after repeated failures')).toBeInTheDocument()
    expect(screen.getByText('Paused 42m ago', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Failed runs: 5')).toBeInTheDocument()
    expect(screen.getByText('Last error: HTTPError: 429 Too Many Requests')).toBeInTheDocument()
  })

  it('says that turning the source on again also resets it', async () => {
    renderCard()

    expect(await screen.findByText('Turning this source on again also resets it.')).toBeInTheDocument()
  })

  it('shows nothing for a closed circuit', async () => {
    mockGetSourcesStatus.mockResolvedValue(statusWith(CLOSED))
    renderCard()

    await waitFor(() => expect(mockGetSourcesStatus).toHaveBeenCalledWith())
    expect(screen.queryByText('Paused after repeated failures')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument()
  })

  it('omits the reason line when the server withheld the error (non-admin)', async () => {
    mockGetSourcesStatus.mockResolvedValue(statusWith({ ...TRIPPED, last_error: null }))
    renderCard(false)

    expect(await screen.findByText('Paused after repeated failures')).toBeInTheDocument()
    expect(screen.queryByText(/Last error/)).not.toBeInTheDocument()
  })

  it('cuts a long reason to one short line and keeps the full text as its title', async () => {
    const long = `ValueError: ${'x'.repeat(400)}\nTraceback line`
    mockGetSourcesStatus.mockResolvedValue(statusWith({ ...TRIPPED, last_error: long }))
    renderCard()

    const reason = await screen.findByText(/^Last error:/)
    expect(reason.textContent.length).toBeLessThan(200)
    expect(reason.textContent).not.toContain('Traceback')
    expect(reason).toHaveAttribute('title', long)
  })

  it('Reset closes the breaker without enabling the schedule', async () => {
    mockResetSource.mockResolvedValue({ success: true, source: 'app_reviews_android', enabled: false, circuit: CLOSED })
    await renderAndReset()

    expect(mockResetSource).toHaveBeenCalledWith('app_reviews_android')
    expect(mockEnableSource).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Paused after repeated failures')).not.toBeInTheDocument())
    expect(screen.getByRole('checkbox', { name: /Android App Reviews Disabled/i })).not.toBeChecked()
  })

  it('a failed reset keeps the notice and says so', async () => {
    mockResetSource.mockRejectedValue(new Error('500'))
    await renderAndReset()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reset this source. Try again.')
    expect(screen.getByText('Paused after repeated failures')).toBeInTheDocument()
  })

  it('an unsuccessful reset answer is also reported as a failure', async () => {
    mockResetSource.mockResolvedValue({ success: false, source: '', enabled: false, circuit: CLOSED })
    await renderAndReset()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('Reset is disabled for a non-admin, with the admin-only explanation', async () => {
    renderCard(false)

    const reset = await screen.findByRole('button', { name: 'Reset' })
    expect(reset).toBeDisabled()
    expect(reset).toHaveAttribute('title', ADMIN_ONLY_TITLE)
  })

  it('enabling the source also clears the notice', async () => {
    mockEnableSource.mockResolvedValue({ success: true, source: 'app_reviews_android', enabled: true })
    await renderAndEnable()

    expect(mockEnableSource).toHaveBeenCalledWith('app_reviews_android')
    await waitFor(() => expect(screen.queryByText('Paused after repeated failures')).not.toBeInTheDocument())
    expect(mockResetSource).not.toHaveBeenCalled()
  })

  it('a failed enable leaves the notice in place', async () => {
    mockEnableSource.mockRejectedValue(new Error('500'))
    await renderAndEnable()

    await waitFor(() => expect(mockEnableSource).toHaveBeenCalledWith('app_reviews_android'))
    expect(screen.getByText('Paused after repeated failures')).toBeInTheDocument()
  })
})
