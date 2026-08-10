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
 * Matches `history: z.array(<element>).max(N)` and captures N.
 *
 * The `z.array(...)` argument is matched with *balanced* parens (two nesting
 * levels, which covers `z.object({ … z.enum([…]) })`) rather than a lazy
 * `[\s\S]*?`.  A lazy match stops at the first `.max(` after `z.array(`, which
 * need not be the array's own: an element schema spelled
 * `content: z.string().max(4000)` would make the extractor report 4000, and a
 * `history` that lost its cap entirely would silently borrow a later field's
 * number.  Either way the coupling assertion below would pass while the real
 * cap had moved — the exact drift it exists to catch.
 *
 * Still tolerant of a formatter wrapping `.max(N)` onto its own line and of a
 * padded argument, so a backend-only refactor that leaves the cap alone cannot
 * red this suite.
 */
const SERVER_CAP_PATTERN
  = /history:\s*z\s*\.array\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*\.max\(\s*(\d+)\s*\)/

/**
 * Pull the `history` cap out of the server schema source.
 *
 * Returns null when the shape is genuinely unrecognisable, which the caller
 * turns into a loud failure.
 */
function extractServerCap(source: string): number | null {
  const match = SERVER_CAP_PATTERN.exec(source)
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
  // for a spelling change that leaves the cap itself untouched — and, just as
  // importantly, cannot *pass* by reading a `.max()` that is not the array's.
  it.each([
    ['bare identifier element', '  history: z.array(historyMessageSchema).max(50).optional(),'],
    [
      'inlined element whose own fields carry .max()',
      '  history: z.array(z.object({ role: z.enum(["user", "assistant"]), '
      + 'content: z.string().min(1).max(4000) })).max(50),',
    ],
    ['.max() wrapped onto its own line', '  history: z\n    .array(historyMessageSchema)\n    .max(50)\n    .optional(),'],
    ['padded argument', '  history: z.array(historyMessageSchema).max( 50 ),'],
  ])('reads the array cap, not an inner one, from a %s', (_label, source) => {
    expect(extractServerCap(source)).toBe(50)
  })

  it('reads a lowered array cap even when an inner .max() is larger', () => {
    // The drift case that matters: if the server tightens the cap to 20 while
    // the element schema still has `.max(4000)`, a lazy pattern reports 4000
    // and `MAX_HISTORY_ENTRIES (50) <= 4000` passes — green on precisely the
    // regression this coupling check was added to catch.
    const source = '  history: z.array(z.object({ content: z.string().min(1).max(4000) })).max(20),'
    expect(extractServerCap(source)).toBe(20)
  })

  it('returns null when there is no history cap to read', () => {
    expect(extractServerCap('history: z.array(historyMessageSchema).optional(),')).toBeNull()
  })

  it('returns null rather than borrowing a later field\'s cap', () => {
    // An uncapped `history` is the maximally dangerous state, so it must fail
    // loudly instead of silently reading an unrelated field's number.
    const source = '  history: z.array(historyMessageSchema).optional(),\n'
      + '  budget: z.number().max(8192).optional(),'
    expect(extractServerCap(source)).toBeNull()
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

  it('holds every invariant under an odd cap, which step 4 repairs', () => {
    // Pins that evenness is not a precondition: an odd cap slices onto an
    // assistant turn and step 4 trims it, so the guarantees still hold.  Kept
    // so nobody reintroduces an unenforced "keep the cap even" contract.
    const history = buildHistory(alternating(40), 11)
    expect(history.length).toBeLessThanOrEqual(11)
    expect(history.length).toBeGreaterThan(0)
    expect(history[0].role).toBe('user')
    history.forEach((entry, i) => {
      if (i > 0) expect(entry.role).not.toBe(history[i - 1].role)
    })
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
