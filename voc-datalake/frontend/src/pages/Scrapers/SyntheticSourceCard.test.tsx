/**
 * @fileoverview Tests for SyntheticSourceCard (issue #146).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SyntheticSourceCard from './SyntheticSourceCard'
import { api } from '../../api/client'
import type { PluginManifest } from '../../plugins/types'

vi.mock('../../api/client', () => ({
  api: {
    getSourceRunStatus: vi.fn(),
  },
}))

const mockGetStatus = api.getSourceRunStatus as ReturnType<typeof vi.fn>

const plugin = {
  id: 'synthetic_reviews',
  name: 'Synthetic Data Review Generator',
  icon: '🧪',
  description: 'Generate realistic synthetic customer reviews with AI.',
  category: 'synthetic',
  enabled: true,
  hasIngestor: true,
  config: [],
} as unknown as PluginManifest

describe('SyntheticSourceCard', () => {
  beforeEach(() => {
    mockGetStatus.mockReset()
  })

  it('renders the plugin name and description', async () => {
    mockGetStatus.mockResolvedValue({ source: 'synthetic_reviews', status: 'never_run' })
    render(<SyntheticSourceCard plugin={plugin} onGenerate={vi.fn()} />)

    expect(screen.getByText('Synthetic Data Review Generator')).toBeInTheDocument()
    expect(await screen.findByText(/not run yet/i)).toBeInTheDocument()
  })

  it('shows the never-run hint when there is no run history', async () => {
    mockGetStatus.mockResolvedValue({ source: 'synthetic_reviews', status: 'never_run' })
    render(<SyntheticSourceCard plugin={plugin} onGenerate={vi.fn()} />)

    expect(await screen.findByText(/not run yet/i)).toBeInTheDocument()
    expect(screen.queryByText(/last run:/i)).not.toBeInTheDocument()
  })

  it('shows items generated, date, and a success badge for a completed run', async () => {
    mockGetStatus.mockResolvedValue({
      source: 'synthetic_reviews',
      status: 'completed',
      started_at: '2026-07-16T10:00:00Z',
      completed_at: '2026-07-16T10:01:00Z',
      items_found: 5,
      errors: [],
    })
    render(<SyntheticSourceCard plugin={plugin} onGenerate={vi.fn()} />)

    const expectedDate = new Date('2026-07-16T10:01:00Z').toLocaleDateString()
    expect(await screen.findByText(new RegExp(`5 items generated on ${expectedDate.replace(/[/\\]/g, '\\$&')}`)))
      .toBeInTheDocument()
    expect(screen.getByText('✓')).toBeInTheDocument()
  })

  it('shows a failure badge and the first error for an errored run', async () => {
    mockGetStatus.mockResolvedValue({
      source: 'synthetic_reviews',
      status: 'error',
      started_at: '2026-07-16T10:00:00Z',
      items_found: 0,
      errors: ['Bedrock throttled'],
    })
    render(<SyntheticSourceCard plugin={plugin} onGenerate={vi.fn()} />)

    expect(await screen.findByText('✗')).toBeInTheDocument()
    expect(screen.getByText('Bedrock throttled')).toBeInTheDocument()
  })

  it('calls onGenerate when the Generate button is clicked', async () => {
    mockGetStatus.mockResolvedValue({ source: 'synthetic_reviews', status: 'never_run' })
    const onGenerate = vi.fn()
    const user = userEvent.setup()
    render(<SyntheticSourceCard plugin={plugin} onGenerate={onGenerate} />)

    await user.click(screen.getByRole('button', { name: /generate/i }))

    expect(onGenerate).toHaveBeenCalledTimes(1)
  })

  it('re-fetches status when refreshToken changes (modal close)', async () => {
    mockGetStatus.mockResolvedValue({ source: 'synthetic_reviews', status: 'never_run' })
    const { rerender } = render(
      <SyntheticSourceCard plugin={plugin} onGenerate={vi.fn()} refreshToken={0} />
    )
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(1))

    mockGetStatus.mockResolvedValue({
      source: 'synthetic_reviews',
      status: 'completed',
      completed_at: '2026-07-17T09:00:00Z',
      items_found: 3,
      errors: [],
    })
    rerender(<SyntheticSourceCard plugin={plugin} onGenerate={vi.fn()} refreshToken={1} />)

    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/3 items generated/i)).toBeInTheDocument()
  })

  it('stays render-safe when the status call fails', async () => {
    mockGetStatus.mockRejectedValue(new Error('boom'))
    render(<SyntheticSourceCard plugin={plugin} onGenerate={vi.fn()} />)

    expect(screen.getByText('Synthetic Data Review Generator')).toBeInTheDocument()
    expect(await screen.findByText(/not run yet/i)).toBeInTheDocument()
  })
})
