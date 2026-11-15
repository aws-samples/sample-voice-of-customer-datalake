/**
 * The rules of a proposed change on the canvas: replaced once, exactly, while its passage occurs exactly once in the
 * draft (out of date otherwise); the threads a pass takes by default; the accepted changes a saved text kept (the same
 * occurrence of their new text, followed through edits elsewhere; not merely the text found somewhere).
 */
import { describe, expect, it } from 'vitest'
import { applyChange, isOutOfDate, keptChanges, locatePlaced, NOTHING_PLACED, placeChange, threadIdsOf, threadsToConsider } from './reviseChanges'
import type { Placed } from './reviseChanges'
import type { CommentThread, ReviseChange } from '../../../api/documentReviewSchema'

const change = (before: string, after: string, threadIds: readonly string[] = ['t1'], id = 'ch_1'): ReviseChange => ({
  change_id: id, thread_ids: [...threadIds], before, after, reason: '',
})

function thread(id: string, extra: Partial<CommentThread> = {}): CommentThread {
  return {
    comment_id: id, document_id: 'doc', version: 1, text: 'Why?', anchor: null, status: 'open', flagged: false,
    created_at: '', author: { kind: 'user', name: 'Rui' }, replies: [], from_review_link: false, addressed: null, ...extra,
  }
}
const REPLY = { reply_id: 'r1', author: { kind: 'user' as const, name: 'Rui' }, text: 'Yes', flagged: false, at: '' }

describe('applyChange', () => {
  it('replaces the one occurrence of `before`, exactly, keeping everything around it', () => {
    expect(applyChange('# Plan\n\nWe ship in two weeks.\n', change('two weeks', 'ten days')))
      .toBe('# Plan\n\nWe ship in ten days.\n')
  })

  it('removes the passage when `after` is empty', () => {
    expect(applyChange('Keep this. Drop this.', change(' Drop this.', ''))).toBe('Keep this.')
  })

  it('refuses a passage edited away, or one that now occurs twice: the change is out of date', () => {
    const edited = 'We ship in three weeks.'
    const twice = 'two weeks, then two weeks more'

    expect([applyChange(edited, change('two weeks', 'ten days')), applyChange(twice, change('two weeks', 'ten days'))])
      .toStrictEqual([null, null])
    expect([isOutOfDate(edited, change('two weeks', 'x')), isOutOfDate(twice, change('two weeks', 'x')), isOutOfDate('two weeks', change('two weeks', 'x'))])
      .toStrictEqual([true, true, false])
  })

  it('counts two overlapping places as two (the server rule): `aa` in `aaa` is ambiguous, so out of date', () => {
    expect([isOutOfDate('Go aaa now', change('aa', 'b')), isOutOfDate('-----', change('---', 'x')), isOutOfDate('Go aa now', change('aa', 'b'))])
      .toStrictEqual([true, true, false])
    expect(applyChange('the the the end', change('the the', 'one'))).toBeNull()
  })

  it('treats `$` patterns in `after` as text (no replacement-pattern expansion)', () => {
    expect(applyChange('Price: X', change('X', '$& $1 $$'))).toBe('Price: $& $1 $$')
  })
})

describe('threadsToConsider', () => {
  it('takes resolved threads and open ones with a reply, never an addressed one or an unanswered one', () => {
    const threads = [
      thread('open'), thread('replied', { replies: [REPLY] }), thread('resolved', { status: 'resolved' }),
      thread('addressed', { status: 'resolved', addressed: { version: 2, at: '', by_kind: 'user' } }),
    ]

    expect(threadsToConsider(threads).map((t) => t.comment_id)).toStrictEqual(['replied', 'resolved'])
  })
})

/** The changes placed, in order, into `draft` (as Accept does), each one asserted in date. */
function placeAll(draft: string, changes: readonly ReviseChange[]): Placed {
  return changes.reduce<Placed>((placed, next) => {
    const after = placeChange(placed, next)
    if (after === null) throw new Error(`${next.change_id} is out of date`)
    return after
  }, { ...NOTHING_PLACED, draft })
}

const ids = (changes: readonly ReviseChange[]) => changes.map((c) => c.change_id)

