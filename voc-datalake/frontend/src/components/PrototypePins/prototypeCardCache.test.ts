/**
 * The validation card a framed prototype asks its host for (7.68.00, prototypeCardCache.ts): asked once per form for
 * the page session (the public submit route's throttle is every form's), a form's "asks none" refusal kept like a
 * card, any other failure asked again, and every answer forgotten once the card is saved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/errors'
import { cachedCard, forgetPrototypeCards } from './prototypeCardCache'

const MINUTE = 60_000
const CARD = { success: true, card: { revision: 2 } }

describe('the card a framed prototype asks for', () => {
  beforeEach(forgetPrototypeCards)

  it('is asked once per form for five minutes', async () => {
    const ask = vi.fn(() => Promise.resolve(CARD))
    expect(await cachedCard('pf_a', ask, 0)).toBe(CARD)
    expect(await cachedCard('pf_a', ask, 4 * MINUTE)).toBe(CARD)
    expect(ask).toHaveBeenCalledTimes(1)
    await cachedCard('pf_b', ask, 4 * MINUTE)
    await cachedCard('pf_a', ask, 5 * MINUTE)
    expect(ask).toHaveBeenCalledTimes(3)
  })

  it("keeps a form's refusal: it asks no questions", async () => {
    const refused = vi.fn(() => Promise.reject(new ApiError(400, 'This prototype asks no validation questions')))
    await expect(cachedCard('pf_a', refused, 0)).rejects.toThrow('asks no validation questions')
    await expect(cachedCard('pf_a', refused, MINUTE)).rejects.toThrow('asks no validation questions')
    expect(refused).toHaveBeenCalledTimes(1)
  })

  it('asks again after any other failure', async () => {
    const throttled = vi.fn(() => Promise.reject(new ApiError(429, 'Too many requests')))
    await expect(cachedCard('pf_b', throttled, 0)).rejects.toThrow('Too many requests')
    await expect(cachedCard('pf_b', throttled, MINUTE)).rejects.toThrow('Too many requests')
    expect(throttled).toHaveBeenCalledTimes(2)
  })

  it('is asked again once the card was saved', async () => {
    const ask = vi.fn(() => Promise.resolve(CARD))
    await cachedCard('pf_a', ask, 0)
    forgetPrototypeCards()
    await cachedCard('pf_a', ask, MINUTE)
    expect(ask).toHaveBeenCalledTimes(2)
  })
})
