/**
 * Whether a row's documents tell one story, and whether a frozen row's story has
 * been overtaken.
 *
 * REVERT MAP — which case catches which branch of `rowLineage.ts` going back:
 *
 *  * `repeatsAType` deleted → "two versions of one type cross generations", and
 *    "a repeated type outranks a coherent-looking derivation" (which pins the
 *    ORDER, not just the rule);
 *  * `hasSupersededSource` deleted → "a document built from another generation of
 *    a type the row also holds crosses generations";
 *  * its `!selectedIds.has(...)` guard deleted → "a row holding a document and its
 *    own successor is coherent" (the regenerated-PRD case, which that guard is the
 *    whole of);
 *  * its `source.document_type !== null` guard deleted → "an unresolved source
 *    decides nothing";
 *  * its "OTHER documents" narrowing widened to every selected document → "a
 *    single document built from an earlier one of its own type is coherent";
 *  * its `held.type !== ''` exclusion from `otherTypes` dropped → "an unreadable
 *    source type does not cross with an unreadable held type";
 *  * `recordsNoLineage` changed from `every` to `some` → "one document recording
 *    its inputs is lineage the row can be judged on";
 *  * `recordsNoLineage` deleted → "documents that record nothing read as absent,
 *    not coherent";
 *  * the `is_frozen` gate in `rowLineageOf` deleted → "an un-frozen row is never
 *    stale";
 *  * the candidate condition in `fresherCoherentSelection` deleted → "a fresher
 *    combination that itself crosses generations does not make a row stale";
 *  * that condition tightened from `=== 'crossGeneration'` back to
 *    `!== 'coherent'` → "marks a row stale on a project where NO document records
 *    its lineage" (the pre-`derivation` population, for which requiring a
 *    `coherent` candidate withheld staleness unconditionally). The two directions
 *    are pinned by separate cases, and each stays green under the other's revert;
 *  * the `regressed` condition deleted → "a candidate that is older in one type is
 *    not fresher";
 *  * the same-combination early return deleted → "a frozen row holding the newest
 *    of each type is current";
 *  * the per-type expectation widened to "every scorable type the project holds" →
 *    "a project's first document of a new type does not make an existing row
 *    stale" (the missing-optional-document boundary);
 *  * the `rankOf` id tie-break deleted → "documents sharing a timestamp compare by
 *    id, in both array orders";
 *  * `rankOf`'s `instantOf` reverted to the raw `created_at` string → "compares the
 *    INSTANT a timestamp names, not the string that spells it" (all three halves),
 *    plus the offset half of the tie-break case and the unparseable half of the
 *    no-instant case;
 *  * `instantOf` reading the timestamp's own fields replaced by `Date.parse` on
 *    the raw value → "answers the same in every timezone, because a zone-less
 *    datetime is UTC" (the only case here whose failure depends on WHO is looking
 *    rather than on the record). Both halves are separately revert-sensitive: the
 *    ISO zone-less assertions fail if the offset is taken from the runtime, and the
 *    non-ISO ones fail if an unreadable spelling is allowed to decide;
 *  * `instantOf`'s grammar narrowed or widened → "reads every timestamp
 *    shape the system stores, and withholds on the rest", which is the boundary an
 *    allow-list has to pin from BOTH sides: narrowed, a real stored shape stops
 *    being read and staleness goes quietly silent;
 *  * `offsetMinutes`'s range check deleted → the same case's '+99:99' row (a typo
 *    read as 99 hours moves a document four days);
 *  * the `hasUnreadableTimestamp` gate deleted → "a held created_at that names no
 *    instant withholds staleness" (which is what stops `NO_INSTANT` reading as older
 *    than every dated document in the project);
 *  * `fresher` narrowed from `some` to `every` → "only ONE of its types has a newer
 *    version" (the case `lineage.staleReason`'s wording answers to);
 *  * `selectionEntry`'s id requirement deleted → "an unreadable document decides
 *    nothing".
 *
 * Legacy derivation shapes are covered throughout rather than in one case: they
 * are what `resolveDerivation` normalises, and the point is that this module never
 * asks which shape an answer came from. Every expectation is a literal.
 */
import { describe, it, expect } from 'vitest'
import {
  classifySelectionLineage,
  fresherCoherentSelection,
  LINEAGE_REASON_KEY,
  LINEAGE_STYLE,
  rowLineageOf,
} from './rowLineage'
import prioritizationEn from '../../../public/locales/en/prioritization.json'

/**
 * One project document, as the project read supplies it.
 *
 * `derivation` is passed through untouched so a case can hand a DECLARED map, a
 * legacy field, both, or neither — which is the whole point: the classifier reads
 * the contract's answer rather than a shape.
 */
const doc = (
  id: string,
  type: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
) => ({
  document_id: id,
  document_type: type,
  title: `${type} ${id}`,
  created_at: createdAt,
  ...extra,
})

/** A declared derivation naming one source in the reference role. */
const builtFrom = (...ids: readonly string[]) => ({
  derivation: {
    sources: ids.map((id) => ({ document_id: id, role: 'reference' })),
    selected_document_count: ids.length,
    feedback_count: 0,
    persona_ids: [],
    visual_document_ids: [],
    product_context_included: false,
  },
})

