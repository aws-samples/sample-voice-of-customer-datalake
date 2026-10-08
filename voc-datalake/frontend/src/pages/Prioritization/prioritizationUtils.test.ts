/**
 * @fileoverview Tests for prioritizationUtils — safe score access and calculations.
 */
import { describe, it, expect } from 'vitest'
import i18n from 'i18next'
import { I18N_INIT_OPTIONS } from '../../i18n/options'
import { getScore, calculatePriorityScore, DEFAULT_SCORE, isScorable, SCORABLE_TYPE_META, MAX_NOTE_LENGTH, overLongNoteRows, applyBallotEdits, withEditedField } from './prioritizationUtils'
import type { PrioritizationScore, ProjectDocument } from '../../api/types'
import { byLocale } from './prioritization-unit-fixtures'

describe('getScore', () => {
  it('returns stored score when document_id exists', () => {
    const scores: Record<string, PrioritizationScore> = {
      'd1': { row_id: 'd1', impact: 4, time_to_market: 2, confidence: 3, strategic_fit: 5, notes: 'test' },
    }

    const result = getScore(scores, 'd1')

    expect(result.impact).toBe(4)
    expect(result.notes).toBe('test')
  })

  it('returns DEFAULT_SCORE with document_id when key is missing', () => {
    const scores: Record<string, PrioritizationScore> = {}

    const result = getScore(scores, 'missing-id')

    // 0 on EVERY axis, one shared unscored sentinel (#343). time_to_market
    // used to default to 3 while its siblings defaulted to 0, so the number 3
    // had two unrelated sources — a default here and a display coercion in the
    // row — that agreed only by accident.
    expect(result).toMatchObject({
      impact: 0, time_to_market: 0, confidence: 0, strategic_fit: 0, row_id: 'missing-id',
    })
  })

  it('returns DEFAULT_SCORE for empty scores object', () => {
    const result = getScore({}, 'any-id')

    expect(result).toStrictEqual({ ...DEFAULT_SCORE, row_id: 'any-id' })
  })
})

describe('calculatePriorityScore', () => {
  it('returns 0 for default unscored item', () => {
    const score = { ...DEFAULT_SCORE, row_id: 'd1' }

    // The name finally tells the truth: with every axis at the unscored
    // sentinel (0), the raw weighted sum is 0. It used to be 0.9 — the phantom
    // composite of time_to_market's old default of 3 — which is what let an
    // untouched proposal outrank one the team genuinely rated low.
    expect(calculatePriorityScore(score)).toBe(0)
  })

  it('computes weighted score correctly', () => {
    const score: PrioritizationScore = {
      row_id: 'd1', impact: 5, time_to_market: 4, confidence: 3, strategic_fit: 2, notes: '',
    }

    // 5*0.4 + 4*0.3 + 2*0.2 + 3*0.1 = 2.0 + 1.2 + 0.4 + 0.3 = 3.9
    expect(calculatePriorityScore(score)).toBeCloseTo(3.9)
  })

  it('returns max score for all-5 ratings', () => {
    const score: PrioritizationScore = {
      row_id: 'd1', impact: 5, time_to_market: 5, confidence: 5, strategic_fit: 5, notes: '',
    }

    expect(calculatePriorityScore(score)).toBeCloseTo(5.0)
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

describe('a pending edit carries only the fields the reader set', () => {
  // The defect: an edit seeded from `getScore` — and so from `DEFAULT_SCORE` on a row
  // with no stored ballot — sent all four axes when the reader moved one slider, two
  // of them as a `0` the slider (min=1) cannot express. The backend counts an
  // explicit value as a vote and averages each axis over the reviewers who cast one,
  // so those fabricated zeros moved the TEAM means this page displays and sorts by.
  it('records one axis without inventing the other three', () => {
    const edit = withEditedField({ row_id: 'd1' }, 'impact', 5)

    expect(edit).toStrictEqual({ row_id: 'd1', impact: 5 })
    // Named explicitly, because "absent" is what the route reads as "leave it alone"
    // and a 0 here is what it reads as a vote.
    expect(['time_to_market', 'confidence', 'strategic_fit', 'notes'].filter((key) => key in edit))
      .toStrictEqual([])
  })

  it('accumulates the fields a reader sets across several interactions', () => {
    // The positive control: omitting untouched axes must not become omitting touched
    // ones, or a reviewer's second slider would silently not save.
    const edit = withEditedField(
      withEditedField({ row_id: 'd1' }, 'impact', 5), 'confidence', 2,
    )

    expect(edit).toStrictEqual({ row_id: 'd1', impact: 5, confidence: 2 })
  })

  it('keeps an axis a number and a note a string', () => {
    // The slider hands over a string from the DOM event; a note stored as a number,
    // or an axis as a string, is refused by the API rather than caught here.
    expect(withEditedField({ row_id: 'd1' }, 'impact', '4').impact).toBe(4)
    expect(withEditedField({ row_id: 'd1' }, 'notes', 'why').notes).toBe('why')
  })

  it('shows a partial edit over the stored ballot without blanking what it omits', () => {
    // The sliders read this. A `{...saved, ...edit}` spread would let an axis the edit
    // says nothing about overwrite a saved one with `undefined`, blanking a slider
    // showing a score the reviewer had stored.
    const merged = applyBallotEdits({
      d1: {
        row_id: 'd1', impact: 2, time_to_market: 3, confidence: 4, strategic_fit: 5, notes: 'kept',
      },
    }, { d1: { row_id: 'd1', impact: 5 } })

    expect(merged.d1).toStrictEqual({
      row_id: 'd1', impact: 5, time_to_market: 3, confidence: 4, strategic_fit: 5, notes: 'kept',
    })
  })

  it('falls back to the display defaults for a row with no stored ballot', () => {
    // The sliders still need four numbers to render. That seeding is a DISPLAY
    // concern and stays here, on the way to the screen — not in the edit, which is
    // what gets sent.
    const merged = applyBallotEdits({}, { d1: { row_id: 'd1', impact: 5 } })

    expect(merged.d1).toStrictEqual({
      ...DEFAULT_SCORE, row_id: 'd1', impact: 5,
    })
  })

  it('leaves rows nobody edited exactly as they were saved', () => {
    const saved = {
      d1: {
        row_id: 'd1', impact: 1, time_to_market: 1, confidence: 1, strategic_fit: 1, notes: '',
      },
    }

    expect(applyBallotEdits(saved, {}).d1).toStrictEqual(saved.d1)
  })
})

describe('StatsCards regression: scores with missing document_id', () => {
  /**
   * Regression test for: TypeError: Cannot read properties of undefined (reading 'impact')
   * When scores object doesn't contain an entry for a PR/FAQ's document_id,
   * direct access scores[id].impact crashes. getScore() must be used instead.
   */
  it('getScore does not crash when accessing impact on missing score', () => {
    const scores: Record<string, PrioritizationScore> = {}
    const docId = 'nonexistent-doc'

    // This is what the buggy code did: scores[docId].impact
    // This is what the fixed code does:
    const score = getScore(scores, docId)
    expect(score.impact).toBe(0)
  })

  it('calculatePriorityScore works with getScore fallback', () => {
    const scores: Record<string, PrioritizationScore> = {}

    const score = getScore(scores, 'missing')
    expect(() => calculatePriorityScore(score)).not.toThrow()
    // All-zero sentinel composites to 0 (#343) — see 'returns 0 for default
    // unscored item' for why this stopped being 0.9.
    expect(calculatePriorityScore(score)).toBe(0)
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
