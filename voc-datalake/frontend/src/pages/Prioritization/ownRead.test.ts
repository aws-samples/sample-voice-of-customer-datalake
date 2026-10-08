/**
 * @fileoverview Tests for ownRead — the caller's own half of the scores read, and stored rows.
 */
import { describe, it, expect } from 'vitest'
import { normalizeRow, normalizeRows, MAX_ROW_DOCUMENT_IDS, normalizeScores, ownBallotRead } from './ownRead'
import { getScore, DEFAULT_SCORE, MAX_NOTE_LENGTH } from './prioritizationUtils'
import { byLocale, entryOf, storedRow } from './prioritization-unit-fixtures'

describe('normalizeRows', () => {
  it('parses the rows on the wire', () => {
    const row = entryOf(normalizeRows({ 'row-1': storedRow('row-1', 'p1', ['prd-1']) }), 'row-1')

    expect(row.project_id).toBe('p1')
    expect(row.document_ids).toStrictEqual(['prd-1'])
  })

  it('takes row_id from the map KEY, not from the record', () => {
    // Every lookup addresses the key, so a record disagreeing with its own key would
    // produce a row nothing can find — the same rule `normalizeScores` follows.
    const rows = normalizeRows({ 'row-1': storedRow('somewhere-else', 'p1', ['prd-1']) })

    expect(entryOf(rows, 'row-1').row_id).toBe('row-1')
  })

  it('tells "no rows on the wire" apart from "unreadable"', () => {
    // `{}` is a deployment that has no rows yet — an honest empty backlog. `undefined`
    // is a read that said nothing, which the page must not render as an empty one.
    const inputs: unknown[] = [undefined, {}, 'not a map', null, []]
    expect(inputs.map((raw) => normalizeRows(raw))).toStrictEqual([{}, {}, undefined, undefined, undefined])
  })

  it('drops an unreadable ROW rather than inventing a project or a composition', () => {
    // `project_id` and `document_ids` carry no fallback: they are what makes a row
    // renderable, and an invented `''`/`[]` would put an empty unscorable row in the
    // list under a project nobody can open.
    const rows = normalizeRows({
      good: storedRow('good', 'p1', ['prd-1']),
      noProject: { row_id: 'noProject', document_ids: ['prd-1'] },
      noDocuments: { row_id: 'noDocuments', project_id: 'p1' },
      notAnObject: 'nope',
    })

    expect(Object.keys(rows ?? {})).toStrictEqual(['good'])
  })

  it('degrades the metadata that does not decide whether the row exists', () => {
    const row = entryOf(normalizeRows({
      'row-1': { project_id: 'p1', document_ids: ['prd-1'] },
    }), 'row-1')

    expect(row.prototype_id).toBe('')
    expect(row.is_default).toBe(false)
    expect(row.created_at).toBe('')
  })

  it('refuses a row longer than the API can compose, and keeps one at the bound', () => {
    // `MAX_ROW_DOCUMENT_IDS` is where the backend TRUNCATES a composition, so a longer
    // row is a response nothing on the server wrote — and a schema whose job is to say
    // what it accepts should not accept it. The bound itself stays accepted, which is
    // the half that fails if the two sides drift by one.
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `prd-${i}`)
    const rows = normalizeRows({
      atTheBound: storedRow('atTheBound', 'p1', ids(MAX_ROW_DOCUMENT_IDS)),
      overIt: storedRow('overIt', 'p1', ids(MAX_ROW_DOCUMENT_IDS + 1)),
    })

    expect(Object.keys(rows ?? {})).toStrictEqual(['atTheBound'])
  })
})