/** A derivation recording feedback and nothing else — lineage present, no source. */
const builtFromFeedback = {
  derivation: {
    sources: [],
    selected_document_count: 0,
    feedback_count: 12,
    persona_ids: [],
    visual_document_ids: [],
    product_context_included: false,
  },
}

describe('the lineage tables are complete and resolvable', () => {
  it('names every state and every reason with a key the catalogue holds', () => {
    // The positive control for every case below that reads a label: a table whose
    // keys resolved to nothing would still classify correctly and render raw key
    // paths to users. Resolved against the shipped English catalogue rather than
    // through `t`, so this is about the DATA and not about i18next's fallbacks.
    // `prioritization:` is stripped because the file IS that namespace.
    const lineage: Record<string, string> = prioritizationEn.lineage
    for (const style of Object.values(LINEAGE_STYLE)) {
      const key = style.labelKey.replace('prioritization:lineage.', '')
      expect(lineage[key], style.labelKey).toBeTruthy()
    }
    for (const { sentenceKey } of Object.values(LINEAGE_REASON_KEY)) {
      expect(lineage[sentenceKey.replace('prioritization:lineage.', '')], sentenceKey)
        .toBeTruthy()
    }
    // The stale copy is not in either table (staleness is a second axis, not a
    // state), so it is named here or nothing checks it exists.
    expect(lineage.stale).toBeTruthy()
    expect(lineage.staleReason).toBeTruthy()
    expect(lineage.staleAction).toBeTruthy()
  })
})

