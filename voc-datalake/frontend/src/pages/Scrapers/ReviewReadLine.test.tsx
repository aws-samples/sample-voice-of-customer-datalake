/**
 * A review page's last run on its card: how the run read it (the run row's `reads`, reviewReads.ts), in words. For an
 * Automatic page the steps tried before the one that read it ("Browser blocked by Cloudflare → read via Bedrock web
 * index (11 reviews)"), the learned method it went straight to ("Known: …"), or the browser re-checked first; for a
 * page on one method that method; and when nothing read it, every step's outcome. AgentCore web search's reviews
 * carry an "Excerpts" badge.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AppConfigCard } from './AppConfigComponents'
import type { RunStatusInfo } from './AppConfigComponents'
import type { StepRead, TargetRead } from './reviewReads'
import type { PluginManifest } from '../../plugins/types'

const plugin: PluginManifest = {
  id: 'web_reviews', name: 'Web Reviews', icon: 'Web', config: [], enabled: true,
  hasIngestor: true, hasWebhook: false, hasS3Trigger: false,
}
const page = { id: 'p1', app_name: 'Reviews - Acme', url: 'https://www.reviews.example/acme' }

const BLOCKED: StepRead = { method: 'browser', outcome: 'blocked', vendor: 'Cloudflare', reviews: 0 }
const BEDROCK_READ: StepRead = { method: 'bedrock_web_search', outcome: 'readable', reviews: 11 }
const BEDROCK_FAILED: StepRead = { method: 'bedrock_web_search', outcome: 'error', reviews: 0 }
const SNIPPETS_EMPTY: StepRead = { method: 'agentcore_web_search', outcome: 'no_reviews', reviews: 0 }
const CASCADE: TargetRead = {
  target: 'Reviews - Acme', target_id: 'p1', method: 'auto', method_used: 'bedrock_web_search', reviews: 11,
  plan: 'cascade', known_method: null, learned_at: null, excerpt: false, steps: [BLOCKED, BEDROCK_READ],
}

function renderRun(read: TargetRead) {
  const runStatus: RunStatusInfo = { status: 'completed', items_found: read.reviews, errors: [], reads: [read] }
  render(<AppConfigCard app={page} plugin={plugin} isAdmin onEdit={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()}
    isRunning={false} runStatus={runStatus} />)
}

describe('an Automatic page', () => {
  it('says what failed before the step that read it', () => {
    renderRun(CASCADE)
    expect(screen.getByText('Browser blocked by Cloudflare → read via Bedrock web index (11 reviews)')).toBeInTheDocument()
  })

  it('says it went straight to the method this workspace learned, and when it was learned', () => {
    renderRun({ ...CASCADE, plan: 'known', known_method: 'bedrock_web_search', learned_at: '2026-11-15T09:00:00Z', steps: [BEDROCK_READ] })
    expect(screen.getByText('Known: Bedrock web index (learned Nov 15, 2026) — 11 reviews')).toBeInTheDocument()
  })

  it('says when the learned method failed now and the chain went on', () => {
    renderRun({ ...CASCADE, plan: 'known', known_method: 'bedrock_web_search', learned_at: null, method_used: 'agentcore_web_search',
      reviews: 3, steps: [BEDROCK_FAILED, BLOCKED, { method: 'agentcore_web_search', outcome: 'readable', reviews: 3 }] })
    expect(screen.getByText('Known: Bedrock web index → Bedrock web index could not open the page → Browser blocked by Cloudflare → '
      + 'read via AgentCore web search (3 reviews)')).toBeInTheDocument()
  })

  it('says the browser was re-checked and still is blocked', () => {
    renderRun({ ...CASCADE, plan: 'reprobe', known_method: 'bedrock_web_search' })
    expect(screen.getByText('Re-checked the browser: still blocked by Cloudflare → read via Bedrock web index (11 reviews)'))
      .toBeInTheDocument()
  })

  it('says the browser was re-checked and reads the site again', () => {
    renderRun({ ...CASCADE, plan: 'reprobe', method_used: 'browser', reviews: 1,
      steps: [{ method: 'browser', outcome: 'readable', reviews: 1 }] })
    expect(screen.getByText('Re-checked the browser: it reads again (1 review)')).toBeInTheDocument()
  })

  it('says every outcome when no method read it', () => {
    renderRun({ ...CASCADE, method_used: null, reviews: 0, steps: [BLOCKED, BEDROCK_FAILED, SNIPPETS_EMPTY] })
    expect(screen.getByText('No method read it: Browser blocked by Cloudflare → Bedrock web index could not open the page → '
      + 'AgentCore web search found no review')).toBeInTheDocument()
  })

  it('names a step skipped for time, or not offered in the region', () => {
    renderRun({ ...CASCADE, method_used: null, reviews: 0, steps: [{ ...BLOCKED, vendor: undefined },
      { ...BEDROCK_FAILED, outcome: 'skipped_time' }, { ...SNIPPETS_EMPTY, outcome: 'not_offered' }] })
    expect(screen.getByText('No method read it: Browser blocked → Bedrock web index skipped: out of time → '
      + 'AgentCore web search not offered in this region')).toBeInTheDocument()
  })
})

describe('excerpts', () => {
  it('carry a badge saying they are search-result excerpts', () => {
    renderRun({ ...CASCADE, method_used: 'agentcore_web_search', reviews: 3, excerpt: true,
      steps: [BLOCKED, BEDROCK_FAILED, { method: 'agentcore_web_search', outcome: 'readable', reviews: 3 }] })
    expect(screen.getByText('Excerpts')).toHaveAccessibleDescription(/AgentCore web search result excerpts/)
  })

  it('the control: no badge for a page the browser or the Bedrock web index read', () => {
    renderRun(CASCADE)
    expect(screen.queryByText('Excerpts')).not.toBeInTheDocument()
  })
})

describe('a page on one method', () => {
  it('says the browser read it', () => {
    renderRun({ ...CASCADE, method: 'browser', plan: null, method_used: 'browser', reviews: 20,
      steps: [{ method: 'browser', outcome: 'readable', reviews: 20 }] })
    expect(screen.getByText('Read with the browser (20 reviews)')).toBeInTheDocument()
  })

  it('says the Bedrock web index read it', () => {
    renderRun({ ...CASCADE, method: 'bedrock_web_search', plan: null, steps: [BEDROCK_READ] })
    expect(screen.getByText('Read via Bedrock web index (11 reviews)')).toBeInTheDocument()
  })

  it('says why it was not read', () => {
    renderRun({ ...CASCADE, method: 'browser', plan: null, method_used: null, reviews: 0, steps: [BLOCKED] })
    expect(screen.getByText('Not read: Browser blocked by Cloudflare')).toBeInTheDocument()
  })

  it('the control: says nothing of a run that tried no step', () => {
    renderRun({ ...CASCADE, method_used: null, reviews: 0, steps: [] })
    expect(screen.queryByText(/read via|Not read|No method/)).not.toBeInTheDocument()
  })
})
