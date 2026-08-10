/**
 * @fileoverview Tests for the shared chat history rules.
 *
 * Two jobs:
 *   1. Pin the client cap to the server cap so drift fails here rather than in
 *      production (issue #265 pairing fix).
 *   2. Pin the shape guarantees buildHistory owes Bedrock Converse: never more
 *      than the cap, always starting with a user turn, always alternating.
 */
import * as fs from 'fs'
import * as path from 'path'
import { describe, it, expect } from 'vitest'
import { MAX_HISTORY_ENTRIES, buildHistory, type HistoryEntry } from './chat'

/** Alternating user/assistant conversation of the given length, user first. */
function alternating(total: number): HistoryEntry[] {
  return Array.from({ length: total }, (_, i): HistoryEntry => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
  }))
}

describe('MAX_HISTORY_ENTRIES vs the server cap', () => {
  it('never exceeds the `.max(N)` on the server history schema', () => {
    // Parsed from source rather than imported: schema.ts belongs to a separate
    // tsconfig project (lambda/stream) that the frontend does not build.
    const schemaPath = path.join(__dirname, '../../../lambda/stream/src/schema.ts')
    const source = fs.readFileSync(schemaPath, 'utf8')
    const match = /history:\s*z\.array\([^)]*\)\.max\((\d+)\)/.exec(source)

    // Fail loudly if the schema was reworded — a silently unmatched regex
    // would make this test pass vacuously forever.
    expect(match).not.toBeNull()
    const serverCap = Number(match?.[1])
    expect(serverCap).toBeGreaterThan(0)
    expect(MAX_HISTORY_ENTRIES).toBeLessThanOrEqual(serverCap)
  })
})

describe('buildHistory', () => {
  it('returns an empty array for an empty conversation', () => {
    expect(buildHistory([])).toEqual([])
  })

  it('drops a trailing unanswered user turn', () => {
    // This is the state a cancelled stream leaves behind: the user message is
    // stored with no assistant reply.  Keeping it would send two consecutive
    // user turns once the caller appends the new message.
    const history = buildHistory([
      {
        role: 'user',
        content: 'first',
      },
      {
        role: 'assistant',
        content: 'reply',
      },
      {
        role: 'user',
        content: 'cancelled question',
      },
    ])
    expect(history).toEqual([
      {
        role: 'user',
        content: 'first',
      },
      {
        role: 'assistant',
        content: 'reply',
      },
    ])
  })

  it('merges runs of consecutive assistant turns (roundtable personas)', () => {
    const history = buildHistory([
      {
        role: 'user',
        content: 'what do you all think?',
      },
      {
        role: 'assistant',
        content: 'persona A',
      },
      {
        role: 'assistant',
        content: 'persona B',
      },
      {
        role: 'assistant',
        content: 'persona C',
      },
      {
        role: 'user',
        content: 'follow-up',
      },
      {
        role: 'assistant',
        content: 'answer',
      },
    ])
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(history[1].content).toBe('persona A\n\npersona B\n\npersona C')
  })

  it.each([50, 51, 52, 60, 61])(
    'caps a %i-message conversation and still starts with a user turn',
    (total) => {
      const history = buildHistory(alternating(total))
      expect(history.length).toBeLessThanOrEqual(MAX_HISTORY_ENTRIES)
      expect(history.length).toBeGreaterThan(0)
      expect(history[0].role).toBe('user')
      // Strict alternation, which is what Bedrock Converse requires.
      history.forEach((entry, i) => {
        if (i > 0) expect(entry.role).not.toBe(history[i - 1].role)
      })
    },
  )

  it('keeps the newest turns when the conversation exceeds the cap', () => {
    const history = buildHistory(alternating(60))
    // 60 messages: index 59 is assistant (answered), so nothing is trimmed
    // from the tail and the newest kept entry is the last one.
    expect(history[history.length - 1].content).toBe('message 59')
  })

  it('passes a short conversation through unchanged', () => {
    const messages = alternating(10)
    expect(buildHistory(messages)).toEqual(messages)
  })

  it('returns an empty array when no user turn survives the cap', () => {
    expect(buildHistory([
      {
        role: 'assistant',
        content: 'orphan reply',
      },
    ])).toEqual([])
  })
})