describe('a selection of documents reads as coherent, crossing generations, or unable to say', () => {
  it('reads a PRD and a PR/FAQ that record their inputs as one generation', () => {
    // The ordinary shape of the ordinary row: two documents generated from the same
    // feedback, neither naming the other. Coherent is "nothing contradicts one
    // chain", NOT "an edge links them" — requiring the edge would grey this row,
    // and a signal that is grey for everybody says nothing about anything.
    const prd = doc('prd_2', 'prd', '2025-03-01', builtFromFeedback)
    const prfaq = doc('prfaq_2', 'prfaq', '2025-03-01', builtFromFeedback)

    expect(classifySelectionLineage([prd, prfaq], [prd, prfaq])).toEqual({
      state: 'coherent',
      reason: 'oneChain',
    })
  })

  it('reads two versions of one document type as crossing generations', () => {
    const older = doc('prd_1', 'prd', '2025-01-01', builtFromFeedback)
    const newer = doc('prd_2', 'prd', '2025-03-01', builtFromFeedback)

    expect(classifySelectionLineage([newer, older], [newer, older])).toEqual({
      state: 'crossGeneration',
      reason: 'repeatedType',
    })
  })

  it('lets a repeated type outrank a derivation that would otherwise read as coherent', () => {
    // The ORDER, not just the rule. Both PRDs here record their inputs, so
    // `recordsNoLineage` is false and no source is superseded — every later rule
    // answers "coherent" — and yet one ballot covers two generations of a PRD.
    // Nothing a derivation map can say makes that one generation, which is why the
    // type rule is decided first and without reading a derivation at all.
    const older = doc('prd_1', 'prd', '2025-01-01', builtFromFeedback)
    const newer = doc('prd_2', 'prd', '2025-03-01', builtFromFeedback)
    const prfaq = doc('prfaq_1', 'prfaq', '2025-03-01', builtFromFeedback)

    expect(classifySelectionLineage([prfaq], [prfaq]).state).toBe('coherent')
    expect(classifySelectionLineage([prfaq, newer, older], [prfaq, newer, older]).state)
      .toBe('crossGeneration')
  })

  it('reads a document built from another generation of a type the row holds as crossing generations', () => {
    // The mismatch nothing on screen could show: this PR/FAQ was generated from PRD
    // 1, and the row pairs it with PRD 2. Both titles look right; the combination is
    // one generation apart.
    const prd1 = doc('prd_1', 'prd', '2025-01-01', builtFromFeedback)
    const prd2 = doc('prd_2', 'prd', '2025-03-01', builtFromFeedback)
    const prfaq = doc('prfaq_1', 'prfaq', '2025-02-01', builtFrom('prd_1'))

    expect(classifySelectionLineage([prfaq, prd2], [prd1, prd2, prfaq])).toEqual({
      state: 'crossGeneration',
      reason: 'supersededSource',
    })
    // The positive control: the same PR/FAQ WITH the PRD it names is coherent, so
    // the case above is the crossing and not the mere presence of a source.
    expect(classifySelectionLineage([prfaq, prd1], [prd1, prd2, prfaq]).state).toBe('coherent')
  })

  it('reads a row holding a document and its own successor as coherent', () => {
    // A regenerated PRD names the previous PRD as a source, so a row holding {PRD 2,
    // PR/FAQ 2} contains a document whose source has a type the row also holds — its
    // OWN. Compared against the other documents' types, nothing crosses: the row
    // holds the newer generation of exactly that type. Comparing against every
    // selected type instead marks the commonest row on the page as incoherent.
    const prd1 = doc('prd_1', 'prd', '2025-01-01', builtFromFeedback)
    const prd2 = doc('prd_2', 'prd', '2025-03-01', builtFrom('prd_1'))
    const prfaq = doc('prfaq_2', 'prfaq', '2025-03-01', builtFromFeedback)

    expect(classifySelectionLineage([prd2, prfaq], [prd1, prd2, prfaq]).state).toBe('coherent')
  })

  it('reads a single document built from an earlier one of its own type as coherent', () => {
    // The narrowing at its boundary: with one document selected there are no OTHER
    // types at all, so a PRD naming the previous PRD cannot cross with anything. A
    // rule that compared a document's sources against its own type would grey every
    // regenerated document scored on its own.
    const prd1 = doc('prd_1', 'prd', '2025-01-01', builtFromFeedback)
    const prd2 = doc('prd_2', 'prd', '2025-03-01', builtFrom('prd_1'))

    expect(classifySelectionLineage([prd2], [prd1, prd2]).state).toBe('coherent')
  })

  it('reads documents that record nothing as lineage-absent, not as coherent', () => {
    // The hand-authored row, and every row of every project created before the
    // `derivation` field existed. `absent` rather than `crossGeneration`, because
    // nothing is known to cross — and rather than `coherent`, because nothing
    // vouched for it either.
    const prd = doc('prd_1', 'prd', '2025-01-01')
    const prfaq = doc('prfaq_1', 'prfaq', '2025-01-01', { derivation: null })

    expect(classifySelectionLineage([prd, prfaq], [prd, prfaq])).toEqual({
      state: 'absent',
      reason: 'noneRecorded',
    })
  })

  it('judges the row on one document that records its inputs, even when its siblings record none', () => {
    // `every`, not `some`: a project mid-adoption holds documents on both sides of
    // the field, and one document recording its inputs is lineage the combination
    // can be judged on. Read the other way round, a single legacy sibling would send
    // every such row to "no lineage" and the signal would stay dark for the whole
    // adoption window.
    const legacyPrd = doc('prd_1', 'prd', '2025-01-01')
    const prfaq = doc('prfaq_1', 'prfaq', '2025-02-01', builtFromFeedback)

    expect(classifySelectionLineage([legacyPrd, prfaq], [legacyPrd, prfaq]).state).toBe('coherent')
  })

  it('reads the legacy lineage shapes exactly as it reads a declared derivation', () => {
    // `source_documents` on a merge output and `source_prd_id` on a prototype are
    // what `resolveDerivation` reconstructs a derivation from, and this module never
    // asks which shape an answer came from. A merge output built from PRD 1, in a row
    // holding PRD 2, crosses generations for the same reason the declared case does.
    const prd1 = doc('prd_1', 'prd', '2025-01-01')
    const prd2 = doc('prd_2', 'prd', '2025-03-01')
    const merged = doc('custom_1', 'custom', '2025-02-01', { source_documents: ['prd_1'] })

    expect(classifySelectionLineage([merged, prd2], [prd1, prd2, merged])).toEqual({
      state: 'crossGeneration',
      reason: 'supersededSource',
    })
    // And the same legacy shape naming a document the row also holds reads as one
    // chain — so the shape is being READ, not merely detected. Note both PRDs here
    // record nothing at all: the merge output's legacy field is the only lineage in
    // the row, which is exactly what keeps it out of `absent`.
    expect(classifySelectionLineage([merged, prd1], [prd1, prd2, merged]).state).toBe('coherent')
  })

  it('lets an unresolved source decide nothing', () => {
    // A source deleted since — or a project read that does not carry it — comes back
    // with `document_type: null` (the relation outlives its target). A type nobody
    // can read cannot be compared with the row's, so the crossing is withheld rather
    // than assumed. The positive control is the case above: the same shape WITH the
    // source resolvable does report the crossing.
    const prd2 = doc('prd_2', 'prd', '2025-03-01')
    const prfaq = doc('prfaq_1', 'prfaq', '2025-02-01', builtFrom('prd_deleted'))

    expect(classifySelectionLineage([prfaq, prd2], [prd2, prfaq]).state).toBe('coherent')
  })

  it('lets an unreadable document decide nothing', () => {
    // Nulls, strings and records with no id reach this from the wire. Each
    // contributes nothing rather than failing the row — the same tolerance the
    // derivation contract itself takes — and the readable documents still decide.
    const prd = doc('prd_1', 'prd', '2025-01-01', builtFromFeedback)
    // A record carrying a TYPE and no id is the case that needs the id rule: counted
    // in, it is a second document of that type and the row reads as crossing
    // generations — a state invented by a junk record, over a row holding one PRD.
    const idless = { document_type: 'prd', created_at: '2025-02-01' }

    expect(classifySelectionLineage([null, 'prd_1', {}, idless, prd], [prd]).state)
      .toBe('coherent')
    expect(classifySelectionLineage([], []).state).toBe('absent')
  })

  it('does not treat two documents of unreadable type as versions of one type', () => {
    // Grouping type-less records under '' would make unrelated documents each
    // other's generations — the trap `numberable` records for the ordinal. Both of
    // these record their inputs, so nothing else pulls them out of `coherent`.
    const a = doc('a', '', '2025-01-01', builtFromFeedback)
    const b = doc('b', '', '2025-01-02', builtFromFeedback)

    expect(classifySelectionLineage([a, b], [a, b]).state).toBe('coherent')
  })

  it('does not cross an unreadable source type with an unreadable held type', () => {
    // '' is not a type, on EITHER side of the comparison, and `null` is not its only
    // spelling: a source that resolved to a document whose `document_type` could not
    // be read comes back as '' (`sourceFieldIndex` runs it through `displayString`),
    // so an unfiltered `otherTypes` matches '' against '' and declares a crossing
    // between two documents neither of which was shown to be of the same kind — the
    // trap `repeatsAType` skips and the staleness gate withholds for.
    const typelessHeld = doc('x', '', '2025-01-01', builtFromFeedback)
    const typelessSource = doc('s', '', '2024-01-01', builtFromFeedback)
    const prd = doc('y', 'prd', '2025-02-01', builtFrom('s'))
    const project = [typelessHeld, typelessSource, prd]

    expect(classifySelectionLineage([typelessHeld, prd], project).state).toBe('coherent')
    // The positive control: the same shape with the SOURCE's type readable, and a held
    // document of that type, does report the crossing — so the case above is the ''
    // exclusion and not `hasSupersededSource` having stopped working.
    const readableSource = doc('s', 'prfaq', '2024-01-01', builtFromFeedback)
    const heldPrfaq = doc('x', 'prfaq', '2025-01-01', builtFromFeedback)
    expect(classifySelectionLineage([heldPrfaq, prd], [heldPrfaq, readableSource, prd]))
      .toEqual({ state: 'crossGeneration', reason: 'supersededSource' })
  })
})

