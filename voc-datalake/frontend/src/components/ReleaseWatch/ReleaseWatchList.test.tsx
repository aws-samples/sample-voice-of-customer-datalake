import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { render } from '../../test/test-utils'
import ReleaseWatchList from './ReleaseWatchList'
import { normalizeReleaseWatch } from '../../api/releaseWatchSchema'

const side = (count: number, negative: number, sentiment: number | null) => ({
  days: 14, count, scored: count, avg_sentiment: sentiment, negative, top_categories: [],
})

const { releases } = normalizeReleaseWatch({
  releases: [
    {
      key: 'github:2.4.0', label: '2.4.0', kind: 'github_release', date: '2026-10-10', before: side(30, 6, 0.24),
      after: side(34, 14, -0.05), deltas: {},
      complaint_deltas: [{ name: 'app_store', before: 3, after: 10 }, { name: 'other', before: 1, after: 1 }],
      regression: true, reasons: ['sentiment_drop'], feedback_ids: ['fb_1', 'fb_2', 'fb_3', 'fb_4'],
      evidence: [{ feedback_id: 'fb_1', title: 'App crashes on login' }, { feedback_id: 'fb_2', title: '' },
        { feedback_id: 'fb_3', title: 'Charged twice' }, { feedback_id: 'fb_4', title: 'Slow' }],
    },
    {
      key: 'github:2.3.1', label: '2.3.1', kind: 'github_release', date: '2026-09-10', before: side(10, 1, null),
      after: side(11, 1, 0.3), deltas: {}, complaint_deltas: [], regression: false, reasons: [], feedback_ids: ['fb_9'],
    },
  ],
})

describe('ReleaseWatchList', () => {
  it('flags a regression with its reason and shows healthy releases as such', () => {
    render(<ReleaseWatchList releases={releases} />)
    expect(screen.getByText('Regression')).toHaveAttribute('title', 'Sentiment dropped')
    expect(screen.getByText('No regression')).toBeInTheDocument()
  })

  it('lists only complaints that grew (never "Other (1 → 1)") and links at most three evidence items', () => {
    render(<ReleaseWatchList releases={releases} />)
    expect(screen.getByText(/App store \(3 → 10\)/)).toBeInTheDocument()
    expect(screen.queryByText(/Other \(1 → 1\)/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toStrictEqual(['/?review=fb_1', '/?review=fb_2', '/?review=fb_3', '/?review=fb_9'])
  })

  it('labels evidence links by the review title, numbering only what has none', () => {
    render(<ReleaseWatchList releases={releases} />)
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toStrictEqual(['App crashes on login', 'Review 2', 'Charged twice', 'Review 1'])
  })

  it('shows a missing sentiment as a dash', () => {
    render(<ReleaseWatchList releases={releases} />)
    expect(screen.getAllByText('–')).toHaveLength(1)
  })

  it('says when there is no release', () => {
    render(<ReleaseWatchList releases={[]} />)
    expect(screen.getByText('No release in this period.')).toBeInTheDocument()
  })
})

describe('ReleaseWatchList numbers', () => {
  it('groups large volumes and complaint counts in the app language', () => {
    const { releases: big } = normalizeReleaseWatch({
      releases: [{
        key: 'github:3.0.0', label: '3.0.0', kind: 'github_release', date: '2026-11-01', before: side(26622, 1200, 0.1),
        after: side(30001, 4500, -0.2), deltas: {}, complaint_deltas: [{ name: 'app_store', before: 1200, after: 3400 }],
        regression: true, reasons: ['sentiment_drop'], feedback_ids: [],
      }],
    })
    render(<ReleaseWatchList releases={big} />)
    expect(screen.getByText('26,622')).toBeInTheDocument()
    expect(screen.getByText('4,500')).toBeInTheDocument()
    expect(screen.getByText(/App store \(1,200 → 3,400\)/)).toBeInTheDocument()
  })
})

