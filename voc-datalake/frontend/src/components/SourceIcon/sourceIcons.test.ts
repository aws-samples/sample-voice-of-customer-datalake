import { describe, it, expect } from 'vitest'
import { CircleDot, FlaskConical, Globe, MessageSquare, Package, PenLine, Plug, Smartphone } from 'lucide-react'
import { manifestIcon, sourceIcon } from './sourceIcons'

describe('sourceIcon', () => {
  it.each([
    ['webscraper', Globe],
    ['web_scrape_jsonld', Globe],
    ['manual_import', PenLine],
    ['s3_import', Package],
    ['github_issues', CircleDot],
    ['app_reviews_ios', Smartphone],
    ['synthetic_reviews', FlaskConical],
  ])('maps the %s platform to its icon', (platform, icon) => {
    expect(sourceIcon(platform)).toBe(icon)
  })

  it('treats any scraper_* platform as a web source', () => {
    expect(sourceIcon('scraper_acme_reviews')).toBe(Globe)
  })

  it('falls back to the channel, then to a generic message icon', () => {
    expect(sourceIcon('unknown_platform', 's3_import')).toBe(Package)
    expect(sourceIcon('unknown_platform')).toBe(MessageSquare)
  })

  it('never answers an inherited object key', () => {
    expect(sourceIcon('constructor')).toBe(MessageSquare)
  })
})

describe('manifestIcon', () => {
  it.each([
    ['Web', Globe],
    ['iOS', Smartphone],
    ['Android', Smartphone],
    ['GitHub', CircleDot],
    ['Package', Package],
    ['Synthetic', FlaskConical],
    ['Plugin', Plug],
  ])('maps the %s manifest word to its icon', (word, icon) => {
    expect(manifestIcon(word)).toBe(icon)
  })

  it('falls back by category for an unknown word', () => {
    expect(manifestIcon('Satellite', 'import')).toBe(Package)
    expect(manifestIcon('Satellite', 'reviews')).toBe(Plug)
    expect(manifestIcon('toString')).toBe(Plug)
  })
})
