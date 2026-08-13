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
import {
  MAX_HISTORY_ENTRIES, MAX_INTERVIEW_HISTORY_ENTRIES, buildHistory, type HistoryEntry,
} from './chat'

/**
 * Read a sibling package's source that a coupling assertion below is pinned to.
 *
 * Deliberately NOT skipped when the file is missing. A skipped lockstep is a
 * silent lockstep, and silence is the failure these assertions exist to prevent,
 * so an unreachable source is still a failure — just one that explains itself
 * instead of surfacing as a bare ENOENT that says nothing about why a *frontend*
 * test wants a file from another package. Same idiom as the neighbouring
 * `api/streamLimits.lockstep.test.ts`.
 *
 * @param filePath The file to read.
 * @param purpose What the caller pins, named in the message so the reader does
 *   not have to work out which coupling broke.
 */
function readPinnedSource(filePath: string, purpose: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Cannot read ${filePath} from ${process.cwd()}. This test pins ${purpose}, so it needs `
      + 'both packages checked out and must run from the frontend package root.',
    )
  }
  return fs.readFileSync(filePath, 'utf8')
}

/**
 * Where the server's history window now lives.
 *
 * It used to be a literal `.max(50)` on the array in `schema.ts`, which this
 * file parsed with a balanced-paren pattern.  `development` since moved it to a
 * named constant in `history-budget.ts` and changed the array bound to
 * `.max(MAX_HISTORY_ARRAY)` — an order of magnitude higher, and a *rejection*
 * that no real conversation reaches.  The number the client actually has to
 * agree with is the window, so that is what this reads.
 *
 * This is also why the reader is now a named-constant match rather than a
 * schema-shape match: there is no numeric literal on the array to misread, so
 * the whole class of "matched the wrong `.max()`" defect is gone by
 * construction rather than by a cleverer regex.  Same approach as the
 * neighbouring `api/streamLimits.lockstep.test.ts`.
 */
const BUDGET_PATH = path.join(__dirname, '../../../lambda/stream/src/history-budget.ts')

/**
 * Matches `MAX_HISTORY_ENTRIES = 50`, tolerating the numeric separators the
 * stream package uses elsewhere (`16_000`).
 *
 * Anchored on the whole identifier so a *different* constant whose name merely
 * starts with it cannot be borrowed, and it requires digits: a value derived
 * from another constant (`MAX_HISTORY_ARRAY = MAX_HISTORY_ENTRIES * 10`) yields
 * no match rather than a wrong number.  Null is the safe direction — the caller
 * turns it into a loud, diagnosable failure.
 */
const SERVER_WINDOW_PATTERN = /\bMAX_HISTORY_ENTRIES\s*=\s*([0-9_]+)/

/**
 * Pull the server's history window out of `history-budget.ts`.
 *
 * Returns null when the constant is absent or no longer a literal, which the
 * caller turns into a loud failure rather than a vacuous pass.
 */
function extractServerWindow(source: string): number | null {
  const match = SERVER_WINDOW_PATTERN.exec(source)
  if (match?.[1] === undefined) return null
  return Number(match[1].replaceAll('_', ''))
}

/**
 * Where the product interview's own, tighter window lives.
 *
 * A different endpoint from `/chat/stream`, and a bare literal rather than a
 * named constant, so it needs its own reader. `ProductTab.interviewHistory.test`
 * asserts the client cap against *itself*, which stays green if the Python side
 * drops to 8 — this is the assertion that does not.
 */
const INTERVIEW_PATH = path.join(__dirname, '../../../lambda/api/product_context.py')

/**
 * Matches the interview slice, e.g. `for m in history[-12:]:`.
 *
 * Whitespace-tolerant inside the brackets because the slice is a literal the
 * formatter is free to respell; the digits are what this test is about.
 *
 * `\b` before `history` is load-bearing in the *other* direction: it stops the
 * pattern borrowing a slice of some other list. A `_` is a word character, so
 * there is no boundary in `chat_history[`, and a differently-named list
 * therefore yields null — the loud direction — rather than a plausible wrong
 * number.
 */
const SERVER_INTERVIEW_WINDOW_PATTERN = /\bhistory\[\s*-(\d+)\s*:\s*\]/

/**
 * Pull the interview's history window out of `product_context.py`.
 *
 * Null when the slice is absent or respelled beyond recognition, which the
 * caller turns into a loud failure rather than a vacuous pass.
 */
function extractInterviewWindow(source: string): number | null {
  const match = SERVER_INTERVIEW_WINDOW_PATTERN.exec(source)
  if (match?.[1] === undefined) return null
  return Number(match[1])
}

/** Alternating user/assistant conversation of the given length, user first. */
function alternating(total: number): HistoryEntry[] {
  return Array.from({ length: total }, (_, i): HistoryEntry => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
  }))
}

describe('extractServerWindow', () => {
  // The extractor is unit-tested so the coupling assertion below cannot fail
  // for a spelling change that leaves the window itself untouched — and, just
  // as importantly, cannot *pass* by reading a number that is not the window.
  it.each([
    ['a plain declaration', 'export const MAX_HISTORY_ENTRIES = 50;'],
    ['a padded declaration', 'export const MAX_HISTORY_ENTRIES  =  50 ;'],
    ['no export keyword', 'const MAX_HISTORY_ENTRIES = 50'],
    [
      'a preceding constant that is not the window',
      'export const MAX_HISTORY_CONTENT_LENGTH = 64000;\n'
      + 'export const MAX_HISTORY_ENTRIES = 50;',
    ],
  ])('reads the window from %s', (_label, source) => {
    expect(extractServerWindow(source)).toBe(50)
  })

  it('tolerates the numeric separators the stream package uses', () => {
    expect(extractServerWindow('export const MAX_HISTORY_ENTRIES = 1_000;')).toBe(1000)
  })

  it('returns null when the constant is absent', () => {
    // The loud direction. A renamed or deleted constant must red this suite
    // rather than let the coupling assertion pass vacuously forever.
    expect(extractServerWindow('export const MAX_HISTORY_ARRAY = 500;')).toBeNull()
  })

  it('returns null when the window stops being a literal', () => {
    // `MAX_HISTORY_ENTRIES = SOMETHING * 10` cannot be read by a regex, so it
    // must fail loudly instead of reporting a fragment of the expression.
    expect(extractServerWindow('const MAX_HISTORY_ENTRIES = BASE * 10;')).toBeNull()
  })

  it('does not borrow a longer identifier that merely starts with the name', () => {
    // Without the \b...whole-word anchoring, `MAX_HISTORY_ENTRIES_LEGACY` would
    // satisfy the pattern and report a number the server does not use.
    expect(extractServerWindow('const MAX_HISTORY_ENTRIES_LEGACY = 999;')).toBeNull()
  })
})

describe('MAX_HISTORY_ENTRIES vs the server window', () => {
  it('never exceeds the window the server keeps', () => {
    // Parsed from source rather than imported: history-budget.ts belongs to a
    // separate tsconfig project (lambda/stream) the frontend does not build.
    //
    // Note the server now CLAMPS to this window (`clampHistoryToBudget`) rather
    // than rejecting above it, so exceeding it is no longer a 400 — it is
    // silent truncation of the oldest turns. That is a weaker failure but not a
    // harmless one: sending more than the server keeps means the client's own
    // shape repair is applied to entries the server then discards, and the
    // *server's* slice has no such repair, so it can hand Bedrock a list
    // starting on an assistant turn. Staying at or under the window keeps the
    // repaired list the one the model actually sees.
    const source = readPinnedSource(
      BUDGET_PATH,
      "the client's history cap against the stream Lambda's own sliding window",
    )
    const serverWindow = extractServerWindow(source)

    // Fail loudly, and diagnosably, if the constant moved beyond what
    // extractServerWindow understands — a silently unmatched pattern would make
    // this test pass vacuously forever.
    expect(
      serverWindow,
      `Could not read MAX_HISTORY_ENTRIES from ${BUDGET_PATH}. If it was renamed, `
      + 'moved, or is no longer a numeric literal, update extractServerWindow to match.',
    ).not.toBeNull()
    expect(MAX_HISTORY_ENTRIES).toBeLessThanOrEqual(Number(serverWindow))
  })
})

describe('extractInterviewWindow', () => {
  // Same reasoning as extractServerWindow's unit tests: the coupling assertion
  // below must not be able to fail for a respelling that leaves the window
  // alone, nor pass by reading a number that is not the window.
  it.each([
    ['the spelling the file actually uses', 'for m in history[-12:]:'],
    ['a whitespace-padded slice', 'for m in history[-12 :]:'],
    ['a bare slice with no loop', 'recent = history[ -12 : ]'],
  ])('reads the window from %s', (_label, source) => {
    expect(extractInterviewWindow(source)).toBe(12)
  })

  it('reads a different number rather than hard-coding the current one', () => {
    // Guards against an extractor that "works" by returning 12 unconditionally.
    expect(extractInterviewWindow('for m in history[-8:]:')).toBe(8)
  })

  it('returns null when there is no slice at all', () => {
    // The loud direction: if the window is dropped, or moved to a named
    // constant, this must red rather than pass vacuously forever.
    expect(extractInterviewWindow('for m in history:')).toBeNull()
  })

  it('does not borrow a slice of a differently-named list', () => {
    // A rename must fail loudly, not silently pin against some other list's
    // window. `_` is a word character, so \bhistory cannot match `chat_history`.
    expect(extractInterviewWindow('for m in chat_history[-4:]:')).toBeNull()
    expect(extractInterviewWindow('for m in messages[-4:]:')).toBeNull()
  })

  it('does not match an open-ended or two-sided slice', () => {
    // `history[-12]` is an index, not a window, and `history[-12:-2]` drops the
    // newest turns — neither is the contract the client cap is pinned to.
    expect(extractInterviewWindow('m = history[-12]')).toBeNull()
    expect(extractInterviewWindow('for m in history[-12:-2]:')).toBeNull()
  })
})

describe('MAX_INTERVIEW_HISTORY_ENTRIES vs the interview window', () => {
  it('never exceeds the window the interview endpoint keeps', () => {
    // The interview is a different endpoint with a tighter window, and the
    // Python side spells it as a bare literal, so the coupling was previously
    // prose only: ProductTab.interviewHistory.test asserts the client cap
    // against itself and stays green if the server drops to 8.
    const source = readPinnedSource(
      INTERVIEW_PATH,
      "the client's interview history cap against product_context.py's own slice",
    )
    const serverWindow = extractInterviewWindow(source)

    // Fail loudly, and diagnosably, if the slice moved beyond what
    // extractInterviewWindow understands, rather than passing vacuously.
    expect(
      serverWindow,
      `Could not read the history slice from ${INTERVIEW_PATH}. If interview_turn now uses a `
      + 'named constant, a different list name, or a different slice shape, update '
      + 'extractInterviewWindow to match.',
    ).not.toBeNull()
    expect(MAX_INTERVIEW_HISTORY_ENTRIES).toBeLessThanOrEqual(Number(serverWindow))
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
