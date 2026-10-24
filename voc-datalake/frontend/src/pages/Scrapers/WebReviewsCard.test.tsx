/**
 * A web_reviews target on the Scrapers page: one `AppConfigCard` per review page,
 * named by its URL, with pages (not reviews) per run, and a run that reports the
 * sites that blocked the browser ("<target>: blocked by <vendor>") instead of a
 * silent zero.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppConfigCard } from './AppConfigComponents'
import { getAppIdentifier, supportsAppConfigs } from './scraper-helpers'
import type { RunStatusInfo } from './AppConfigComponents'
import type { PluginManifest } from '../../plugins/types'

const plugin: PluginManifest = {
  id: 'web_reviews',
  name: 'Web Reviews',
  icon: 'Web',
  description: 'Read customer reviews from public review pages',
  config: [],
  enabled: true,
  hasIngestor: true,
  hasWebhook: false,
  hasS3Trigger: false,
}

const PAGE_URL = 'https://www.trustpilot.com/review/acme.example'
const target = { id: 'w1', app_name: 'Trustpilot - Acme', url: PAGE_URL, max_pages: '7', frequency_minutes: '0' }

function renderCard(app: Record<string, string>, runStatus?: RunStatusInfo) {
  return render(
    <AppConfigCard app={app} plugin={plugin} isAdmin onEdit={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} isRunning={false} runStatus={runStatus} />,
  )
}

describe('web_reviews targets', () => {
  it('are app-connector style and named by their URL', () => {
    expect(supportsAppConfigs('web_reviews')).toBe(true)
    expect(getAppIdentifier(target, 'web_reviews')).toBe(PAGE_URL)
  })

  it('show the page URL in full (wrapped, never cut), "Review page" (not "Platform: Web") and the pages per run', () => {
    renderCard(target)
    const url = screen.getByText(PAGE_URL)
    expect(url).not.toHaveClass('truncate')
    expect(screen.getByText('Review page')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('asks before a run, naming the site it contacts', async () => {
    renderCard(target)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Run now' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('This contacts trustpilot.com and adds any new reviews')
  })

  it('default to ten pages when the target does not say', () => {
    renderCard({ id: 'w2', app_name: 'Forum', url: PAGE_URL })
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.queryByText('Max Reviews')).not.toBeInTheDocument()
  })

  it('show "All" for max_pages 0 and the review limit when one is set', () => {
    renderCard({ ...target, max_pages: '0', max_reviews: '200' })
    expect(screen.getByText('All')).toBeInTheDocument()
    expect(screen.getByText('Max Reviews')).toBeInTheDocument()
    expect(screen.getByText('200')).toBeInTheDocument()
  })

  it('hide the review limit when it is 0 (no limit)', () => {
    renderCard({ ...target, max_reviews: '0' })
    expect(screen.queryByText('Max Reviews')).not.toBeInTheDocument()
  })

  it('show which sites blocked the run, and how many more did', () => {
    renderCard(target, {
      status: 'completed', items_found: 40,
      errors: ['Yelp: blocked by DataDome', 'ConsumerAffairs: blocked by HUMAN (PerimeterX)', 'Reddit: blocked by Reddit network security'],
    })
    expect(screen.getByText('Yelp: blocked by DataDome')).toBeInTheDocument()
    expect(screen.getByText('ConsumerAffairs: blocked by HUMAN (PerimeterX)')).toBeInTheDocument()
    expect(screen.queryByText('Reddit: blocked by Reddit network security')).not.toBeInTheDocument()
    expect(screen.getByText(/1 more error/)).toBeInTheDocument()
  })
})
