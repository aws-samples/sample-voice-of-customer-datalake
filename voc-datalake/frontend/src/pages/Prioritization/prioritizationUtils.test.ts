/**
 * @fileoverview Tests for prioritizationUtils — safe score access, ballot edits, sort fields.
 */
import { describe, it, expect } from 'vitest'
import i18n from 'i18next'
import { I18N_INIT_OPTIONS } from '../../i18n/options'
import {
  getScore, DEFAULT_SCORE, isScorable, SCORABLE_TYPE_META, MAX_NOTE_LENGTH, overLongNoteRows, applyBallotEdits,
  withBallotEdit, axisValue, toWireBallotEdits, effectiveSortField, axisSortField, sortAxisId,
} from './prioritizationUtils'
import type { BallotChange } from './prioritizationUtils'
import type { PrioritizationScore, ProjectDocument } from '../../api/types'
import { byLocale } from './prioritization-unit-fixtures'

const ballot = (rowId: string, values: Record<string, number>, notes = ''): PrioritizationScore => ({ row_id: rowId, values, notes })
const axis = (axisId: string, value: number): BallotChange => ({ field: 'axis', axisId, value })

describe('getScore', () => {
  it('returns stored score when the row exists', () => {
    const result = getScore({ d1: ballot('d1', { impact: 4 }, 'test') }, 'd1')

    expect(axisValue(result, 'impact')).toBe(4)
    expect(result.notes).toBe('test')
  })

  it('answers the unscored sentinel for every axis of a missing row (#343)', () => {
    const result = getScore({}, 'missing-id')

    expect(result).toStrictEqual({ ...DEFAULT_SCORE, row_id: 'missing-id' })
    expect(['impact', 'reach', 'toString'].map((id) => axisValue(result, id))).toStrictEqual([0, 0, 0])
  })
})

describe('isScorable', () => {
  it('returns true for prfaq documents', () => {
    const doc = { document_id: 'd1', document_type: 'prfaq' as const, title: 'A', content: '', created_at: '2025-01-01' }
    expect(isScorable(doc)).toBe(true)
  })

  it('returns true for prd documents', () => {
    const doc: ProjectDocument = { document_id: 'd2', document_type: 'prd', title: 'B', content: '', created_at: '2025-01-01' }
    expect(isScorable(doc)).toBe(true)
  })

  it('returns false for non-scorable document types', () => {
    const types: ProjectDocument['document_type'][] = ['research', 'custom', 'product_report', 'prototype']
    for (const documentType of types) {
      const doc: ProjectDocument = {
        document_id: 'dx', document_type: documentType, title: 'X', content: '', created_at: '2025-01-01',
      }
      expect(isScorable(doc)).toBe(false)
    }
  })
})

describe('withBallotEdit: moving a slider and moving it back is no change (Save stays disabled)', () => {
  const saved = { d1: ballot('d1', { impact: 3, confidence: 4 }) }

  it('drops the row once every field is back at its saved value', () => {
    const moved = withBallotEdit({}, saved, 'd1', axis('impact', 5))
    expect(moved).toStrictEqual({ d1: { row_id: 'd1', values: { impact: 5 } } })
    expect(withBallotEdit(moved, saved, 'd1', axis('impact', 3))).toStrictEqual({})
  })

  it('keeps only the fields that still differ, and leaves other rows alone', () => {
    const edits = withBallotEdit(withBallotEdit({ d2: { row_id: 'd2', notes: 'x' } }, saved, 'd1', axis('impact', 5)), saved, 'd1', axis('confidence', 2))
    expect(withBallotEdit(edits, saved, 'd1', axis('impact', 3))).toStrictEqual({ d2: { row_id: 'd2', notes: 'x' }, d1: { row_id: 'd1', values: { confidence: 2 } } })
  })

  it('treats an emptied new note as no change', () => {
    expect(withBallotEdit({}, {}, 'd9', { field: 'notes', value: '' })).toStrictEqual({})
  })

  it('records one CONFIGURED axis without inventing the others', () => {
    // An omitted axis is what PATCH reads as "leave it alone"; a 0 would be a vote.
    expect(withBallotEdit({}, {}, 'd1', axis('reach', 4))).toStrictEqual({ d1: { row_id: 'd1', values: { reach: 4 } } })
  })

  it('accumulates the fields a reader sets across several interactions', () => {
    const edits = withBallotEdit(withBallotEdit({}, {}, 'd1', axis('impact', 5)), {}, 'd1', { field: 'notes', value: 'why' })
    expect(edits).toStrictEqual({ d1: { row_id: 'd1', values: { impact: 5 }, notes: 'why' } })
  })
})

