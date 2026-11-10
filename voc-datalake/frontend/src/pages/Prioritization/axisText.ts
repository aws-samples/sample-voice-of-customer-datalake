/**
 * @fileoverview What a scoring metric is CALLED on screen: its name, hint and the words
 * for 1 and 5 — translated for the four built-ins, as configured for everything else.
 *
 * Every key is namespace-QUALIFIED (`prioritization:…`) and held in a table, for the
 * reason `SCORABLE_TYPE_META` records: `scripts/i18n-check.mjs` only collects a
 * data-held key that carries a namespace, and the qualified key resolves through a `t`
 * bound to any namespace. Pure (no React), so the phone ballot imports it cheaply.
 *
 * @module pages/Prioritization/axisText
 */
import type { BuiltinAxisId, ScoringAxis } from '../../api/prioritizationAxes'
import { isBuiltinAxisId, weightShares } from '../../api/prioritizationAxes'

type QualifiedKey = `prioritization:${string}`

interface BuiltinText {
  readonly nameKey: QualifiedKey
  /** The name on the phone ballot. */
  readonly ballotNameKey: QualifiedKey
  /** The compact name for a tab or a column caption. */
  readonly shortKey: QualifiedKey
  /** The hint under the slider on the signed-in page. */
  readonly descriptionKey: QualifiedKey
  /** The hint on the phone ballot (worded for a room, e.g. "5 is fastest"). */
  readonly ballotHintKey: QualifiedKey
  readonly lowKey: QualifiedKey
  readonly highKey: QualifiedKey
}

const BUILTIN_TEXT: Record<BuiltinAxisId, BuiltinText> = {
  impact: {
    nameKey: 'prioritization:scores.impact',
    ballotNameKey: 'prioritization:ballot.axes.impact',
    shortKey: 'prioritization:scores.impact',
    descriptionKey: 'prioritization:scores.impactDescription',
    ballotHintKey: 'prioritization:ballot.axes.impactHint',
    lowKey: 'prioritization:scores.low',
    highKey: 'prioritization:scores.high',
  },
  time_to_market: {
    nameKey: 'prioritization:scores.timeToMarket',
    ballotNameKey: 'prioritization:ballot.axes.timeToMarket',
    shortKey: 'prioritization:sort.ttm',
    descriptionKey: 'prioritization:scores.timeToMarketDescription',
    ballotHintKey: 'prioritization:ballot.axes.timeToMarketHint',
    lowKey: 'prioritization:scores.slow',
    highKey: 'prioritization:scores.fast',
  },
  strategic_fit: {
    nameKey: 'prioritization:scores.strategicFit',
    ballotNameKey: 'prioritization:ballot.axes.strategicFit',
    shortKey: 'prioritization:scores.strategicFit',
    descriptionKey: 'prioritization:scores.strategicFitDescription',
    ballotHintKey: 'prioritization:ballot.axes.strategicFitHint',
    lowKey: 'prioritization:scores.low',
    highKey: 'prioritization:scores.high',
  },
  confidence: {
    nameKey: 'prioritization:scores.confidence',
    ballotNameKey: 'prioritization:ballot.axes.confidence',
    shortKey: 'prioritization:scores.confidence',
    descriptionKey: 'prioritization:scores.confidenceDescription',
    ballotHintKey: 'prioritization:ballot.axes.confidenceHint',
    lowKey: 'prioritization:scores.low',
    highKey: 'prioritization:scores.high',
  },
}

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * "Impact 40 %, Time to market 30 % and Effort 20 % (lower is better)" — each ACTIVE
 * metric with its share of the composite, in the configured order. One function, so
 * the explainer and the read-only setup say the same thing.
 */
export function weightSentence(axes: readonly ScoringAxis[], t: Translate, language: string): string {
  const shares = weightShares(axes)
  return joinNames(axes.map((axis) => {
    const values = { name: axisText(axis, t).name, share: shares[axis.id] ?? 0 }
    return axis.direction === 'lower_better'
      ? t('prioritization:explainer.weightEntryLower', values)
      : t('prioritization:explainer.weightEntry', values)
  }), language)
}

/** What a metric is called, everywhere it appears. */
export interface AxisText {
  readonly name: string
  readonly shortName: string
  /** Empty when the metric has no description. */
  readonly description: string
  readonly lowLabel: string
  readonly highLabel: string
}


/** A configured string wins; otherwise the built-in's translation, else the fallback. */
const configuredOr = (value: string | null, fallback: string): string => value ?? fallback

/**
 * The words for one metric. `surface` picks the hint: the signed-in sliders' short
 * description, or the phone ballot's room-facing hint.
 */
export function axisText(
  axis: Pick<ScoringAxis, 'id' | 'label' | 'description' | 'low_label' | 'high_label'>,
  t: Translate,
  surface: 'row' | 'ballot' = 'row',
): AxisText {
  if (!isBuiltinAxisId(axis.id)) {
    const name = axis.label ?? axis.id
    return {
      name,
      shortName: name,
      description: axis.description ?? '',
      lowLabel: configuredOr(axis.low_label, t('prioritization:scores.low')),
      highLabel: configuredOr(axis.high_label, t('prioritization:scores.high')),
    }
  }
  const keys = BUILTIN_TEXT[axis.id]
  return {
    name: configuredOr(axis.label, t(surface === 'ballot' ? keys.ballotNameKey : keys.nameKey)),
    // A renamed built-in shows its new name everywhere — the short form included.
    shortName: configuredOr(axis.label, t(keys.shortKey)),
    description: configuredOr(axis.description, t(surface === 'ballot' ? keys.ballotHintKey : keys.descriptionKey)),
    lowLabel: configuredOr(axis.low_label, t(keys.lowKey)),
    highLabel: configuredOr(axis.high_label, t(keys.highKey)),
  }
}

/** Names joined the way the reader's language joins a list ("A, B and C"). */
export function joinNames(names: readonly string[], language: string): string {
  return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(names)
}
