import { describe, it, expect } from 'vitest'
import { withOwnedParams } from './searchParams'

describe('withOwnedParams', () => {
  it('keeps params the caller does not own (the review modal survives a filter write-back)', () => {
    const current = new URLSearchParams('q=old&review=fb_1&reviewBrand=example-air')
    const merged = withOwnedParams(current, ['q', 'source'], new URLSearchParams('source=web'))
    expect(merged.get('review')).toBe('fb_1')
    expect(merged.get('reviewBrand')).toBe('example-air')
  })

  it('replaces owned keys and drops the ones the next state omits', () => {
    const merged = withOwnedParams(new URLSearchParams('q=old&source=a'), ['q', 'source'], new URLSearchParams('q=new'))
    expect(merged.toString()).toBe('q=new')
  })
})
