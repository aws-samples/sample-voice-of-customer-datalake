/**
 * @fileoverview The "Similarity" control: how aggressively near-duplicate problems
 * are merged on the Problem Analysis page.
 *
 * Named by its visible text twice over — `htmlFor`/`id` and `aria-labelledby` —
 * because a `title` alone is not an accessible name (axe `label-title-only`), and
 * an implicit wrapping `<label>` was not read as one by every audit. What Low /
 * Medium / High / Off do is explained beside it: an info icon with a tooltip, and
 * the same sentence as the select's accessible description.
 *
 * @module pages/ProblemAnalysis/SimilaritySelect
 */
import { useId } from 'react'
import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReactElement } from 'react'
import type { SimilarityLevel } from './useProblemFilters'

const LEVELS: readonly SimilarityLevel[] = ['low', 'med', 'high', 'off']

const OPTION_KEY: Readonly<Record<SimilarityLevel, string>> = {
  low: 'filters.similarityLow', med: 'filters.similarityMed', high: 'filters.similarityHigh', off: 'filters.similarityOff',
}

function isLevel(value: string): value is SimilarityLevel {
  return LEVELS.some((level) => level === value)
}

export function SimilaritySelect({ value, onChange }: {
  readonly value: SimilarityLevel
  readonly onChange: (next: SimilarityLevel) => void
}): ReactElement {
  const { t } = useTranslation('problemAnalysis')
  const selectId = useId()
  const labelId = useId()
  const hintId = useId()
  const hint = t('filters.similarityLevelsHint')
  return (
    <div className="flex items-center gap-2 text-sm">
      <label id={labelId} htmlFor={selectId} className="text-muted">{t('filters.similarity')}</label>
      <select
        id={selectId}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        value={value}
        onChange={(e) => { if (isLevel(e.target.value)) onChange(e.target.value) }}
        className="select select-sm w-auto"
      >
        {LEVELS.map((level) => (
          <option key={level} value={level}>{t(OPTION_KEY[level])}</option>
        ))}
      </select>
      <span className="text-muted inline-flex" title={hint} data-testid="similarity-hint">
        <Info size={14} aria-hidden="true" />
        <span id={hintId} className="sr-only">{hint}</span>
      </span>
    </div>
  )
}