describe('applyBallotEdits', () => {
  it('shows a partial edit over the stored ballot without blanking what it omits', () => {
    const merged = applyBallotEdits({ d1: ballot('d1', { impact: 2, confidence: 4 }, 'kept') }, { d1: { row_id: 'd1', values: { impact: 5 } } })

    expect(merged.d1).toStrictEqual(ballot('d1', { impact: 5, confidence: 4 }, 'kept'))
  })

  it('falls back to the display defaults for a row with no stored ballot', () => {
    expect(applyBallotEdits({}, { d1: { row_id: 'd1', values: { impact: 5 } } }).d1).toStrictEqual(ballot('d1', { impact: 5 }))
  })

  it('leaves rows nobody edited exactly as they were saved', () => {
    const saved = { d1: ballot('d1', { impact: 1 }) }
    expect(applyBallotEdits(saved, {}).d1).toStrictEqual(saved.d1)
  })
})

describe('toWireBallotEdits', () => {
  it('flattens each axis to a top-level number named by its id, as ballots are stored', () => {
    expect(toWireBallotEdits({ r1: { row_id: 'r1', values: { reach: 4, effort: 2 }, notes: 'n' } }, [{ id: 'reach' }, { id: 'effort' }]))
      .toStrictEqual({ r1: { row_id: 'r1', reach: 4, effort: 2, notes: 'n' } })
  })

  it('sends no notes key and no axes the reviewer did not set', () => {
    expect(toWireBallotEdits({ r1: { row_id: 'r1', values: { impact: 3 } } }, [{ id: 'impact' }])).toStrictEqual({ r1: { row_id: 'r1', impact: 3 } })
  })

  it('drops a pending value on a metric that has since been archived (the API would refuse it)', () => {
    expect(toWireBallotEdits({ r1: { row_id: 'r1', values: { impact: 3, gone: 5 } } }, [{ id: 'impact' }])).toStrictEqual({ r1: { row_id: 'r1', impact: 3 } })
  })
})

describe('sort fields', () => {
  const active = [{ id: 'reach' }, { id: 'impact' }]

  it('round-trips an axis sort field', () => {
    expect([sortAxisId(axisSortField('reach')), sortAxisId('priority_score')]).toStrictEqual(['reach', null])
  })

  it('keeps a sort on an active axis and falls back to the priority score for an archived one', () => {
    expect([effectiveSortField(axisSortField('reach'), active), effectiveSortField(axisSortField('ttm'), active), effectiveSortField('created_at', active)])
      .toStrictEqual(['axis:reach', 'priority_score', 'created_at'])
  })
})

describe('SCORABLE_TYPE_META display labels', () => {
  // Bound to feedbackForms ON PURPOSE, not to prioritization: these keys are read
  // from two namespaces — the badge in PRFAQRow (prioritization) and the document
  // select in FeedbackForms/ValidationLinkPicker (feedbackForms) — and only the
  // foreign binding can fail. A relative key resolves fine in its own namespace,
  // so a test using `prioritization` passes with or without the prefix and proves
  // nothing. This is the gate the badge itself never had: no Prioritization test
  // asserts the badge text, so un-qualifying these keys left that suite green.
  const t = i18n.getFixedT(null, 'feedbackForms')
  /** The label a scorable type shows, or `undefined` once the type is no longer scorable. */
  const labelOf = (meta: { readonly i18nKey: string } | undefined) => (meta === undefined ? undefined : t(meta.i18nKey))

  it("keep working only while the app's nsSeparator is ':' — assert the real config", () => {
    // The resolution test below runs against the TEST i18n instance (src/test/setup.ts),
    // so it would stay green if the APP disabled the namespace separator — a common
    // workaround for keys that contain colons. I18N_INIT_OPTIONS is the object
    // src/i18n/config.ts hands to init(), imported from a side-effect-free module so
    // reading it here does not start the HTTP backend.
    expect(
      I18N_INIT_OPTIONS.nsSeparator ?? ':',
      'the app disabled/changed nsSeparator — every `prioritization:docType.*` read '
      + '(the Prioritization badge, the Feedback Forms document picker) now renders '
      + 'the raw key path',
    ).toBe(':')
    // And the test instance must agree, or the assertion below tests a different
    // resolver than the app ships.
    expect(i18n.options.nsSeparator ?? ':').toBe(':')
  })

  it('resolve to real text, not the raw key path, from another namespace', () => {
    const entries = Object.entries(SCORABLE_TYPE_META)
    expect(entries.length, 'nothing is scorable — the constant is empty').toBeGreaterThan(0)

    for (const [type, meta] of entries) {
      if (!meta) throw new Error(`${type} has no display metadata`)
      const label = t(meta.i18nKey)
      expect(label, `${type}: '${meta.i18nKey}' does not resolve — the badge and the
        document picker would both render this raw key path to users`)
        .not.toBe(meta.i18nKey)
      expect(label.trim(), `${type} resolves to an empty label`).not.toBe('')
    }
  })

  it('name the scorable types PRD and PR/FAQ', () => {
    // Pinned literals, not the catalogue value looked up the same way the code
    // does: this is what a user reads on the Prioritization badge and in the
    // document select, and it is the assertion that fails if a rename lands in
    // one place only.
    // A type that stopped being scorable reads as `undefined` here, not as a crash.
    expect(labelOf(SCORABLE_TYPE_META.prd)).toBe('PRD')
    expect(labelOf(SCORABLE_TYPE_META.prfaq)).toBe('PR/FAQ')
  })
})

