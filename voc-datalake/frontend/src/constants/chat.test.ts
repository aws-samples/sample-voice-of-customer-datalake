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

/**
 * Pull the `history` cap out of the server schema source.
 *
 * Tolerant of nested parens in the element schema and of a formatter wrapping
 * `.max(N)` onto its own line, so a backend-only refactor that leaves the cap
 * unchanged cannot red this suite.  Returns null when the shape is genuinely
 * unrecognisable, which the caller turns into a loud failure.
 */
function extractServerCap(source: string): number | null {
  const match = /history:\s*z\s*\.array\([\s\S]*?\)\s*\.max\(\s*(\d+)\s*\)/.exec(source)
  return match === null ? null : Number(match[1])
}

/** Alternating user/assistant conversation of the given length, user first. */
function alternating(total: number): HistoryEntry[] {
  return Array.from({ length: total }, (_, i): HistoryEntry => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
  }))
}

describe('extractServerCap', () => {
  // The extractor is unit-tested so the coupling assertion below cannot fail
  // for a spelling change that leaves the cap itself untouched.
  it.each([
    ['bare identifier element', '  history: z.array(historyMessageSchema).max(50).optional(),'],
    ['inlined element with nested parens', '  history: z.array(z.object({ role: z.enum(["user", "assistant"]) })).max(50),'],
    ['.max() wrapped onto its own line', '  history: z\n    .array(historyMessageSchema)\n    .max(50)\n    .optional(),'],
    ['padded argument', '  history: z.array(historyMessageSchema).max( 50 ),'],
  ])('reads the cap from a %s', (_label, source) => {
    expect(extractServerCap(source)).toBe(50)
  })

  it('returns null when there is no history cap to read', () => {
    expect(extractServerCap('history: z.array(historyMessageSchema).optional(),')).toBeNull()
  })
})

describe('MAX_HISTORY_ENTRIES vs the server cap', () => {
  it('never exceeds the `.max(N)` on the server history schema', () => {
    // Parsed from source rather than imported: schema.ts belongs to a separate
    // tsconfig project (lambda/stream) that the frontend does not build.
    const schemaPath = path.join(__dirname, '../../../lambda/stream/src/schema.ts')
    const source = fs.readFileSync(schemaPath, 'utf8')
    const serverCap = extractServerCap(source)

    // Fail loudly, and diagnosably, if the schema shape changed beyond what
    // extractServerCap understands — a silently unmatched pattern would make
    // this test pass vacuously forever.
    expect(
      serverCap,
      `Could not read the history cap from ${schemaPath}. If the schema was `
      + 'restructured, update extractServerCap to match.',
    ).not.toBeNull()
    expect(MAX_HISTORY_ENTRIES).toBeLessThanOrEqual(Number(serverCap))
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

  it('drops a cancelled question instead of gluing it onto the next one', () => {
    // The state three sends into `ask -> Stop -> ask -> reply arrives -> ask`.
    // Merging same-role runs here would fuse the abandoned question onto the
    // one the user actually asked, attributing both to a single turn.  The
    // payload would still be valid, so this fails silently rather than as a
    // ValidationException — which is why it needs its own test.
    const history = buildHistory([
      {
        role: 'user',
        content: 'cancelled',
      },
      {
        role: 'user',
        content: 'real',
      },
      {
        role: 'assistant',
        content: 'reply',
      },
    ])
    expect(history).toEqual([
      {
        role: 'user',
        content: 'real',
      },
      {
        role: 'assistant',
        content: 'reply',
      },
    ])
    // Not merely absent as an entry — absent as a substring, since a merge
    // would have concatenated it into a neighbour.
    expect(history.some((entry) => entry.content.includes('cancelled'))).toBe(false)
  })

  it('starts with a user turn when the conversation opens on an assistant turn', () => {
    // Guards the real step-4 case: an assistant-first list that is *within*
    // the cap, e.g. the greeting-first product interview or a restored
    // transcript whose opening user turn was pruned.  The cap boundary itself
    // cannot produce this, so without this test step 4 has no coverage.
    const history = buildHistory([
      {
        role: 'assistant',
        content: 'greeting',
      },
      {
        role: 'user',
        content: 'question',
      },
      {
        role: 'assistant',
        content: 'answer',
      },
    ])
    expect(history).toEqual([
      {
        role: 'user',
        content: 'question',
      },
      {
        role: 'assistant',
        content: 'answer',
      },
    ])
  })

  it('honours a caller-supplied cap for surfaces with a tighter window', () => {
    const history = buildHistory(alternating(40), 12)
    expect(history.length).toBeLessThanOrEqual(12)
    expect(history[0].role).toBe('user')
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
