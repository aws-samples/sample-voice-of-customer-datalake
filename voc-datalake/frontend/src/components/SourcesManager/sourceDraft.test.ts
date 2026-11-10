/** knownSourceIds: the source ids reviews really carry (docs/source-policies.md). */
import { describe, expect, it } from 'vitest'
import { knownSourceIds } from './sourceDraft'

describe('knownSourceIds', () => {
  it('lists plugins, the platform sources and valid scraper names, never the webscraper plugin id', () => {
    expect(knownSourceIds(['webscraper', 'github_issues'], ['trustpilot_reviews', 'Shop Reviews', 'www.example.com']))
      .toStrictEqual(['github_issues', 'trustpilot_reviews', 'feedback_form', 'manual_import'])
  })

  it('works without scrapers', () => {
    expect(knownSourceIds(['webscraper'])).toStrictEqual(['feedback_form', 'manual_import'])
  })
})