describe('normalizeRow validates the ONE row a create answers with', () => {
  // `POST /projects/prioritization/rows` answers `{row: ...}` rather than a map, and the
  // page RENDERS that answer — it is what keeps the list alive while the prioritization
  // read is failing or in flight. So it is held to the same schema as the read half:
  // reading `row.row_id` off an unvalidated body threw inside the effect's `.then`,
  // losing every row in the batch and leaving the rejection unhandled.

  it('parses a row that carries its own id', () => {
    const row = normalizeRow(storedRow('row-1', 'p1', ['prd-1', 'prfaq-1']))

    expect(row?.row_id).toBe('row-1')
    expect(row?.project_id).toBe('p1')
    expect(row?.document_ids).toStrictEqual(['prd-1', 'prfaq-1'])
  })

  it('prefers a supplied id, which is how the read half addresses a row', () => {
    // The map-key rule, available to this function too: the key is what every lookup
    // uses, so it wins over a record disagreeing with it.
    expect(normalizeRow(storedRow('somewhere-else', 'p1', ['prd-1']), 'row-1')?.row_id)
      .toBe('row-1')
  })

  it('refuses a body that type-checks but says nothing', () => {
    // The exact shapes that made the unvalidated read throw or fabricate: an answer with
    // no row at all, an empty object (which `{success: true, row: {}}` is), a null id,
    // and a row with no project or no composition.
    const refused: unknown[] = [
      undefined,
      {},
      { row_id: null, project_id: 'p1', document_ids: ['prd-1'] },
      { row_id: 'row-1', document_ids: ['prd-1'] },
      { row_id: 'row-1', project_id: 'p1' },
    ]
    expect(refused.map((raw) => normalizeRow(raw))).toStrictEqual(refused.map(() => undefined))
  })

  it('refuses a row it could not address', () => {
    // An EMPTY id is not a row the page can use: no ballot, aggregate or expansion could
    // ever be looked up against it, and merging it in would put an unreachable row on
    // screen under a key nothing writes to.
    expect(normalizeRow(storedRow('', 'p1', ['prd-1']))).toBeUndefined()
  })

  it('applies the same document bound the read half applies', () => {
    // The create route truncates at `MAX_ROW_DOCUMENT_IDS`, so a longer row is a
    // response nothing on the server wrote — and it must not slip in through the create
    // path just because the read path refuses it.
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `prd-${i}`)

    expect(normalizeRow(storedRow('r', 'p1', ids(MAX_ROW_DOCUMENT_IDS)))?.row_id).toBe('r')
    expect(normalizeRow(storedRow('r', 'p1', ids(MAX_ROW_DOCUMENT_IDS + 1)))).toBeUndefined()
  })

  it('keeps the frozen flag the API sends', () => {
    // The schema is a `z.object`, which STRIPS what it does not declare — so an
    // undeclared `is_frozen` parses fine and is silently discarded, and the page could
    // never learn a row was frozen with nothing failing to say so. That is the whole
    // reason the field has to be declared rather than left to arrive.
    expect(normalizeRow({ ...storedRow('r', 'p1', ['prd-1']), is_frozen: true })?.is_frozen)
      .toBe(true)
    expect(normalizeRow({ ...storedRow('r', 'p1', ['prd-1']), is_frozen: false })?.is_frozen)
      .toBe(false)
  })

  it('reads an unstated or unreadable frozen flag as NOT frozen', () => {
    // The direction matters. `is_frozen` only decides whether a control is OFFERED —
    // the freeze itself is a condition on the write, which answers 409 whatever this
    // said. Defaulting to `true` would hide a control on a row that is perfectly
    // editable with nothing explaining why; defaulting to `false` offers one whose
    // request the server refuses with a reason the page can state.
    for (const value of [undefined, null, 'yes', 1, {}]) {
      expect(normalizeRow({ ...storedRow('r', 'p1', ['prd-1']), is_frozen: value })?.is_frozen)
        .toBe(false)
    }
  })
})

