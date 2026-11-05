/**
 * @fileoverview The wizards' live "N reviews match" line (ported from #429 by @aws-bryan):
 * the estimate shows first, the exact count replaces it, and the "confirming" note stops once
 * the exact request settles, readable or not (6039aecb).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { createWizardWrapper } from './wizard-fixtures'
import { defaultContextConfig } from '../../components/DataSourceWizard/types'
import FeedbackMatchPreview from './FeedbackMatchPreview'
import type { FeedbackPreview, FeedbackPreviewMode } from '../../api/feedbackPreviewSchema'

const previewFeedback = vi.hoisted(() => vi.fn())
vi.mock('../../api/projectsApi', () => ({ projectsApi: { previewFeedback } }))

const answer = (fields: Partial<FeedbackPreview>): FeedbackPreview => ({
  matched: 0, matched_is_lower_bound: false, sample_limit: 145, estimated: false, ...fields,
})

/** Answer each mode with its own promise, resolved when the test says so. */
function deferredModes() {
  const resolvers: Partial<Record<FeedbackPreviewMode, (value: FeedbackPreview) => void>> = {}
  const rejecters: Partial<Record<FeedbackPreviewMode, (error: Error) => void>> = {}
  previewFeedback.mockImplementation((_id: string, _body: unknown, mode: FeedbackPreviewMode) => new Promise((resolve, reject) => {
    resolvers[mode] = resolve
    rejecters[mode] = reject
  }))
  return { resolvers, rejecters }
}

function renderPreview(purpose: 'personas' | 'research' = 'personas') {
  return render(
    <FeedbackMatchPreview projectId="proj-1" contextConfig={defaultContextConfig} purpose={purpose} />,
    { wrapper: createWizardWrapper() },
  )
}

describe('FeedbackMatchPreview', () => {
  beforeEach(() => { previewFeedback.mockReset() })

  it('asks for both modes with the generation filters and the purpose', async () => {
    previewFeedback.mockResolvedValue(answer({ matched: 3 }))
    renderPreview('research')
    await waitFor(() => expect(previewFeedback).toHaveBeenCalledTimes(2))
    const body = { sources: [], categories: [], sentiments: [], days: 30 }
    expect(previewFeedback).toHaveBeenCalledWith('proj-1', body, 'exact', 'research')
    expect(previewFeedback).toHaveBeenCalledWith('proj-1', body, 'estimate', 'research')
  })

  it('counts, then shows the estimate while it confirms', async () => {
    const { resolvers } = deferredModes()
    renderPreview()
    expect(screen.getByText('Counting matching reviews…')).toBeInTheDocument()
    await waitFor(() => expect(resolvers.estimate).toBeDefined())
    resolvers.estimate?.(answer({ matched: 1200, estimated: true }))
    expect(await screen.findByText('About 1,200 reviews match')).toBeInTheDocument()
    expect(screen.getByText('Confirming the exact count…')).toBeInTheDocument()
  })

  it('swaps in the exact count and its sample note', async () => {
    const { resolvers } = deferredModes()
    renderPreview()
    await waitFor(() => expect(resolvers.exact).toBeDefined())
    resolvers.estimate?.(answer({ matched: 1200, estimated: true }))
    resolvers.exact?.(answer({ matched: 1234 }))
    expect(await screen.findByText('1,234 reviews match')).toBeInTheDocument()
    expect(screen.getByText(/an even sample of 145 of them/)).toBeInTheDocument()
    expect(screen.queryByText('Confirming the exact count…')).not.toBeInTheDocument()
  })

  it('stops confirming when the exact answer comes back unreadable', async () => {
    const { resolvers } = deferredModes()
    renderPreview()
    await waitFor(() => expect(resolvers.estimate).toBeDefined())
    resolvers.estimate?.(answer({ matched: 900, estimated: true }))
    expect(await screen.findByText('Confirming the exact count…')).toBeInTheDocument()
    resolvers.exact?.(answer({ matched: null }))
    await waitFor(() => expect(screen.queryByText('Confirming the exact count…')).not.toBeInTheDocument())
    expect(screen.getByText('About 900 reviews match')).toBeInTheDocument()
  })

  it('stops confirming when the exact request fails', async () => {
    const { resolvers, rejecters } = deferredModes()
    renderPreview()
    await waitFor(() => expect(rejecters.exact).toBeDefined())
    resolvers.estimate?.(answer({ matched: 900, estimated: true }))
    rejecters.exact?.(new Error('API Error: 502'))
    await waitFor(() => expect(screen.queryByText('Confirming the exact count…')).not.toBeInTheDocument())
  })

  it('warns when nothing matches', async () => {
    previewFeedback.mockResolvedValue(answer({ matched: 0 }))
    renderPreview()
    expect(await screen.findByText(/No reviews match these filters/)).toBeInTheDocument()
  })

  it('says the personas read every match when they fit, and nothing about sampling for research', async () => {
    previewFeedback.mockResolvedValue(answer({ matched: 12 }))
    const { unmount } = renderPreview()
    expect(await screen.findByText('Persona generation reads all of them.')).toBeInTheDocument()
    unmount()
    previewFeedback.mockResolvedValue(answer({ matched: 12, sample_limit: null }))
    renderPreview('research')
    expect(await screen.findByText('12 reviews match')).toBeInTheDocument()
    expect(screen.queryByText(/Persona generation/)).not.toBeInTheDocument()
  })

  it('says "at least" for a read cut by its time budget', async () => {
    previewFeedback.mockResolvedValue(answer({ matched: 5000, matched_is_lower_bound: true }))
    renderPreview()
    expect(await screen.findByText('At least 5,000 reviews match')).toBeInTheDocument()
  })

  it('shows the error line when no answer could be read', async () => {
    previewFeedback.mockRejectedValue(new Error('API Error: 500'))
    renderPreview()
    expect(await screen.findByText('Could not count the matching reviews.')).toBeInTheDocument()
  })
})