describe('overLongNoteRows', () => {
  // The API refuses a note past MAX_NOTE_LENGTH rather than truncating it, and
  // `fetchApi` discards the response body, so the page has to spot the refusal
  // before sending or Save appears to do nothing.
  // No cast: the helper is typed for the shape it reads, so a record whose note
  // is absent — which stored ballots really are — is expressible here.
  const score = (notes?: string | null): { readonly notes?: string | null } => ({ notes })

  it('names the document whose note is over the bound', () => {
    const edits = { d1: score('x'.repeat(MAX_NOTE_LENGTH + 1)) }

    expect(overLongNoteRows(edits)).toStrictEqual(['d1'])
  })

  it('accepts a note exactly at the bound', () => {
    // The backend's check is `> MAX`, so the boundary value is legal. An
    // off-by-one here would block a save the API would have accepted.
    const edits = { d1: score('x'.repeat(MAX_NOTE_LENGTH)) }

    expect(overLongNoteRows(edits)).toStrictEqual([])
  })

  it('names every offending document, not just the first', () => {
    const edits = {
      d1: score('x'.repeat(MAX_NOTE_LENGTH + 1)),
      d2: score('short'),
      d3: score('y'.repeat(MAX_NOTE_LENGTH + 500)),
    }

    expect(overLongNoteRows(edits).sort(byLocale)).toStrictEqual(['d1', 'd3'])
  })

  it('treats a missing note as no note rather than crashing', () => {
    // Stored ballots predate `notes` being written on every save, and this record
    // arrives from the network with no runtime guarantee it matches the type. A
    // throw here would take down the page on a save the API would have accepted.
    expect(overLongNoteRows({ d1: score() })).toStrictEqual([])
    expect(overLongNoteRows({ d1: score(null) })).toStrictEqual([])
  })

  it('is empty when nothing is pending', () => {
    expect(overLongNoteRows({})).toStrictEqual([])
  })
})

describe('overLongNoteRows counts in the unit the API uses', () => {
  // JS `.length` is UTF-16 code units; the API's `len()` is code points. Pinning
  // the unit, not just the number: a lockstep on the two constants would pass while
  // the page measured a different thing with them.
  //
  // Astral characters are the ONLY inputs that discriminate — they are the only ones
  // whose two counts differ — so these two cases are the whole of the unit coverage
  // and both are needed: the first fails under a code-unit count, the second fails if
  // counting code points ever became "emoji are free". A combining sequence measures
  // the same either way and would pass whichever count was used, which is why there
  // is no third case here.
  const score = (notes: string): { readonly notes: string } => ({ notes })

  it('accepts a note of astral characters the API would accept', () => {
    // 1500 emoji: 3000 code units, 1500 code points. A code-unit count blocks this
    // and quotes a limit the reviewer never reached.
    const emoji = '😀'.repeat(MAX_NOTE_LENGTH - 500)

    expect(overLongNoteRows({ d1: score(emoji) })).toStrictEqual([])
  })

  it('still refuses astral characters past the bound', () => {
    // The positive control for the test above: counting code points must not become
    // "emoji are free".
    const emoji = '😀'.repeat(MAX_NOTE_LENGTH + 1)

    expect(overLongNoteRows({ d1: score(emoji) })).toStrictEqual(['d1'])
  })
})
