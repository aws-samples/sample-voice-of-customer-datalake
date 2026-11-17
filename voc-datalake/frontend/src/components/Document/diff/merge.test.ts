/**
 * Compare and merge (D6-4): the latest version's changes over the base, block by block, judged against the draft by
 * Revise's exactly-once rule; taking them leaves every other edit of the draft as it was.
 */
import { describe, expect, it } from 'vitest'
import { applyOnce, mergeChanges, occursOnce, takeChanges } from './merge'

const BASE = ['# Plan', 'Ship on Monday.', 'Budget: 10k.', 'Owner: Sam.'].join('\n\n')

describe('the exactly-once rule', () => {
  it('finds a passage only when it occurs at exactly one place, overlapping places counted', () => {
    expect([occursOnce('abc', 'b'), occursOnce('aaa', 'aa'), occursOnce('abc', ''), occursOnce('abc', 'x')])
      .toStrictEqual([true, false, false, false])
  })

  it('replaces that one place, and nothing when it is not exactly once', () => {
    expect([applyOnce('a b c', { before: 'b', after: 'B' }), applyOnce('b b', { before: 'b', after: 'B' })]).toStrictEqual(['a B c', null])
  })
})

describe('mergeChanges', () => {
  it('offers a change of theirs that the draft did not touch, and takes it over the draft\'s own edit', () => {
    const theirs = BASE.replace('Ship on Monday.', 'Ship on Tuesday.')
    const mine = BASE.replace('Owner: Sam.', 'Owner: Alex.')
    const changes = mergeChanges(BASE, theirs, mine)

    expect(changes?.map((change) => change.status)).toStrictEqual(['applies'])
    expect(takeChanges(mine, changes ?? []).text).toBe(theirs.replace('Owner: Sam.', 'Owner: Alex.'))
  })

  it('marks a change the draft already made the same way, and one it changed otherwise as a conflict', () => {
    const theirs = BASE.replace('Ship on Monday.', 'Ship on Tuesday.').replace('Owner: Sam.', 'Owner: Kim.')
    const mine = BASE.replace('Ship on Monday.', 'Ship on Tuesday.').replace('Owner: Sam.', 'Owner: Alex.')

    expect(mergeChanges(BASE, theirs, mine)?.map((change) => change.status)).toStrictEqual(['already', 'conflict'])
  })

  it('anchors an added block on its neighbour, so the blank lines around it stay right', () => {
    const theirs = BASE.replace('Budget: 10k.', 'Budget: 10k.\n\nRisks: none.')
    const changes = mergeChanges(BASE, theirs, BASE) ?? []

    expect(changes.map(({ before, after }) => ({ before, after }))).toStrictEqual([{ before: 'Budget: 10k.', after: 'Budget: 10k.\n\nRisks: none.' }])
    expect(takeChanges(BASE, changes).text).toBe(theirs)
  })

  it('takes a removed block out with its gap', () => {
    const theirs = BASE.replace('Budget: 10k.\n\n', '')

    expect(takeChanges(BASE, mergeChanges(BASE, theirs, BASE) ?? []).text).toBe(theirs)
  })

  it('takes only the changes that still apply, and says which', () => {
    const theirs = BASE.replace('Ship on Monday.', 'Ship on Tuesday.').replace('Owner: Sam.', 'Owner: Kim.')
    const mine = BASE.replace('Owner: Sam.', 'Owner: Alex.')
    const changes = mergeChanges(BASE, theirs, mine) ?? []

    expect(takeChanges(mine, changes).taken).toStrictEqual([changes[0]?.id])
  })
})
