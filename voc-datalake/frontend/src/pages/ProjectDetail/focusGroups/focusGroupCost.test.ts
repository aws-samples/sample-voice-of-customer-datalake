import { describe, expect, it } from 'vitest'
import { focusGroupCost, readingChars } from './focusGroupCost'

describe('focusGroupCost', () => {
  it('counts every persona each round, a moderator call before rounds 2 and 3, and the synthesis', () => {
    expect(focusGroupCost(6, 2)).toStrictEqual({ calls: 14, inputTokens: 45_000, outputTokens: 8_000 })
    expect(focusGroupCost(2, 1).calls).toBe(3)
    expect(focusGroupCost(6, 3).calls).toBe(21)
  })

  it('adds what every persona call reads of the chosen documents and Library items', () => {
    // (6 personas × 2 rounds = 12 calls, each reading 40,000 characters: about 10,000 tokens more each)
    expect(focusGroupCost(6, 2, 40_000).inputTokens).toBe(165_000)
    expect(focusGroupCost(6, 2, 0)).toStrictEqual(focusGroupCost(6, 2))
  })

  it('reads docs/project-workspace.md’s figure with the documents and the Library at their most', () => {
    expect(focusGroupCost(6, 2, readingChars([30_000], [12_000])).inputTokens).toBe(171_000)
  })

  it.each([
    [[], [], 0],
    [[50_000], [], 30_000],
    [[20_000, 20_000], [], 30_000],
    [[1_000, 40_000, 40_000], [], 21_000],
    [[], [9_000, 9_000], 12_000],
    [[-5], [-5], 0],
  ])('bounds the reading as the stream does (documents %j, Library %j: %i characters)', (documents, library, chars) => {
    expect(readingChars(documents, library)).toBe(chars)
  })

  it('never estimates under a thousand tokens', () => {
    expect(focusGroupCost(0, 1)).toStrictEqual({ calls: 1, inputTokens: 1_000, outputTokens: 1_000 })
  })
})