describe('ownBallotRead resolves the caller own half once, for all three consumers', () => {
  // The sliders, the save guard and the panel's wording are one question. Asked separately,
  // the guard read the caller's ballots while the panel read the TEAM map — so a response
  // with readable aggregates and unreadable ballots said "no need to reload before saving"
  // beside a disabled Save.
  const ballots = { d1: { ...DEFAULT_SCORE, row_id: 'd1', impact: 4 } }

  it('has the ballots in hand when the response carried a readable map', () => {
    expect(ownBallotRead({ failed: false, arrived: true, ballots: ballots })).toStrictEqual({
      ballots, inHand: true, needsPanel: false,
    })
  })

  it('counts an empty map as in hand — that is the first-ballot case', () => {
    expect(ownBallotRead({ failed: false, arrived: true, ballots: {} })).toStrictEqual({
      ballots: {}, inHand: true, needsPanel: false,
    })
  })

  it('keeps retained ballots through a failed refetch, and says the read failed', () => {
    // In hand AND a panel: the numbers are the reviewer's own, so the save stands, and the
    // panel says the latest read failed. This is the pair that must not contradict.
    expect(ownBallotRead({ failed: true, arrived: true, ballots: ballots })).toStrictEqual({
      ballots, inHand: true, needsPanel: true,
    })
  })

  it('asks for a panel when the response ARRIVED with no readable ballots', () => {
    // Used to be silent: sliders on defaults, Save disabled, nothing on screen.
    expect(ownBallotRead({ failed: false, arrived: true, ballots: undefined })).toStrictEqual({
      ballots: {}, inHand: false, needsPanel: true,
    })
  })

  it('stays silent while the first read is still in flight', () => {
    // Nothing has gone wrong and it clears itself, so no panel — but no save either.
    expect(ownBallotRead({ failed: false, arrived: false })).toStrictEqual({
      ballots: {}, inHand: false, needsPanel: false,
    })
  })

  it('asks for a panel when the first read failed outright', () => {
    expect(ownBallotRead({ failed: true, arrived: false })).toStrictEqual({
      ballots: {}, inHand: false, needsPanel: true,
    })
  })

  it('ties inHand to the ballots themselves across every combination of inputs', () => {
    // The invariant the carried finding was about: `inHand` decides BOTH the save and the
    // wording, so it must track the ballots and nothing else — not the failure flag, and
    // not the team map (which is not even an input here, which is the point).
    for (const failed of [false, true]) {
      for (const arrived of [false, true]) {
        for (const ballotsIn of [undefined, {}, ballots]) {
          const state = ownBallotRead({ failed, arrived, ballots: ballotsIn })
          const label = `failed=${failed} arrived=${arrived} ballots=${JSON.stringify(ballotsIn)}`

          expect(state.inHand, label).toBe(ballotsIn !== undefined)
          // And when they are not in hand there is nothing to render but defaults.
          expect(state.ballots, label).toStrictEqual(ballotsIn ?? {})
        }
      }
    }
  })
})