describe('keptChanges and threadIdsOf', () => {
  const DRAFT = 'We ship in two weeks, as planned for the launch.\n\nMessages go out every day, before noon at the latest.\n\nKeep this. Drop this.\n'

  it('keeps the accepted changes whose own new text the saved text holds (a deletion: its join), each thread once', () => {
    const kept = change('two weeks', 'ten days', ['t1', 't2'], 'a')
    const lost = change('every day', 'once a day', ['t3'], 'b')
    const deleted = change(' Drop this.', '', ['t2'], 'c')
    const placed = placeAll(DRAFT, [kept, lost, deleted])
    const typedOver = placed.draft.replace('once a day', 'every week')

    const result = keptChanges([kept, lost, deleted], placed, typedOver)

    expect(ids(result)).toStrictEqual(['a', 'c'])
    expect(threadIdsOf(result)).toStrictEqual(['t1', 't2'])
  })

  it('follows a change moved by edits elsewhere (before it and after it)', () => {
    const quick = change('two weeks', 'ten days', ['t1'], 'a')
    const placed = placeAll(DRAFT, [quick])
    const edited = `# Plan\n\nAn opening paragraph written after accepting.\n\n${placed.draft.replace('before noon', 'by 11:00')}`

    expect(ids(keptChanges([quick], placed, edited))).toStrictEqual(['a'])
  })

  it('a discarded change whose `after` is part of its `before` is not kept (the old text still holds `after`)', () => {
    const shorter = change('as planned for the launch', 'as planned', ['t1'], 'a')
    const placed = placeAll(DRAFT, [shorter])

    expect(DRAFT).toContain(shorter.after)
    expect(ids(keptChanges([shorter], placed, DRAFT))).toStrictEqual([])
    expect(ids(keptChanges([shorter], placed, placed.draft))).toStrictEqual(['a'])
  })

  it('a short `after` that also occurs elsewhere is not kept once its own occurrence is typed over', () => {
    const draft = 'It is a day of early starts for drivers in the north.\n\nWe message once a week, on the weekend only.\n'
    const daily = change('a week', 'a day', ['t1'], 'a')
    const placed = placeAll(draft, [daily])
    expect(placed.draft.split('a day')).toHaveLength(3)
    const typedOver = placed.draft.replace('once a day', 'once a fortnight')

    expect(typedOver).toContain('a day')
    expect(ids(keptChanges([daily], placed, typedOver))).toStrictEqual([])
    expect(ids(keptChanges([daily], placed, `A day of notes. ${placed.draft}`))).toStrictEqual(['a'])
  })

  it('a deletion at the end of the text is not kept once its old text is back', () => {
    const deleted = change(' Drop this.', '', ['t2'], 'c')
    const placed = placeAll('Keep this. Drop this.', [deleted])

    expect(ids(keptChanges([deleted], placed, 'Keep this.'))).toStrictEqual(['c'])
    expect(ids(keptChanges([deleted], placed, 'Keep this. Drop this.'))).toStrictEqual([])
  })

  it('a change never placed (accepted elsewhere, or reset) is not kept', () => {
    const quick = change('two weeks', 'ten days', ['t1'], 'a')

    expect(ids(keptChanges([quick], NOTHING_PLACED, 'We ship in ten days.'))).toStrictEqual([])
  })
})

describe('placeChange and locatePlaced', () => {
  it('a later change before an earlier one moves it, and both are still found', () => {
    const second = change('every day', 'once a day', ['t3'], 'b')
    const first = change('two weeks', 'ten days', ['t1'], 'a')
    const placed = placeAll('We ship in two weeks, as planned for the launch.\n\nMessages go out every day, before noon.\n', [second, first])

    const textAt = (id: string, length: number) => {
      const offset = placed.at[id]?.offset ?? -1
      return placed.draft.slice(offset, offset + length)
    }

    expect([textAt('b', 10), textAt('a', 8)]).toStrictEqual(['once a day', 'ten days'])
  })

  it('is out of date (null) when the passage is gone, and finds nothing for an empty text and change', () => {
    expect(placeChange({ ...NOTHING_PLACED, draft: 'nothing here' }, change('two weeks', 'x'))).toBeNull()
    expect(locatePlaced('', 0, '', '')).toBeNull()
  })

  it('of several matching occurrences takes the one with the most surroundings in common, then the nearest', () => {
    const draft = 'row: alpha beta gamma; row: alpha beta gamma; end'
    const at = draft.lastIndexOf('beta')

    expect(locatePlaced('beta', at, draft, draft)).toBe(at)
    expect(locatePlaced('beta', at, draft, `x${draft}`)).toBe(at + 1)
  })
})
