import { beforeEach, describe, expect, it } from 'vitest'
import { readPositions, useBubbleStore } from './bubbleStore'

function merge(persisted: unknown) {
  const fn = useBubbleStore.persist.getOptions().merge
  if (fn === undefined) throw new Error('merge is not configured')
  return fn(persisted, useBubbleStore.getState())
}

beforeEach(() => {
  useBubbleStore.setState({ positions: {} })
})

describe('bubbleStore', () => {
  it('stores and resets a position per user without touching the others', () => {
    const { setPosition, resetPosition } = useBubbleStore.getState()
    setPosition('a', { right: 40, bottom: 50 })
    setPosition('b', { right: 1, bottom: 2 })
    resetPosition('a')
    expect(useBubbleStore.getState().positions).toStrictEqual({ b: { right: 1, bottom: 2 } })
  })

  it('persists only the positions', () => {
    const partialize = useBubbleStore.persist.getOptions().partialize
    expect(partialize?.(useBubbleStore.getState())).toStrictEqual({ positions: {} })
  })

  it('drops tampered entries one by one and keeps the valid ones', () => {
    expect(readPositions({
      ok: { right: 10, bottom: 20 },
      text: { right: '10', bottom: 20 },
      infinite: { right: Infinity, bottom: 0 },
      missing: { right: 1 },
      nothing: null,
    })).toStrictEqual({ ok: { right: 10, bottom: 20 } })
    expect(readPositions('garbage')).toStrictEqual({})
  })

  it('ignores a persisted record without positions', () => {
    expect(merge(null).positions).toStrictEqual({})
    expect(merge({ other: 1 }).positions).toStrictEqual({})
    expect(merge({ positions: { u: { right: 5, bottom: 6 } } }).positions).toStrictEqual({ u: { right: 5, bottom: 6 } })
  })
})
