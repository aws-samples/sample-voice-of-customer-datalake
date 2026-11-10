/**
 * Feedback-board requests behind a persona or document: their ids read from the artefact,
 * `[FR:<id>]` citations linked to the request, and the corpus line counting them apart from reviews.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import FeedbackCorpus from './FeedbackCorpus'
import { featureRequestHref, featureRequestIdsOf, linkFeatureRequestCitations } from './featureRequestCitations'

describe('featureRequestIdsOf', () => {
  it('reads a persona or research report’s own list', () => {
    expect(featureRequestIdsOf({ input_feature_request_ids: ['fr_1', 'fr_2', 'fr_1', ''] })).toStrictEqual(['fr_1', 'fr_2'])
  })

  it('reads a PRD / PR/FAQ’s derivation', () => {
    expect(featureRequestIdsOf({ derivation: { input_feature_request_ids: ['fr_3'] } })).toStrictEqual(['fr_3'])
  })

  it.each([[undefined], [null], ['x'], [{ input_feature_request_ids: 'fr_1', derivation: 'junk' }]])(
    'reads %j as none', (artefact) => {
      expect(featureRequestIdsOf(artefact)).toStrictEqual([])
    })

  it('keeps at most 200', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `fr_${i}`)
    expect(featureRequestIdsOf({ input_feature_request_ids: ids })).toHaveLength(200)
  })
})

describe('linkFeatureRequestCitations', () => {
  it('links each citation to its request, the visible text unchanged', () => {
    expect(linkFeatureRequestCitations('Admins need SSO [FR:fr_00a1].'))
      .toBe(String.raw`Admins need SSO [\[FR:fr_00a1\]](/feature-requests?request=fr_00a1).`)
  })

  it('leaves review citations, an already linked citation and malformed ids alone', () => {
    const text = '[R:abc] [FR:fr_1](/x) [FR:has space]'
    expect(linkFeatureRequestCitations(text)).toBe(text)
  })

  it('opens the request on its board', () => {
    expect(featureRequestHref('fr_1')).toBe('/feature-requests?request=fr_1')
  })
})

function renderCorpus(feedbackIds: string[] | undefined, featureRequestIds: string[]) {
  render(<MemoryRouter><FeedbackCorpus feedbackIds={feedbackIds} featureRequestIds={featureRequestIds} /></MemoryRouter>)
}

describe('the corpus line', () => {
  it('counts the requests beside the reviews', () => {
    renderCorpus(['r1', 'r2'], ['fr_1'])
    expect(screen.getByTestId('feedback-corpus')).toHaveTextContent('Written from 2 reviews')
    expect(screen.getByTestId('feature-request-corpus')).toHaveTextContent('and 1 feature request')
  })

  it('says it was written from requests alone when it read no review', () => {
    renderCorpus(undefined, ['fr_1', 'fr_2'])
    expect(screen.getByTestId('feature-request-corpus')).toHaveTextContent('Written from 2 feature requests')
    expect(screen.queryByRole('button', { name: 'Show reviews' })).not.toBeInTheDocument()
  })

  it('lists the requests as links once asked', async () => {
    const user = userEvent.setup()
    renderCorpus(['r1'], ['fr_1'])
    await user.click(screen.getByRole('button', { name: 'Show requests' }))
    expect(screen.getByRole('link', { name: 'Request fr_1' })).toHaveAttribute('href', '/feature-requests?request=fr_1')
  })

  it('shows nothing without reviews or requests', () => {
    renderCorpus(undefined, [])
    expect(screen.queryByTestId('feedback-corpus')).not.toBeInTheDocument()
  })
})