describe('normalizeScores validates the caller own half of the response too', () => {
  // The half that used to be passed through untouched. A `=== undefined` check on the
  // field caught an OMITTED `scores` and nothing else, so a null or non-object one left
  // every slider on DEFAULT_SCORE with the save offered.
  it('answers undefined for a container that is not a map', () => {
    for (const raw of [null, undefined, 'nope', 42, true]) {
      expect(normalizeScores(raw), String(raw)).toBeUndefined()
    }
  })

  it('tells an arrived-but-empty map apart from no map at all', () => {
    // The distinction the save guard turns on: `{}` is "you have no ballot yet", which
    // must stay saveable, and `undefined` is "we have nothing to show you".
    expect(normalizeScores({})).toStrictEqual({})
    expect(normalizeScores({})).not.toBeUndefined()
  })

  it('keeps a readable ballot as sent', () => {
    const scores = normalizeScores({
      d1: {
        row_id: 'd1', impact: 5, time_to_market: 2, confidence: 3, strategic_fit: 4, notes: 'mine',
      },
    })

    expect(scores?.d1).toStrictEqual({
      row_id: 'd1', impact: 5, time_to_market: 2, confidence: 3, strategic_fit: 4, notes: 'mine',
    })
  })

  it('drops an unreadable ROW instead of inventing a stored ballot for it', () => {
    // On screen this is indistinguishable from coercing the row to DEFAULT_SCORE — the
    // sliders show the same defaults either way, because `getScore` answers those for a
    // key it does not hold, and the save guard is about the MAP. What it changes is the
    // map: coercing put a value nobody stored under a real key, which `applyBallotEdits`
    // merges and any "documents I have scored" count would read as a ballot.
    const scores = normalizeScores({ d1: 'not an object', d2: { impact: 4 } })

    expect(scores).not.toBeUndefined()
    expect(Object.hasOwn(scores ?? {}, 'd1')).toBe(false)
    // The readable sibling survives — one bad row does not take the response with it.
    expect(entryOf(scores, 'd2').impact).toBe(4)
    // And the dropped row still reads as the display defaults through `getScore`.
    expect(getScore(scores ?? {}, 'd1')).toStrictEqual({ ...DEFAULT_SCORE, row_id: 'd1' })
  })

  it('drops a row that stored nothing readable, which the per-field catches let through', () => {
    // The floor the schema cannot enforce: every field carries `.catch()`, so `{}` and
    // `{impact: 'high'}` PARSE successfully into a full DEFAULT_SCORE-shaped row. Without
    // the floor, "an unreadable row is dropped" was true only of a non-object.
    const scores = normalizeScores({
      empty: {}, junkAxis: { impact: 'high' }, real: { impact: 0 },
    })

    expect(Object.keys(scores ?? {})).toStrictEqual(['real'])
    // `0` is a readable number and a legitimate lowest score, so that row stays.
    expect(entryOf(scores, 'real').impact).toBe(0)
  })

  it('keeps a NOTE-only ballot, because PATCH lets a reviewer store one', () => {
    // `_ballot_update_kwargs` assigns only the fields an entry carries, so a reviewer who
    // wrote a justification without moving a slider has exactly this row stored. Dropping
    // it for having no axis would lose their words.
    const ballot = entryOf(normalizeScores({ d1: { notes: 'blocked on legal' } }), 'd1')

    expect(ballot.notes).toBe('blocked on legal')
    expect(ballot.impact).toBe(DEFAULT_SCORE.impact)
  })

  it('keeps only the fields this page accepts, not whatever the wire sent', () => {
    // `z.object` rather than `looseObject`: an unknown field used to ride into every
    // `PrioritizationScore` and on through `applyBallotEdits`.
    const scores = normalizeScores({
      d1: {
        impact: 4, time_to_market: 3, confidence: 2, strategic_fit: 1, notes: '', surprise: 'x',
      },
    })

    expect(Object.hasOwn(scores?.d1 ?? {}, 'surprise')).toBe(false)
    expect(Object.keys(scores?.d1 ?? {}).sort(byLocale))
      .toStrictEqual(['confidence', 'impact', 'notes', 'row_id', 'strategic_fit', 'time_to_market'])
  })

  it('degrades an unreadable AXIS and clamps an out-of-range one', () => {
    const scores = normalizeScores({
      d1: {
        impact: 'high', time_to_market: 99, confidence: -4, strategic_fit: 3, notes: 7,
      },
    })

    expect(scores?.d1).toMatchObject({
      impact: DEFAULT_SCORE.impact, time_to_market: 5, confidence: 0, strategic_fit: 3, notes: '',
    })
  })

  it('takes row_id from the map KEY, not from the entry', () => {
    // Every lookup on this page is by key, so an entry disagreeing with its own key
    // would otherwise produce a ballot that cannot be found. The key is the ROW now,
    // and a stored `document_id` from the pre-row shape must not be read as one.
    expect(entryOf(normalizeScores({ d1: { row_id: 'somewhere-else', impact: 2 } }), 'd1').row_id)
      .toBe('d1')
    expect(entryOf(normalizeScores({ d1: { document_id: 'a-document', impact: 2 } }), 'd1').row_id)
      .toBe('d1')
  })

  it('leaves a stored note longer than the API now accepts alone', () => {
    // The bound arrived after the data. Truncating on READ would silently rewrite a
    // reviewer's justification; refusing to SEND one is `overLongNoteRows`' job.
    const long = 'x'.repeat(MAX_NOTE_LENGTH + 50)

    expect(entryOf(normalizeScores({ d1: { notes: long } }), 'd1').notes).toBe(long)
  })
})