describe('a frozen row is stale only when a real fresher coherent combination exists', () => {
  /** The two generations a staleness case needs, plus the row that holds the older. */
  const prd1 = doc('prd_1', 'prd', '2025-01-01', builtFromFeedback)
  const prfaq1 = doc('prfaq_1', 'prfaq', '2025-01-01', builtFromFeedback)
  const prd2 = doc('prd_2', 'prd', '2025-03-01', builtFromFeedback)
  const prfaq2 = doc('prfaq_2', 'prfaq', '2025-03-01', builtFromFeedback)
  const project = [prd1, prfaq1, prd2, prfaq2]

  const frozenRow = (documents: readonly unknown[]) => ({ is_frozen: true, documents })

  it('marks a frozen row stale and names the fresher combination', () => {
    const lineage = rowLineageOf(frozenRow([prd1, prfaq1]), project)

    expect(lineage.stale).toBe(true)
    // The ids, so the caller can name what to score without recomputing it — and in
    // the order the row's own types appear.
    expect(lineage.fresherDocumentIds).toEqual(['prd_2', 'prfaq_2'])
    // Still coherent and still described: staleness is a second axis, so a
    // superseded row that is internally consistent says so rather than being
    // relabelled as incoherent.
    expect(lineage.state).toBe('coherent')
  })

  it('marks a row stale when only ONE of its types has a newer version', () => {
    // What the rule actually decides, and what `lineage.staleReason` therefore has to
    // say: `fresher` is `some`, not `every`, so a row whose PRD gained a v2 while its
    // PR/FAQ did not IS stale — and the combination advised carries the row's own
    // unchanged PR/FAQ id, because "the newest of each type" answers that type with
    // the document the row already holds. A reviewer who opens this row sees the same
    // PR/FAQ they scored, so copy claiming every type is newer reads as a bug in the
    // badge.
    const lineage = rowLineageOf(frozenRow([prd1, prfaq1]), [prd1, prfaq1, prd2])

    expect(lineage.stale).toBe(true)
    expect(lineage.fresherDocumentIds).toEqual(['prd_2', 'prfaq_1'])
  })

  it('leaves a frozen row holding the newest of each type current', () => {
    const lineage = rowLineageOf(frozenRow([prd2, prfaq2]), project)

    expect(lineage.stale).toBe(false)
    expect(lineage.fresherDocumentIds).toEqual([])
  })

  it('never marks an UN-frozen row stale, however much newer the alternatives are', () => {
    // The row whose composition can still change has a better answer than "add a
    // row": edit this one. Same documents, same project, only the freeze differs —
    // so this is the gate and not the arithmetic.
    expect(rowLineageOf({ is_frozen: false, documents: [prd1, prfaq1] }, project).stale)
      .toBe(false)
    expect(rowLineageOf(frozenRow([prd1, prfaq1]), project).stale).toBe(true)
  })

  it('does not mark a row stale for a type it never held', () => {
    // The missing-optional-document boundary: a row scored on a PR/FAQ alone is
    // compared with the newest PR/FAQ alone. The project gaining its first PRD is
    // "you could have picked more", not "your evidence has been superseded", and
    // pointing a reviewer at a row they never composed is advice about a different
    // proposal.
    const prfaqOnly = [prfaq1, prd2]

    expect(rowLineageOf(frozenRow([prfaq1]), prfaqOnly).stale).toBe(false)
    // The positive control: the same row IS stale once a newer PR/FAQ exists, so the
    // case above is the type expectation and not staleness failing to fire at all.
    expect(rowLineageOf(frozenRow([prfaq1]), [prfaq1, prfaq2, prd2]).stale).toBe(true)
  })

  it('does not mark a row stale when the fresher combination itself crosses generations', () => {
    // "The newest of each type" is not automatically one generation: this project's
    // newest PR/FAQ was built from the OLD PRD, so the newest-of-each candidate
    // crosses generations. Trading a stale row for an incoherent one is not an
    // improvement, and it is the difference between "a real fresher coherent
    // combination" and "something newer exists".
    const crossingPrfaq2 = doc('prfaq_2', 'prfaq', '2025-03-01', builtFrom('prd_1'))
    const crossing = [prd1, prfaq1, prd2, crossingPrfaq2]

    expect(fresherCoherentSelection([prd1, prfaq1], crossing)).toBeNull()
    // The positive control: the same shape with a PR/FAQ built from the NEW PRD is a
    // fresher coherent combination.
    const coherentPrfaq2 = doc('prfaq_2', 'prfaq', '2025-03-01', builtFrom('prd_2'))
    expect(fresherCoherentSelection([prd1, prfaq1], [prd1, prfaq1, prd2, coherentPrfaq2]))
      .toEqual(['prd_2', 'prfaq_2'])
  })

  it('marks a row stale on a project where NO document records its lineage', () => {
    // The population that HAS stale frozen rows: a project several generations into a
    // PRD is a deployment old enough that its early documents predate the
    // `derivation` field, and a hand-authored document never had one. None of these
    // four carries `derivation` or any legacy lineage field, so both the row and the
    // newest-of-each candidate classify as `absent` — and requiring the candidate to
    // be `coherent` silenced staleness for the whole of that population.
    //
    // Deliberately NOT using `builtFromFeedback`: that fixture is what makes every
    // other candidate in this file `coherent`, so a case built on it cannot reach
    // this branch. The crossing case above keeps its own fixtures for the same
    // reason — the two rules are pinned separately, one per state that can appear
    // here.
    const legacyPrd1 = doc('legacy_prd_1', 'prd', '2024-01-01')
    const legacyPrfaq1 = doc('legacy_prfaq_1', 'prfaq', '2024-01-01')
    const legacyPrd2 = doc('legacy_prd_2', 'prd', '2025-06-01')
    const legacyPrfaq2 = doc('legacy_prfaq_2', 'prfaq', '2025-06-01')
    const legacy = [legacyPrd1, legacyPrfaq1, legacyPrd2, legacyPrfaq2]

    const lineage = rowLineageOf(frozenRow([legacyPrd1, legacyPrfaq1]), legacy)

    expect(lineage.stale).toBe(true)
    expect(lineage.fresherDocumentIds).toEqual(['legacy_prd_2', 'legacy_prfaq_2'])
    // The row's own state is unchanged by the fix and is asserted so the case cannot
    // be read as claiming absent lineage now reads as coherent: it does not. The
    // staleness axis simply stops being gated on it.
    expect(lineage.state).toBe('absent')
    expect(lineage.reason).toBe('noneRecorded')
    // A row holding the newest of each type on the SAME lineage-less project is still
    // current, so the assertions above are the arithmetic answering and not staleness
    // firing for anything `absent`.
    expect(rowLineageOf(frozenRow([legacyPrd2, legacyPrfaq2]), legacy).stale).toBe(false)
    // And a lineage-less candidate that CROSSES generations still withholds, which is
    // what keeps this one state looser rather than the condition removed: the row's
    // own PRD has a successor, but the newest PR/FAQ here declares it was built from
    // the OLD PRD — the only derivation record in the project.
    const crossingLegacyPrfaq2 = doc(
      'legacy_prfaq_2', 'prfaq', '2025-06-01', builtFrom('legacy_prd_1'),
    )
    expect(fresherCoherentSelection(
      [legacyPrd1, legacyPrfaq1],
      [legacyPrd1, legacyPrfaq1, legacyPrd2, crossingLegacyPrfaq2],
    )).toBeNull()
  })

  it('does not call a combination fresher when one of its documents is older', () => {
    // A candidate that merely DIFFERS is not fresher. Here the PR/FAQ the row holds
    // has since been REMOVED from the project, so the newest remaining PR/FAQ
    // predates it: the candidate is newer in one type and older in another — a
    // sideways move, and advising a reviewer to score it would trade evidence away.
    //
    // Reachable through this exported helper, and NOT through `rowLineageOf` on the
    // page: `collectRows` resolves a row's documents against the project read, so a
    // held document is always among the available ones there and the newest of its
    // type can never be older. Asserted at this seam because that is where the rule
    // lives — and because the argument for it is about the DATA, not about which of
    // two callers can produce it.
    const prfaq0 = doc('prfaq_0', 'prfaq', '2024-06-01', builtFromFeedback)

    expect(fresherCoherentSelection([prd1, prfaq1], [prd1, prd2, prfaq0])).toBeNull()
    // The positive control: with the row's own PR/FAQ still the newest, the same
    // shape IS a fresher combination — so the case above is the regression guard and
    // not the PR/FAQ having gone missing.
    expect(fresherCoherentSelection([prd1, prfaq1], [prd1, prd2, prfaq1]))
      .toEqual(['prd_2', 'prfaq_1'])
  })

  it('breaks a timestamp tie on document id, in both array orders', () => {
    // Two documents of one type CAN share a `created_at` (the defect
    // `byNewestFirst`'s equal arm exists for, one type over). With no tie-break, the
    // comparison answers "fresher" for whichever way round the read happened to
    // return them — so the very same frozen row would read as stale or as current
    // depending on the order of a list nobody controls.
    const sameInstant = '2025-01-01T09:00:00Z'
    const prdA = doc('prd_a', 'prd', sameInstant, builtFromFeedback)
    const prdB = doc('prd_b', 'prd', sameInstant, builtFromFeedback)

    for (const order of [[prdA, prdB], [prdB, prdA]]) {
      // `prd_b` sorts above `prd_a`, so the row holding `prd_a` is stale and the row
      // holding `prd_b` is current — in either order.
      expect(fresherCoherentSelection([prdA], order), JSON.stringify(order))
        .toEqual(['prd_b'])
      expect(fresherCoherentSelection([prdB], order), JSON.stringify(order)).toBeNull()
    }

    // AND THE TIE IS ON THE INSTANT, not on the string. `prd_a`'s moment is respelled
    // as an offset here — the SAME instant as `prd_b`'s Z form, so the id rule decides
    // and `prd_b` still wins. The two spellings do not tie as strings, and the one that
    // sorts higher as text is `prd_a`'s, which the id rule puts SECOND: a string
    // comparison therefore reverses this pair, and the row holding the winner reads as
    // superseded by the loser.
    const offsetA = doc('prd_a', 'prd', '2025-01-01T11:00:00+02:00', builtFromFeedback)
    expect(fresherCoherentSelection([offsetA], [offsetA, prdB])).toEqual(['prd_b'])
    expect(fresherCoherentSelection([prdB], [offsetA, prdB])).toBeNull()
  })

  it('withholds staleness for a row already holding two versions of one type', () => {
    // Such a row has no single "same expectations" candidate to compare with, and it
    // is already reported as crossing generations — which is the more useful thing to
    // say about it than "add a row for the newest of each".
    const lineage = rowLineageOf(frozenRow([prd1, prd2]), project)

    expect(lineage.state).toBe('crossGeneration')
    expect(lineage.stale).toBe(false)
  })

  it('compares the INSTANT a timestamp names, not the string that spells it', () => {
    // Lexicographic order equals instant order only while every `created_at` shares
    // one shape, and nothing enforces that: `create_document` takes the caller's
    // body, `manual_import_handler` writes an imported `timestamp` straight through,
    // and the frontend field is `z.string().catch('')`. One hand-created or imported
    // document mixes the shapes, and each half below is then answered BACKWARDS by a
    // string compare.
    //
    // Two spellings of ONE moment: '11:00:00+03:00' is 08:00Z, and the row holds the
    // 08:00Z document. Nothing newer exists, so nothing is advised — while as strings
    // '2025-03-10T11:00:00+03:00' > '2025-03-10T08:00:00Z' and the row would be told
    // it had been superseded by a copy of what it already holds.
    const zForm = doc('prd_z', 'prd', '2025-03-10T08:00:00Z', builtFromFeedback)
    const sameInstantOffset = doc('prd_a', 'prd', '2025-03-10T11:00:00+03:00', builtFromFeedback)

    expect(fresherCoherentSelection([zForm], [zForm, sameInstantOffset])).toBeNull()
    expect(rowLineageOf(frozenRow([zForm]), [zForm, sameInstantOffset]).stale).toBe(false)

    // An offset form whose instant is EARLIER than the row's: '23:00:00-05:00' on the
    // 10th is 04:00Z on the 11th, so the row holding it is current against a
    // 02:00Z-on-the-11th sibling. As strings the sibling sorts higher, so the module
    // would advise re-scoring against evidence two hours OLDER.
    const heldLater = doc('prd_held', 'prd', '2025-03-10T23:00:00-05:00', builtFromFeedback)
    const actuallyEarlier = doc('prd_other', 'prd', '2025-03-11T02:00:00+00:00', builtFromFeedback)

    expect(fresherCoherentSelection([heldLater], [heldLater, actuallyEarlier])).toBeNull()

    // The positive control, and the half that fails if the comparison is refused
    // rather than fixed: a genuinely newer instant in a DIFFERENT shape is still
    // fresher. '2025-03-11T09:00:00+00:00' is five hours after the held 04:00Z.
    const genuinelyNewer = doc('prd_new', 'prd', '2025-03-11T09:00:00+00:00', builtFromFeedback)
    expect(fresherCoherentSelection([heldLater], [heldLater, genuinelyNewer]))
      .toEqual(['prd_new'])
  })

  it('answers the same in every timezone, because a zone-less datetime is UTC', () => {
    // `Date.parse` splits its rules by SHAPE: per ECMA-262 a date-ONLY value is UTC,
    // but a date-TIME with no designator is the RUNTIME'S LOCAL time. Unnormalised,
    // the two order by up to ±14h of whichever timezone the reviewer's browser is in
    // — so the same project prints `Superseded` for one reviewer and not for another
    // off byte-identical records, and every answer in this module stops being a
    // property of the data. That is the one defect class the rest of the file
    // withholds precisely to avoid.
    //
    // Three zones, spanning the sign of the offset and its extreme: UTC itself, one
    // behind and the two furthest ahead. Each assertion is made in EVERY zone and
    // must agree, so the case pins zone-INDEPENDENCE rather than one zone's answer.
    const zones = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati']
    const inEveryZone = <T>(answer: () => T): readonly [string, T][] => {
      const before = process.env.TZ
      try {
        return zones.map((zone) => {
          process.env.TZ = zone
          return [zone, answer()] as const
        })
      } finally {
        process.env.TZ = before
      }
    }
    /** Asserts one answer is `expected` in all four zones, naming the zone that broke. */
    const agreesEverywhere = <T>(answer: () => T, expected: T): void => {
      for (const [zone, actual] of inEveryZone(answer)) {
        expect(actual, zone).toEqual(expected)
      }
    }

    // A zone-less datetime against a date-only value ON THE SAME DAY. '2025-01-01' is
    // 00:00Z, and '2025-01-01T09:00:00' means 09:00Z — so the datetime is newer, in
    // every zone. Unnormalised it is newer under TZ=UTC and Los Angeles but OLDER
    // under Kiritimati (+14), where local 09:00 is 19:00Z the previous day.
    const dateOnly = doc('prd_date_only', 'prd', '2025-01-01', builtFromFeedback)
    const zoneless = doc('prd_zoneless', 'prd', '2025-01-01T09:00:00', builtFromFeedback)

    agreesEverywhere(
      () => fresherCoherentSelection([dateOnly], [dateOnly, zoneless]),
      ['prd_zoneless'],
    )
    // And the other direction: holding the LATER of the two is never stale — the half
    // that catches the module advising strictly OLDER evidence, which is what
    // '2025-01-01T01:00:00' vs '2025-01-01' does under TZ=Asia/Tokyo unnormalised.
    const zonelessEarly = doc('prd_early', 'prd', '2025-01-01T01:00:00', builtFromFeedback)

    agreesEverywhere(() => fresherCoherentSelection([zonelessEarly], [zonelessEarly, dateOnly]), null)
    agreesEverywhere(() => rowLineageOf(frozenRow([zonelessEarly]), [zonelessEarly, dateOnly]).stale, false)

    // A realistic mix — a generated Z/offset form beside an imported zone-less one —
    // and the POSITIVE control this case needs: a zone-less datetime that is genuinely
    // newer IS advised, in every zone, so normalising to UTC has not simply silenced
    // the comparison. 18:00Z is six hours after the held 12:00Z.
    const generated = doc('prd_gen', 'prd', '2025-01-01T12:00:00+00:00', builtFromFeedback)
    const importedNewer = doc('prd_imported', 'prd', '2025-01-01T18:00:00', builtFromFeedback)

    agreesEverywhere(
      () => fresherCoherentSelection([generated], [generated, importedNewer]),
      ['prd_imported'],
    )
    // The space-separated spelling of the same value, because an imported timestamp
    // is as likely to arrive as '2025-01-01 18:00:00' as with a 'T'.
    const importedSpaced = doc('prd_imported', 'prd', '2025-01-01 18:00:00', builtFromFeedback)

    agreesEverywhere(
      () => fresherCoherentSelection([generated], [generated, importedSpaced]),
      ['prd_imported'],
    )
    // Guard against the whole case being vacuous: if `process.env.TZ` were NOT honoured
    // at runtime, every zone above would trivially agree and the case would pass with
    // the normalisation removed. This asserts the mechanism the case rests on — that a
    // zone-less datetime really is read differently per zone by `Date.parse` itself.
    const parsedPerZone = inEveryZone(() => Date.parse('2025-01-01T09:00:00'))
    expect(new Set(parsedPerZone.map(([, instant]) => instant)).size).toBeGreaterThan(1)

    // AND THE SPELLINGS OUTSIDE ISO-8601, which are the half a shape allow-list
    // cannot finish. `Date.parse` accepts both of these and reads both as the
    // runtime's local time, so a rule that repaired only the ISO zone-less form left
    // them reader-dependent: the same frozen row was stale under UTC and Los Angeles
    // and current under Tokyo and Kiritimati. Read from the grammar instead, they name
    // no instant, so `hasUnreadableTimestamp` withholds — one row's staleness silenced
    // rather than answered differently per reader. Asserted as `false` in EVERY zone,
    // which is the property; that the answer is the withhold is asserted below.
    for (const spelling of ['2025/01/01 09:00:00', 'January 1, 2025 09:00:00']) {
      const nonIso = doc('prd_non_iso', 'prd', spelling, builtFromFeedback)

      agreesEverywhere(() => fresherCoherentSelection([generated], [generated, nonIso]), null)
      // Held rather than offered, the same way round: an unreadable held timestamp
      // withholds, so the row is not advised toward the dated sibling either.
      agreesEverywhere(() => fresherCoherentSelection([nonIso], [nonIso, generated]), null)
    }
    // Non-vacuity for the pair above, and the reason they are `null` rather than
    // agreeing by luck: `Date.parse` really does read each of them, and really does
    // read them differently per zone — so without the grammar they are decisive AND
    // reader-dependent, not merely ignored.
    for (const spelling of ['2025/01/01 09:00:00', 'January 1, 2025 09:00:00']) {
      const perZone = inEveryZone(() => Date.parse(spelling))
      expect(perZone.every(([, instant]) => !Number.isNaN(instant)), spelling).toBe(true)
      expect(new Set(perZone.map(([, instant]) => instant)).size, spelling).toBeGreaterThan(1)
    }
  })

  it('reads every timestamp shape the system stores, and withholds on the rest', () => {
    // The grammar's BOUNDARY, in one table, because it is an allow-list and the cost of
    // narrowing it too far is silence rather than a wrong answer — silence nothing else
    // in this file would notice. Every shape a `created_at` actually reaches storage as
    // must be READ, or a real project's rows quietly stop reporting staleness at all.
    //
    // Each shape is offered as the newer document beside a 2000 baseline, so `['newer']`
    // means "read as an instant and compared" and `null` means "named no instant, so
    // staleness was withheld" — the two outcomes the grammar chooses between.
    const baseline = doc('base', 'prd', '2000-01-01T00:00:00Z', builtFromFeedback)
    const readsAs = (createdAt: string): readonly string[] | null => {
      const newer = doc('newer', 'prd', createdAt, builtFromFeedback)
      return fresherCoherentSelection([baseline], [baseline, newer])
    }

    // READ: what the generators write (`isoformat()` with microseconds and a +00:00
    // offset), its 'Z' spelling, the date-only form, the space-separated form an import
    // carries, a minute-precision clock, and the three offset spellings ISO allows.
    for (const stored of [
      '2025-01-01',
      '2025-01-01T09:00:00.123456+00:00',
      '2025-01-01T09:00:00.123Z',
      '2025-01-01T09:00:00Z',
      '2025-01-01T09:00:00',
      '2025-01-01 09:00:00',
      '2025-01-01T09:00',
      '2025-01-01T09:00:00+03:00',
      '2025-01-01T09:00:00+0300',
      '2025-01-01T09:00:00-05',
    ]) {
      expect(readsAs(stored), stored).toEqual(['newer'])
    }

    // WITHHELD: the two zone-less non-ISO spellings `Date.parse` would read as local
    // time (the reader-dependence this grammar exists to end), a word, '', fields the
    // shape admits but the calendar does not, an offset out of range — which no shape
    // check can reject and which as 99 hours would move a document four days — and
    // spellings this system never writes.
    for (const stored of [
      '2025/01/01 09:00:00',
      'January 1, 2025 09:00:00',
      'unknown',
      '',
      '2025-13-01T00:00:00Z',
      '2025-01-01T25:00:00Z',
      '2025-01-01T09:00:00+99:99',
      '2025-01-01T09:00:00XYZ',
      '2025-01-01T09:00:00 extra',
      '2025-1-1',
      '20250101T090000Z',
    ]) {
      expect(readsAs(stored), stored).toBeNull()
    }
  })

  it('withholds staleness when a held document has no readable type', () => {
    // A type nobody can read states no expectation, so there is nothing to look up the
    // project's newest of. Left in, the empty type MATCHES the project's other
    // type-less records — so the newer of the two below would be advised as "the newer
    // version of this document type", over two documents neither of which was shown to
    // be of the same kind. That is the same trap `repeatsAType` skips, on the staleness
    // side.
    const typeless = doc('mystery', '', '2025-01-01', builtFromFeedback)
    const otherTypeless = doc('other_mystery', '', '2025-06-01', builtFromFeedback)

    expect(fresherCoherentSelection([typeless], [typeless, otherTypeless, prd2])).toBeNull()
  })

  it('withholds staleness when a held created_at names no instant', () => {
    // A timestamp naming no instant ranks below every DATED document of its type —
    // including much older ones. Ranked rather than refused, this row is told its
    // evidence was superseded by a document from 2020 and its reviewer is sent to
    // re-score against it. An unreadable field decides nothing here, exactly as it
    // decides nothing about type.
    //
    // BOTH SPELLINGS of "no instant", because the gate is `Date.parse` and not an
    // emptiness check: '' is what `displayString` collapses absent/null/non-string
    // into, and a non-empty value no reader could call a date is the other half — a
    // string compare would have ranked 'unknown' ABOVE every ISO timestamp, since 'u'
    // sorts after a digit, and reported the row current while advising nothing.
    const dateless = doc('nd', 'prd', '', builtFromFeedback)
    const ancient = doc('old_prd', 'prd', '2020-01-01', builtFromFeedback)

    expect(fresherCoherentSelection([dateless], [dateless, ancient])).toBeNull()
    expect(rowLineageOf(frozenRow([dateless]), [dateless, ancient]).stale).toBe(false)
    const unparseable = doc('nd', 'prd', 'unknown', builtFromFeedback)
    expect(fresherCoherentSelection([unparseable], [unparseable, ancient])).toBeNull()
    // The positive control, in two halves. Once the row's own timestamp is readable
    // and genuinely older, the same shape IS stale — so the case above is the gate and
    // not staleness failing to fire.
    const dated = doc('nd', 'prd', '2019-01-01', builtFromFeedback)
    expect(fresherCoherentSelection([dated], [dated, ancient])).toEqual(['old_prd'])
    // The candidate's side needs no gate of its own, and this is the case that shows
    // why: a date-less project document can still be the newest of its type
    // (`newestOfType` ranks it last, so it wins only a type nothing else answers), and
    // it then LOSES `isNewer` against the row's readable timestamp — so `regressed`
    // already withholds. A second gate there would be unreachable, which is why
    // `fresherCoherentSelection` argues the point in a comment instead of adding one.
    const datelessPrfaq = doc('nd_prfaq', 'prfaq', '', builtFromFeedback)
    expect(fresherCoherentSelection([prd1, prfaq1], [prd1, prd2, datelessPrfaq]))
      .toBeNull()
  })

  it('withholds staleness when the project read has not landed', () => {
    // `collectRows` passes the project's documents, which are empty until the fan-out
    // resolves. No candidate can be formed from nothing, and a frozen row must not
    // flicker through "superseded" on the way to being described.
    expect(rowLineageOf(frozenRow([prd1, prfaq1]), []).stale).toBe(false)
  })
})
