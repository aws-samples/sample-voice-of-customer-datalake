/**
 * @fileoverview "How this is scored": one collapsed disclosure above the list that
 * explains the priority score and every lineage label ONCE, instead of a long
 * paragraph inside every expanded row. Each row keeps its short label (and, for a
 * superseded row, the one action it can take).
 *
 * A native `<details>`, so it is keyboard- and screen-reader-operable without code.
 *
 * @module pages/Prioritization/ScoringExplainer
 */
import { BadgeCheck, GitBranch, History, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import type { ReactElement } from 'react'
import { LINEAGE_REASON_KEY, LINEAGE_STYLE } from './rowLineage'
import { weightSentence } from './axisText'
import type { ScoringAxis } from '../../api/prioritizationAxes'

/** Each lineage label beside the sentence that explains it (keys read verbatim from the tables). */
const LINEAGE_ENTRIES = [
  { labelKey: LINEAGE_STYLE.coherent.labelKey, reasonKey: LINEAGE_REASON_KEY.oneChain.sentenceKey },
  { labelKey: LINEAGE_STYLE.crossGeneration.labelKey, reasonKey: LINEAGE_REASON_KEY.repeatedType.sentenceKey },
  { labelKey: LINEAGE_STYLE.crossGeneration.labelKey, reasonKey: LINEAGE_REASON_KEY.supersededSource.sentenceKey },
  { labelKey: LINEAGE_STYLE.absent.labelKey, reasonKey: LINEAGE_REASON_KEY.noneRecorded.sentenceKey },
] as const

/** The explanation itself, mounted only while the disclosure is open (so its sentences never duplicate a row's). */
function ExplainerBody({ axes }: { readonly axes: readonly ScoringAxis[] }): ReactElement {
  const { t, i18n } = useTranslation('prioritization')
  return (
    <div className="mt-3 space-y-3 text-xs text-text">
      {/* Generated from the scoring setup — the configured metrics and their shares —
          rather than a fixed "40 / 30 / 20 / 10" that would go stale on the first edit. */}
      <p>{t('explainer.scoreConfigured', { weights: weightSentence(axes, t, i18n.language) })}</p>
      <p>{t('explainer.unscored')}</p>
      <p>{t('explainer.team')}</p>
      <p className="font-medium text-text-strong">{t('explainer.lineageTitle')}</p>
      <dl className="space-y-2">
        {LINEAGE_ENTRIES.map(({ labelKey, reasonKey }) => (
          <div key={reasonKey}>
            <dt className="inline-flex items-center gap-1 font-medium text-text-strong">
              <GitBranch size={12} aria-hidden="true" />{t(labelKey)}
            </dt>
            <dd className="mt-0.5">{t(reasonKey)}</dd>
          </div>
        ))}
        <div>
          <dt className="inline-flex items-center gap-1 font-medium text-text-strong">
            <History size={12} aria-hidden="true" />{t('lineage.stale')}
          </dt>
          <dd className="mt-0.5">{t('lineage.staleReason')}</dd>
        </div>
        <div>
          <dt className="inline-flex items-center gap-1 font-medium text-text-strong">
            <BadgeCheck size={12} aria-hidden="true" />{t('lineage.acknowledged')}
          </dt>
          <dd className="mt-0.5">{t('lineage.acknowledgedReason')}</dd>
        </div>
      </dl>
    </div>
  )
}

export function ScoringExplainer({ axes }: {
  /** The ACTIVE metrics of the scoring setup. */
  readonly axes: readonly ScoringAxis[]
}): ReactElement {
  const { t } = useTranslation('prioritization')
  const [open, setOpen] = useState(false)
  return (
    <details data-testid="scoring-explainer" className="card !p-3 sm:!p-4 text-sm" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer font-medium text-text-strong inline-flex items-center gap-2 focus-ring rounded-sm">
        <Info size={14} aria-hidden="true" />
        {t('explainer.title')}
      </summary>
      {open ? <ExplainerBody axes={axes} /> : null}
    </details>
  )
}
