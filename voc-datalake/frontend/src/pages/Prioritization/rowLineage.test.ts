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
 *  * `recordsNoLineage`'s `selectionEntry` filter dropped → "lets an unreadable
 *    document decide nothing", on its last assertion. That filter is what stops one
 *    id-less record carrying a derivation casting the deciding "something can speak"
 *    vote and turning an `absent` row `coherent`; the two-document `absent` baseline
 *    beside it is the control, asserted FIRST so it is shown to hold;
 *  * the `is_frozen` gate in `rowLineageOf` deleted → "an un-frozen row is never
 *    stale";
 *  * the `composition_truncated` gate in `rowLineageOf` deleted → "does not mark a row
 *    stale when its stored composition did not fully resolve", whose positive control
 *    (the same selection with the flag absent, asserted FIRST) stays green, so the
 *    case pins the gate and not the arithmetic. Its other half — `collectRows`
 *    actually PASSING the flag — is pinned in `Prioritization.lineage.test.tsx`,
 *    because a gate nothing feeds is a gate that never fires;
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
 *  * `fresher`/`regressed` in `fresherCoherentSelection` changed back from `instantOf`
 *    to `isNewer(rankOf(...))` → "withholds staleness on a tie the project read does
 *    not carry the held document for", and ONLY that case. The tie-preference below
 *    substitutes the held document for a tied newest, so everywhere else
 *    `chosen[index]` IS `selected[index]` and the two comparisons cannot disagree
 *    about a document compared with itself — which is why "withholds staleness on a
 *    timestamp tie, in both array orders" does NOT catch this revert (measured: it
 *    stays green, along with all 438 cases in `src/pages/Prioritization`). The one
 *    input that reaches the verdict's tie is a held document the project read is
 *    missing, which `byId.has` declines to substitute. Its positive control — a
 *    genuinely newer sibling on the same shape — is asserted FIRST and stays green
 *    under the revert, so the case pins the tie and not the arithmetic;
 *  * the tie-preference over `newestOfType`'s answer deleted (`chosen` taken straight
 *    from `newest`) → "keeps the held document for a type whose newest only ties, in
 *    both array orders", whose two positive controls — a genuinely newer document of
 *    the same type, and the no-tie shape — both stay green under that revert, so the
 *    case pins the substitution and not the newest-of-each arithmetic;
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
 *  * `restoreZone`'s `delete` branch dropped (assigning an absent `TZ` back, which
 *    stores the STRING 'undefined' and resolves to UTC) → the same case's restore
 *    assertion. It is the one assertion here about the HARNESS rather than the module:
 *    a `TZ` left pinned to UTC changes every later assertion in this case. It forces
 *    `TZ` unset before asserting, because that is the only ambient state the asymmetry
 *    is observable in — this container's own zone is UTC, which is what hid it. The
 *    cross-FILE version of that hazard is inert on the installed runner; see
 *    `restoreZone`'s docstring for the measurement and the condition that revives it;
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
 *    nothing";
 *  * any two `LINEAGE_REASON_KEY` entries cross-wired → "gives each reason the sentence
 *    that describes IT". `tsc` pins that table's COVERAGE (a `Record` over the union)
 *    and "names every state and every reason with a key the catalogue holds" pins that
 *    each key RESOLVES; neither pins the MAPPING, and before this case three of the four
 *    could be cross-wired with 881 tests green (measured) — a row printing another
 *    state's sentence under its own badge. Sensitive to both a two-way swap (each reason
 *    is asserted on a phrase only its own copy carries) and a collapse onto one key (the
 *    four sentences must be distinct). It also pins that `supersededSourceReason` claims
 *    no DIRECTION, which is the assertion that catches the copy regressing: the rule
 *    compares a source's TYPE and never an order, so it reports the same reason when the
 *    source is the LATER version, and directional copy is false for that half — in
 *    ENGLISH only, which is why the case below it exists;
 *  * `lineage.supersededSourceReason` going directional again in any ONE of the other
 *    seven catalogues → "claims no DIRECTION for supersededSource in any of the eight
 *    catalogues". The case above it reads `prioritizationEn` alone, so seven eighths
 *    of that copy fix was unpinned: measured, restoring the directional German
 *    wording left `src/pages/Prioritization src/i18n` green at 506 tests, because
 *    `localeParity` compares key SETS and `i18n:check` reports a non-English string
 *    only when it is byte-identical to English. The property is language-independent
 *    (it is a fact about `hasSupersededSource`, not about English), so it is asserted
 *    per locale, driven by `supportedLanguages` so a ninth catalogue fails to compile
 *    rather than going unchecked;
 *  * `lineage.coherentReason` losing the qualifier that scopes the crossing to another
 *    document IN THE ROW → "gives each reason the sentence that describes IT" for
 *    English, and "scopes coherentReason to another document IN THE ROW in all eight
 *    catalogues" for every locale. `OWN_PHRASE.oneChain` cannot catch this: both the
 *    unqualified and the scoped wording open with "Nothing in this row crosses
 *    generations", so the phrase matches either, and it cannot be REPLACED by the
 *    scope clause because that clause is shared with `supersededSourceReason` while
 *    the phrases must be unique per reason to catch a two-way swap. Measured before
 *    these assertions existed: restoring the unqualified English wording left
 *    `src/pages/Prioritization src/i18n` green at 507 tests, and the German
 *    equivalent likewise. Pinned as a PAIR, the shape the `staleReason` case uses —
 *    the qualifier the fix added, plus the unqualified sentence a widening would
 *    reintroduce, asserted with its terminating period — because either half alone is
 *    satisfiable by a reword that keeps the overclaim or drops the promise;
 *  * the `repeatsAType` guard in `fresherCoherentSelection` WIDENED to every
 *    `crossGeneration` row (gating on the classification instead) → "DOES mark a
 *    supersededSource row stale, unlike its repeatedType sibling", and only that case
 *    (measured: 1 failed / 444 passed in `src/pages/Prioritization`, with the failure
 *    landing on the `stale` assertion, so the sibling control asserted FIRST is shown
 *    to have run and stayed green). The two reasons that both answer `crossGeneration`
 *    diverge on purpose and this is the only thing pinning the half that does NOT
 *    withhold; the other half is "withholds staleness for a row already holding two
 *    versions of one type", which stays green under this widening (measured) — the
 *    widening makes BOTH rows withhold, so only a case asserting a row that must NOT
 *    withhold can see it. The reverse does not hold and is not claimed: removing the
 *    refusal of a crossing candidate turns this case red too, through its sibling
 *    control (measured, at the `toBe(false)` on line 818), which is the correct
 *    sensitivity for a control — it asserts a real behaviour and fails when that
 *    behaviour breaks;
 *
 *    NOTE THE DIRECTION: this entry names a WIDENING, not a deletion, because
 *    DELETING `repeatsAType` from `fresherCoherentSelection` is a measured NOOP — the
 *    doubled candidate such a row produces classifies `repeatedType` on its own
 *    account, so the fifth condition refuses it anyway (measured: 445/445 green with
 *    the call removed). Both guards must go before "withholds staleness for a row
 *    already holding two versions" turns red. Recorded because an entry claiming the
 *    deletion is caught would be false, which is the failure the map exists to avoid;
 *
 * TWO CASES PIN A BOUNDARY RATHER THAN A BRANCH, and are deliberately NOT in the map
 * above: "reads only a document's OWN sources, so a crossing two hops out is not
 * reported" and "advises a candidate that crosses generations only two hops out,
 * because the check is depth-1". Their SUBJECT assertion — the two-hop shape reading
 * coherent, and its candidate being advised — is not revert-sensitive at all, because
 * it asserts what the rule does NOT see: no deletion can make an unseen crossing
 * seen. That is the point, and it is why they are listed apart from a map whose every
 * other entry names a branch.
 *
 * MEASURED, so the distinction is not taken on trust: breaking `hasSupersededSource`
 * does turn both cases red, and in both it is the one-hop CONTROL that fails (the
 * classifier case on `crossGeneration`/`supersededSource`, the advisory case on
 * `toBeNull`) while the depth assertion beside it stays green. So each case fails
 * loudly if the rule stops working and says nothing if only the depth changes — which
 * is the correct sensitivity for a case documenting scope, and the reason each carries
 * the shorter control at all.
 *
 * They exist because that depth is a CHOICE rather than an oversight: traversing greys
 * the ordinary regenerated row (measured, and argued at `hasSupersededSource`), the
 * second case reaches a user-facing ADVISORY rather than a label, and
 * `lineage.staleReason`'s wording is scoped to exactly this limit.
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
import type { LineageReason } from './rowLineage'
import { supportedLanguages, type SupportedLanguage } from '../../i18n/languages'
import prioritizationEn from '../../../public/locales/en/prioritization.json'
// The other seven catalogues, imported statically rather than read from disk so a
// locale cannot be silently skipped the way a glob or a dynamic path could, and so
// `tsc` sees the table below is total over `SupportedLanguage`. Follows the
// precedent `DataSourceWizard/localization.test.tsx` set for the same reason.
import prioritizationDe from '../../../public/locales/de/prioritization.json'
import prioritizationEs from '../../../public/locales/es/prioritization.json'
import prioritizationFr from '../../../public/locales/fr/prioritization.json'
import prioritizationJa from '../../../public/locales/ja/prioritization.json'
import prioritizationKo from '../../../public/locales/ko/prioritization.json'
import prioritizationPt from '../../../public/locales/pt/prioritization.json'
import prioritizationZh from '../../../public/locales/zh/prioritization.json'

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

  it('keeps staleReason\'s claim scoped to the DIRECT crossing the rule checks', () => {
    // Truthiness is all the case above asks of this sentence, and truthiness is what
    // let three successive versions of the coherent copy ship claims the rule does not
    // verify. This one is worth a stronger check because it is the wording that closes
    // a boundary rather than describing one: the candidate check is depth-1, so a
    // fresher combination whose PR/FAQ descends from the row's own PRD generation VIA a
    // research report IS advised (pinned by "advises a candidate that crosses
    // generations only two hops out"). The sentence therefore has to promise the direct
    // relation and not a general absence of crossing.
    const reason: string = prioritizationEn.lineage.staleReason

    expect(reason).toContain('directly')
    // And it must NOT make the unqualified claim the depth cannot support. Asserted as
    // the exact phrase a widening would reintroduce, since that is the one this line
    // replaced.
    expect(reason).not.toContain('does not cross generations')
  })

  it('gives each reason the sentence that describes IT', () => {
    // `tsc` pins the table's COVERAGE — a `Record` over `LineageReason` means a fifth
    // reason must be given a sentence to compile — and the case above pins that each
    // key RESOLVES. Neither pins the MAPPING, so three of the four could be cross-wired
    // and a row would describe itself with another state's words: a row holding two PRDs
    // printing "None of these documents records what it was built from" under a
    // `Crosses generations` badge, which is the conflation `LineageReason` exists to end
    // ("a reader can act on the difference").
    //
    // Data-driven over the table so a fifth reason has to be given an expectation here
    // too, and resolved against the shipped English catalogue rather than through `t`,
    // matching the case above: this is about the DATA, not i18next's fallbacks.
    const lineage: Record<string, string> = prioritizationEn.lineage
    const sentenceOf = (reason: LineageReason) => lineage[
      LINEAGE_REASON_KEY[reason].sentenceKey.replace('prioritization:lineage.', '')
    ]
    // A phrase only that reason's own copy carries. `supersededSource` is asserted on
    // 'different generation' and NOT on 'earlier': the rule compares a source's TYPE
    // against the other selected documents' types and never a timestamp or an ordinal,
    // so it reports the same reason when the source is the LATER version — a row holding
    // PRD 1 beside a PR/FAQ built from the newer PRD 2. Directional copy is false for
    // exactly that half, which is why this sentence reads like `coherentReason`'s.
    const OWN_PHRASE: Record<LineageReason, string> = {
      oneChain: 'Nothing in this row crosses generations',
      repeatedType: 'more than one version of the same document type',
      supersededSource: 'was built from a different generation',
      noneRecorded: 'records what it was built from',
    }

    for (const [reason, phrase] of Object.entries(OWN_PHRASE) as [LineageReason, string][]) {
      expect(sentenceOf(reason), reason).toContain(phrase)
    }
    // And it must not claim a direction the rule does not compute.
    expect(sentenceOf('supersededSource')).not.toContain('earlier')
    // `oneChain`'s SCOPE, pinned separately from its phrase above and paired the way
    // the `staleReason` case is, because the phrase alone cannot see this. Both the
    // pre- and post-scoping wordings open with "Nothing in this row crosses
    // generations", so `OWN_PHRASE.oneChain` matches either and the qualifier that
    // narrowed the claim to what `hasSupersededSource` computes was unpinned in every
    // catalogue: measured, restoring the unqualified English sentence left
    // `src/pages/Prioritization src/i18n` green at 507 tests. It cannot BE that
    // phrase either — the scope clause is shared with `supersededSourceReason`, and
    // the phrases above have to be unique per reason to catch a two-way swap.
    //
    // The pairing is what makes it a boundary rather than a wording preference. The
    // positive half pins the qualifier the fix ADDED; the negative half pins the
    // sentence a widening would REINTRODUCE, asserted with its terminating period
    // because that full stop is exactly where the unqualified claim ended. Either
    // alone is weaker: a sentence can carry the qualifier and still make the broader
    // claim elsewhere, and a reword can drop the promise without restoring the old
    // words. Why the copy must stay scoped: the rule compares a source's type against
    // the types the OTHER selected documents hold, so a merged PRD's own
    // `merge_input` sources — earlier generations of its own type — are never read,
    // and an unqualified "nothing recorded here" is false for the commonest shape
    // that reaches `coherent`.
    expect(sentenceOf('oneChain')).toContain('of another document in this row')
    expect(sentenceOf('oneChain')).not.toContain('points at a different generation.')
    // Distinctness catches a swap that keeps every sentence a real one — the phrase
    // assertions above catch a two-way swap, this catches a collapse onto one key.
    const sentences = (Object.keys(OWN_PHRASE) as LineageReason[]).map(sentenceOf)

    expect(new Set(sentences).size).toBe(sentences.length)
  })

  it('scopes coherentReason to another document IN THE ROW in all eight catalogues', () => {
    // The English case above pins this with a phrase-plus-negative pair; this pins the
    // other seven, for the same reason the direction case below it exists. The
    // exposure is identical and the property is again a fact about the RULE rather
    // than about English: `hasSupersededSource` compares a source's type against the
    // types the OTHER selected documents hold, so a document's sources of its OWN type
    // are never read — a merged PRD's `merge_input` sources being exactly that. An
    // unqualified "nothing recorded here points at a different generation" is
    // therefore false in every language for the commonest shape reaching `coherent`,
    // and every catalogue can lose the qualifier the same way. Measured before this
    // case existed: restoring the unqualified wording in German alone left
    // `src/pages/Prioritization src/i18n` green, because `localeParity` compares key
    // SETS and `i18n:check` reports a non-English string only when it is
    // byte-identical to English.
    //
    // Driven by `supportedLanguages` off statically imported catalogues, so a ninth
    // locale is a TYPECHECK failure rather than a silently skipped one.
    const catalogues: Record<SupportedLanguage, { lineage: Record<string, string> }> = {
      en: prioritizationEn,
      de: prioritizationDe,
      es: prioritizationEs,
      fr: prioritizationFr,
      ja: prioritizationJa,
      ko: prioritizationKo,
      pt: prioritizationPt,
      zh: prioritizationZh,
    }
    // Each catalogue's own rendering of the qualifier, taken from the shipped bytes
    // rather than composed here, and verified against the pre-fix bytes: every one of
    // these eight is present now and ABSENT in the unqualified version, so each entry
    // is the exact regression it names. (The German is "Dokuments in dieser Zeile" —
    // the shipped copy carries that preposition.)
    const SCOPE: Record<SupportedLanguage, string> = {
      en: 'of another document in this row',
      de: 'eines anderen Dokuments in dieser Zeile',
      es: 'de otro documento de esta fila',
      fr: "d'un autre document de cette ligne",
      ja: 'この行にある別のドキュメント',
      ko: '이 행에 있는 다른 문서',
      pt: 'de outro documento desta linha',
      zh: '本行中另一个文档',
    }

    for (const locale of supportedLanguages) {
      const sentence = catalogues[locale].lineage.coherentReason

      // Non-vacuity first: a path typo or a catalogue whose `lineage` block went
      // missing would satisfy a `toContain` on nothing by failing loudly, but an
      // EMPTY string would read as a real absence rather than a lookup miss.
      expect(sentence, `${locale} coherentReason`).toBeTruthy()
      expect(sentence, `${locale} scopes the crossing to this row`)
        .toContain(SCOPE[locale])
    }
  })

  it('claims no DIRECTION for supersededSource in any of the eight catalogues', () => {
    // The case above pins English, and English is one eighth of what the copy fix
    // touched. The property is not a property of English: `hasSupersededSource`
    // compares a source's `document_type` against the types the OTHER selected
    // documents hold, and never a timestamp or an ordinal — so it reports the same
    // reason when the source is the LATER version (a row holding PRD 1 beside a
    // PR/FAQ built from the newer PRD 2, measured). Directional copy is therefore
    // false for exactly that half in EVERY language, and every catalogue can regress
    // the same way. Measured before this case existed: reintroducing the directional
    // German wording alone left `src/pages/Prioritization src/i18n` green at 506
    // tests, because `localeParity` compares key SETS and `i18n:check` reports a
    // non-English string only when it is byte-identical to English — fluent German
    // saying the wrong thing is invisible to both.
    //
    // Both tables are keyed by `SupportedLanguage` and the loop is driven by
    // `supportedLanguages`, so a ninth locale is a TYPECHECK failure rather than a
    // silently skipped one — the shape `DataSourceWizard/localization.test.tsx` uses
    // for the same reason.
    const catalogues: Record<SupportedLanguage, { lineage: Record<string, string> }> = {
      en: prioritizationEn,
      de: prioritizationDe,
      es: prioritizationEs,
      fr: prioritizationFr,
      ja: prioritizationJa,
      ko: prioritizationKo,
      pt: prioritizationPt,
      zh: prioritizationZh,
    }
    // The directional term each catalogue actually used before the fix, verified
    // against the pre-fix bytes: every one of these eight was present then and is
    // absent now, so each entry is the exact regression it names rather than a term
    // the language merely might use.
    const DIRECTIONAL: Record<SupportedLanguage, string> = {
      en: 'earlier',
      de: 'früher',
      es: 'anterior',
      fr: 'antérieur',
      ja: '旧バージョン',
      ko: '이전 버전',
      pt: 'anterior',
      zh: '较早',
    }
    // Each language's own word for a generation. NOT a regression detector — the
    // pre-fix copy contained it too, in the "crosses generations" clause — but the
    // non-vacuity control the negative assertion needs: it proves the lookup landed
    // on real copy in THAT language, so a path typo or a catalogue whose `lineage`
    // block went missing cannot satisfy `not.toContain` by resolving to nothing.
    const GENERATION: Record<SupportedLanguage, string> = {
      en: 'generation',
      de: 'Generation',
      es: 'generación',
      fr: 'génération',
      ja: '世代',
      ko: '세대',
      pt: 'geração',
      zh: '代',
    }

    for (const locale of supportedLanguages) {
      const sentence = catalogues[locale].lineage.supersededSourceReason

      expect(sentence, `${locale} supersededSourceReason`).toBeTruthy()
      expect(sentence, `${locale} names a generation`).toContain(GENERATION[locale])
      expect(sentence, `${locale} claims no direction`).not.toContain(DIRECTIONAL[locale])
    }
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

    // And it cannot decide the ABSENT question either, which is the half that reads
    // the selection rather than the entries. The control first, per the ordering this
    // file settled on: a row of two documents recording nothing is `absent`.
    const bare = doc('prfaq_1', 'prfaq', '2025-01-01')
    const plain = doc('prd_1', 'prd', '2025-01-01')

    expect(classifySelectionLineage([plain, bare], [plain, bare]))
      .toEqual({ state: 'absent', reason: 'noneRecorded' })

    // Now the same row plus a record with NO id that DOES carry a derivation. Counted
    // in, its lineage was the only thing that could speak, so the row claimed a chain
    // no document on it records — `coherent` over a row where nothing is readable.
    const idlessRecording = {
      document_type: 'prd', created_at: '2025-02-01', ...builtFromFeedback,
    }

    expect(classifySelectionLineage([plain, bare, idlessRecording], [plain, bare]))
      .toEqual({ state: 'absent', reason: 'noneRecorded' })
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

  it('reads only a document\'s OWN sources, so a crossing two hops out is not reported', () => {
    // PINS THE DEPTH, not a deletable branch: deleting `hasSupersededSource` leaves
    // this case green, because it asserts what the rule does NOT see. The direct
    // control below is what makes it a statement about depth rather than about the
    // rule being broken — swap one source id and the crossing IS reported.
    //
    // Reachable through an ordinary product path: research_step_handler.py:198
    // records a selected PRD on a research report as ROLE_REFERENCE, and
    // document_generator/handler.py:176 records research documents on a generated
    // PR/FAQ the same way — so PRD → research → PR/FAQ is a normal two-hop chain.
    const prd1 = doc('prd_1', 'prd', '2025-01-01', builtFromFeedback)
    const prd2 = doc('prd_2', 'prd', '2025-02-01', builtFromFeedback)
    const research = doc('res_1', 'research', '2025-01-15', builtFrom('prd_1'))
    const transitive = doc('prfaq_t', 'prfaq', '2025-01-20', builtFrom('res_1'))
    const project = [prd1, prd2, research, transitive]

    // The PR/FAQ descends from PRD 1 while the row holds PRD 2 — and reads coherent,
    // because nothing here walks a source's sources.
    expect(classifySelectionLineage([prd2, transitive], project))
      .toEqual({ state: 'coherent', reason: 'oneChain' })
    // THE CONTROL, asserted so the case cannot pass by the rule having gone missing:
    // the same shape one hop shorter — the PR/FAQ naming PRD 1 itself — does cross.
    const direct = doc('prfaq_d', 'prfaq', '2025-01-20', builtFrom('prd_1'))
    expect(classifySelectionLineage([prd2, direct], [prd1, prd2, direct]))
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

  it('does not mark a row stale when its stored composition did not fully resolve', () => {
    // `collectRows` drops a stored id the project no longer holds and keeps the row as
    // long as ANY id resolved, so a two-document row can arrive here as one document.
    // The advisory would then name the newest of the SURVIVING type alone — a
    // combination missing a type the ballots covered. The classification is untouched
    // by this: it describes the documents on screen.
    //
    // The positive control FIRST, so the absence below is the truncation withholding
    // and not the fixture failing to supersede anything: the identical selection with
    // the flag absent IS stale.
    const survivor = { is_frozen: true, documents: [prfaq1] }

    expect(rowLineageOf(survivor, project).stale).toBe(true)

    const truncated = rowLineageOf({ ...survivor, composition_truncated: true }, project)
    expect(truncated.stale).toBe(false)
    expect(truncated.fresherDocumentIds).toEqual([])
    // Still described, and by the same rule as before — withholding the advisory is not
    // withholding the state.
    expect(truncated.state).toBe('coherent')
    expect(truncated.reason).toBe('oneChain')
    // `false` reads as "resolved fully", the same as absent: the flag may only ever
    // take staleness away.
    expect(rowLineageOf({ ...survivor, composition_truncated: false }, project).stale).toBe(true)
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

  it('advises a candidate that crosses generations only two hops out, because the check is depth-1', () => {
    // PINS THE DEPTH of the candidate check, which is the boundary that reaches an
    // ADVISORY rather than a label — so it is worth asserting rather than describing.
    // Deleting `hasSupersededSource` leaves this green: it states what the rule does
    // not see. The refusal it inherits is one hop deep, so a candidate whose newest
    // PR/FAQ descends from the row's own PRD generation VIA a research report is
    // advised. Traversing is measurably the wrong repair — it greys the ordinary
    // regenerated row, argued at `hasSupersededSource` — so `lineage.staleReason` is
    // worded to this limit instead.
    const research = doc('res_x', 'research', '2025-02-01', builtFrom('prd_1'))
    const transitivePrfaq2 = doc('prfaq_2', 'prfaq', '2025-03-02', builtFrom('res_x'))
    const project2 = [prd1, prfaq1, prd2, research, transitivePrfaq2]

    // THE CONTROL FIRST, and deliberately: a failing assertion ends a case, so a
    // control placed after the assertion under test cannot be shown to have run. One
    // hop shorter — the same PR/FAQ naming PRD 1 itself — and the candidate IS refused.
    const directPrfaq2 = doc('prfaq_2', 'prfaq', '2025-03-02', builtFrom('prd_1'))
    expect(fresherCoherentSelection([prd1, prfaq1], [prd1, prfaq1, prd2, directPrfaq2]))
      .toBeNull()
    // Two hops out, the crossing is invisible and the combination is advised.
    expect(fresherCoherentSelection([prd1, prfaq1], project2)).toEqual(['prd_2', 'prfaq_2'])
    // And the candidate's own classification is why: nothing walks a source's sources.
    expect(classifySelectionLineage([prd2, transitivePrfaq2], project2))
      .toEqual({ state: 'coherent', reason: 'oneChain' })
    // Through the entry point the page uses, which is where the badge and the sentence
    // come from — so the shape is recorded as a user-visible outcome, not just as an
    // arithmetic result.
    expect(rowLineageOf(frozenRow([prd1, prfaq1]), project2).stale).toBe(true)
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

  it('withholds staleness on a timestamp tie, in both array orders', () => {
    // Two documents of one type CAN share a `created_at` (the defect
    // `byNewestFirst`'s equal arm exists for, one type over), and the comparison must
    // answer the same whichever way round a read returned them — or the very same
    // frozen row would read as stale or as current depending on the order of a list
    // nobody controls.
    //
    // IT ANSWERS BY WITHHOLDING, which is order-independent in the direction that
    // does not print a false sentence. `rankOf`'s id tie-break settles the ORDERING
    // question `newestOfType` asks and deliberately does not settle this one: an id
    // deciding freshness reported the row holding `prd_a` `Superseded` by a document
    // of the same instant, so `lineage.staleReason` claimed "a newer version … exists"
    // when none did. Neither row is stale here, in either order.
    const sameInstant = '2025-01-01T09:00:00Z'
    const prdA = doc('prd_a', 'prd', sameInstant, builtFromFeedback)
    const prdB = doc('prd_b', 'prd', sameInstant, builtFromFeedback)

    for (const order of [[prdA, prdB], [prdB, prdA]]) {
      expect(fresherCoherentSelection([prdA], order), JSON.stringify(order)).toBeNull()
      expect(fresherCoherentSelection([prdB], order), JSON.stringify(order)).toBeNull()
      // Through the entry point the page uses, which is what a reviewer sees.
      expect(rowLineageOf(frozenRow([prdA]), order).stale, JSON.stringify(order)).toBe(false)
    }

    // AND THE TIE IS ON THE INSTANT, not on the string. `prd_a`'s moment is respelled
    // as an offset here — the SAME instant as `prd_b`'s Z form, so nothing is fresher
    // either way round. The two spellings do not tie as TEXT, and `prd_a`'s sorts
    // higher: a string comparison would therefore report `prd_b`'s row superseded by a
    // copy of the moment it already holds.
    const offsetA = doc('prd_a', 'prd', '2025-01-01T11:00:00+02:00', builtFromFeedback)
    expect(fresherCoherentSelection([offsetA], [offsetA, prdB])).toBeNull()
    expect(fresherCoherentSelection([prdB], [offsetA, prdB])).toBeNull()

    // THE POSITIVE CONTROL, and it is the one shape that tells withholding apart from
    // a comparison that stopped working: a genuinely newer document is still reported
    // in either order even when its id sorts LOWER than the older document's — which
    // the tuple comparison got right only because the instant dominated it.
    const heldOlder = doc('prd_z', 'prd', '2025-01-01', builtFromFeedback)
    const newerLowerId = doc('prd_a', 'prd', '2025-06-01', builtFromFeedback)
    for (const order of [[heldOlder, newerLowerId], [newerLowerId, heldOlder]]) {
      expect(fresherCoherentSelection([heldOlder], order), JSON.stringify(order))
        .toEqual(['prd_a'])
    }

    // Two date-only values from ONE day tie for the whole day, which is the widest
    // window an id could have decided over.
    const dayA = doc('prd_a', 'prd', '2025-01-01', builtFromFeedback)
    const dayZ = doc('prd_z', 'prd', '2025-01-01', builtFromFeedback)
    expect(fresherCoherentSelection([dayA], [dayA, dayZ])).toBeNull()
  })

  it('withholds staleness on a tie the project read does not carry the held document for', () => {
    // THE ONE INPUT THAT REACHES THE FRESHNESS VERDICT'S TIE, and the reason the case
    // above cannot pin it. `chosen` prefers the HELD document whenever a type's newest
    // merely ties — but only when the project read carries it (`byId.has`), because a
    // held id the project does not carry would drop out of `records` and let a crossing
    // candidate pass on a shortened set. Where the substitution is declined,
    // `chosen[index]` and `selected[index]` are two DIFFERENT documents of one instant,
    // which is the only shape in which the verdict comparison can be observed at all:
    // everywhere else the tie has already been substituted away and a document is being
    // compared with itself, where `rankOf` and `instantOf` cannot disagree.
    //
    // Comparing on `rankOf`'s tuple here reports the row `Superseded` by a document of
    // the same instant whose id merely sorts higher, which is exactly the false
    // `lineage.staleReason` sentence the instant-only verdict removed.
    const sameInstant = '2025-01-01T09:00:00Z'
    const held = doc('prd_held', 'prd', sameInstant, builtFromFeedback)
    const sibling = doc('prd_sib', 'prd', sameInstant, builtFromFeedback)
    // A genuinely older PRD, only so the project read has two entries and the case can
    // be asserted in both orders — `newestOfType` answers `prd_sib` either way round.
    const older = doc('prd_old', 'prd', '2024-01-01', builtFromFeedback)

    // THE POSITIVE CONTROL, and it is FIRST on purpose: a failing assertion ends a
    // case, so a control placed after the negative ones cannot be shown to have stayed
    // green under the revert this case exists to catch. On the same shape — a project
    // read that does not carry the held document — a GENUINELY newer sibling is still
    // reported, so the assertions below pin the tie and not the arithmetic refusing
    // every held document the read is missing.
    const newerSibling = doc('prd_sib', 'prd', '2025-06-01', builtFromFeedback)
    expect(fresherCoherentSelection([held], [newerSibling, older])).toEqual(['prd_sib'])
    expect(rowLineageOf(frozenRow([held]), [newerSibling, older]).stale).toBe(true)

    // The project read carries the sibling and NOT the held document — reachable at
    // this exported seam, which does not require the selection to be a subset of the
    // project, and asserted in both orders because a read's order is nobody's choice.
    for (const order of [[sibling, older], [older, sibling]]) {
      expect(fresherCoherentSelection([held], order), JSON.stringify(order)).toBeNull()
      expect(rowLineageOf(frozenRow([held]), order).stale, JSON.stringify(order)).toBe(false)
    }
  })

  it('keeps the held document for a type whose newest only ties, in both array orders', () => {
    // The other side of the same tie: the VERDICT is settled (the PR/FAQ is genuinely
    // newer), so `fresher` is satisfied and every OTHER type is resolved by
    // `newestOfType`'s id tie-break — which would substitute a same-instant `prd_b`
    // for the `prd_a` the row holds, on nothing but a lexicographic comparison. The
    // advised combination is what a reviewer would be asked to score, so it must name
    // no document nobody showed to be newer.
    const sameInstant = '2025-01-01T09:00:00Z'
    const heldPrd = doc('prd_a', 'prd', sameInstant, builtFromFeedback)
    const tiedPrd = doc('prd_b', 'prd', sameInstant, builtFromFeedback)
    const heldPrfaq = doc('faq_1', 'prfaq', sameInstant, builtFromFeedback)
    const newerPrfaq = doc('faq_2', 'prfaq', '2025-06-01', builtFromFeedback)

    for (const order of [
      [heldPrd, heldPrfaq, tiedPrd, newerPrfaq],
      [newerPrfaq, tiedPrd, heldPrfaq, heldPrd],
    ]) {
      expect(fresherCoherentSelection([heldPrd, heldPrfaq], order), JSON.stringify(order))
        .toEqual(['prd_a', 'faq_2'])
      // Through the entry point the page uses, so the field a future Add-row picker
      // reads is the one asserted.
      expect(
        rowLineageOf(frozenRow([heldPrd, heldPrfaq]), order).fresherDocumentIds,
        JSON.stringify(order),
      ).toEqual(['prd_a', 'faq_2'])
    }

    // THE POSITIVE CONTROL, in the same case: a type whose newest is GENUINELY newer
    // is still substituted, so the assertions above pin the tie and not the
    // newest-of-each arithmetic going missing. `prd_c`'s id sorts above `prd_a`'s and
    // `prd_b`'s alike, so the answer cannot be the tie-break agreeing by luck.
    const newerPrd = doc('prd_c', 'prd', '2025-07-01', builtFromFeedback)
    expect(fresherCoherentSelection(
      [heldPrd, heldPrfaq],
      [heldPrd, heldPrfaq, tiedPrd, newerPrd, newerPrfaq],
    )).toEqual(['prd_c', 'faq_2'])
    // And with no tie at all the answer is unchanged — the documented shape
    // `fresherDocumentIds` promises, which the tie was the one input contradicting.
    expect(fresherCoherentSelection([heldPrd, heldPrfaq], [heldPrd, heldPrfaq, newerPrfaq]))
      .toEqual(['prd_a', 'faq_2'])
  })

  it('withholds staleness for a row already holding two versions of one type', () => {
    // Such a row has no single "same expectations" candidate to compare with, and it
    // is already reported as crossing generations — which is the more useful thing to
    // say about it than "add a row for the newest of each".
    const lineage = rowLineageOf(frozenRow([prd1, prd2]), project)

    expect(lineage.state).toBe('crossGeneration')
    expect(lineage.stale).toBe(false)
  })

  it('DOES mark a supersededSource row stale, unlike its repeatedType sibling', () => {
    // The other of the two reasons that answer `crossGeneration`, pinned in the
    // opposite direction — because only one of them withholds and nothing else in the
    // suite said which. `repeatsAType` is called inside `fresherCoherentSelection`
    // and short-circuits it; `hasSupersededSource` is not, so this row runs the whole
    // comparison and can be reported stale.
    //
    // It SHOULD be: the arithmetic is well-defined here (one readable type each, one
    // candidate per type), the candidate is genuinely newer, and it is checked for
    // crossing generations on its own account — asserted below, so this case shows
    // the advice is true rather than merely permitted. One Add-row repairs both
    // complaints, since the row's evidence is inconsistent AND out of date.
    const faqFromPrd1 = doc('faq_1', 'prfaq', '2025-01-01', builtFrom('prd_1'))
    const faqFromPrd2 = doc('faq_2', 'prfaq', '2025-03-01', builtFrom('prd_2'))
    const crossing = [prd1, prd2, faqFromPrd1, faqFromPrd2]

    // THE SIBLING, asserted FIRST and on the same project read, because the claim is a
    // DIVERGENCE: a case that only asserted this row's staleness would stay green if
    // the repeated-type guard were widened to every `crossGeneration` row, which is
    // exactly the change this pair exists to catch.
    expect(rowLineageOf(frozenRow([prd1, prd2]), crossing).stale).toBe(false)

    const lineage = rowLineageOf(frozenRow([prd2, faqFromPrd1]), crossing)

    // The state is unchanged — staleness is a second axis, so this row shows BOTH
    // badges (see `RowStaleBadge`'s "a second badge, not a fourth state"). Pinning
    // the coexistence rather than only the boolean.
    expect(lineage.state).toBe('crossGeneration')
    expect(lineage.reason).toBe('supersededSource')
    expect(lineage.stale).toBe(true)
    expect(lineage.fresherDocumentIds).toEqual(['prd_2', 'faq_2'])
    // And the combination it names does not itself cross generations, which is what
    // makes advising it honest rather than trading one bad row for another.
    expect(classifySelectionLineage([prd2, faqFromPrd2], crossing).state).toBe('coherent')
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
    // Four zones, spanning the sign of the offset and its extreme: UTC itself, one
    // behind and the two furthest ahead. Each assertion is made in EVERY zone and
    // must agree, so the case pins zone-INDEPENDENCE rather than one zone's answer.
    const zones = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati']
    /**
     * Puts `TZ` back SYMMETRICALLY with the save: a variable that was absent is
     * DELETED, never assigned.
     *
     * `process.env.TZ = undefined` stores the literal string `'undefined'`, and Node
     * resolves an unrecognised zone name to UTC rather than erroring — so assigning
     * an absent value does not restore the ambient zone, it silently pins the process
     * to UTC.
     *
     * THE DEFECT THAT PINS IS WITHIN THIS CASE, and that is enough on its own: every
     * assertion after the leak would read UTC instead of the ambient zone, which is
     * this case's own defect one level up — an outcome that depends on who is running
     * it rather than on the record.
     *
     * The CROSS-FILE version of the same hazard is NOT reachable on the installed
     * runner, and the distinction is worth stating because it is easy to assume the
     * other way. `vitest.config.ts` still nests `forks.singleFork` under `poolOptions`
     * (lines 20-24), a key Vitest 4 REMOVED — every run prints `DEPRECATED
     * test.poolOptions was removed in Vitest 4`, so the setting is silently inert and
     * each test file gets its own process. Measured on vitest 4.1.11 with four throwaway
     * probe files: four distinct pids, and none observed a `process.env` marker set by
     * an earlier file. So a `TZ` left pinned here cannot today shift a local-time date
     * another file renders (`format(new Date(row.created_at), 'MMM d, yyyy')` in
     * `PRFAQRow.tsx` and several others), and this restore would become load-bearing
     * across files again the moment that config is migrated to the top-level
     * `singleFork` option that replaced it.
     */
    const restoreZone = (before: string | undefined): void => {
      if (before === undefined) delete process.env.TZ
      else process.env.TZ = before
    }
    const inEveryZone = <T>(answer: () => T): readonly [string, T][] => {
      const before = process.env.TZ
      try {
        return zones.map((zone) => {
          process.env.TZ = zone
          return [zone, answer()] as const
        })
      } finally {
        restoreZone(before)
      }
    }
    /** Asserts one answer is `expected` in all four zones, naming the zone that broke. */
    const agreesEverywhere = <T>(answer: () => T, expected: T): void => {
      for (const [zone, actual] of inEveryZone(answer)) {
        expect(actual, zone).toEqual(expected)
      }
    }

    // THE RESTORE IS FAITHFUL, which is the half no zone assertion covers: the vacuity
    // guard below proves `TZ` is HONOURED while set, never that it is put back. Asserted
    // with `TZ` forced UNSET rather than as-found, because that is the only ambient
    // state the asymmetry is visible in — on a machine whose zone happens to be set,
    // assigning it back is indistinguishable from restoring it, which is exactly why
    // this shipped: the container's own zone is UTC.
    const ambient = process.env.TZ
    try {
      delete process.env.TZ
      inEveryZone(() => Date.parse('2025-01-01T09:00:00'))
      expect('TZ' in process.env, 'TZ deleted, not set to the string "undefined"').toBe(false)
    } finally {
      restoreZone(ambient)
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
