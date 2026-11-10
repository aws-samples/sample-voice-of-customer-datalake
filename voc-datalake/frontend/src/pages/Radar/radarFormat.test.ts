import { describe, expect, it } from 'vitest'
import { citationLabel, percent, uniqueCitations } from './radarFormat'

describe('citationLabel', () => {
  it('never repeats the host: a host-only title becomes the host and path', () => {
    expect(citationLabel('https://www.example-air.example/changelog/2026-06/', 'example-air.example')).toBe('example-air.example/changelog/2026-06')
    expect(citationLabel('https://example-air.example/', 'www.example-air.example')).toBe('example-air.example')
  })

  it('keeps a real title, adding the host once only when the title does not hold it', () => {
    expect(citationLabel('https://example-air.example/x', 'Coding sessions')).toBe('Coding sessions · example-air.example')
    expect(citationLabel('https://example-air.example/x', 'Coding sessions on example-air.example')).toBe('Coding sessions on example-air.example')
  })

  it('names an untitled citation by its host and path, never "host (host)"', () => {
    const [only] = uniqueCitations(['https://acme.example/news/'], [])
    expect(only === undefined ? '' : citationLabel(only.url, only.title)).toBe('acme.example/news')
  })
})

// verify5/V6 item 3: one percent spelling per locale.
describe('percent', () => {
  it('spells a share in the locale and is empty when unknown', () => {
    expect(percent(0.62)).toBe('62%')
    expect(percent(0.62, 'de')).toBe('62\u00a0%')
    expect(percent(null, 'de')).toBe('')
  })
})
