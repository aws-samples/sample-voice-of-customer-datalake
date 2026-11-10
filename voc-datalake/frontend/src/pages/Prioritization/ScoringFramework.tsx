/**
 * @fileoverview The banner above the list naming the metrics every proposal is scored on,
 * and the sentence that explains the priority score — both generated from the scoring
 * setup rather than a fixed "Impact, Time to Market, Strategic Fit, Confidence".
 * @module pages/Prioritization/ScoringFramework
 */
import { Sparkles } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { ScoringAxis } from '../../api/prioritizationAxes'
import { axisText, joinNames } from './axisText'
import type { ReactElement } from 'react'

/** Namespace-qualified and held as data, so `i18n-check` sees the key. */
const FRAMEWORK_TEXT = { configuredKey: 'prioritization:framework.configured' }

export function ScoringFramework({ axes }: { readonly axes: readonly ScoringAxis[] }): ReactElement {
  const { t, i18n } = useTranslation('prioritization')
  const metrics = joinNames(axes.map((axis) => axisText(axis, t).name), i18n.language)
  return (
    <div className="bg-accent-subtle rounded-lg p-3 sm:p-4 border border-accent/30">
      <div className="flex items-start gap-3">
        <Sparkles className="text-accent-text mt-0.5 flex-shrink-0" size={20} aria-hidden="true" />
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-accent-text">{t('framework.title')}</h2>
          <p className="text-xs sm:text-sm text-text mt-1">
            <Trans
              i18nKey={FRAMEWORK_TEXT.configuredKey}
              values={{ metrics }}
              components={{ strong: <strong /> }}
            />
          </p>
        </div>
      </div>
    </div>
  )
}
