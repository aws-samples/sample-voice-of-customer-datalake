/**
 * @fileoverview Ranked category-distribution breakdown that doubles as the
 * category selector for the Categories page (issue #198 UX rationalization).
 *
 * Each row is a toggle: clicking selects/deselects the category as a filter
 * for the feedback list below (multi-select). Nothing selected = the list
 * shows all feedback. This replaced the separate "Select Categories to
 * Explore" chips card, which duplicated the same data.
 *
 * Only the top {@link MAX_COLLAPSED_ROWS} categories are shown by default to
 * keep the card compact; a toggle reveals the rest. Selected categories
 * outside the top rows stay visible while collapsed so deep-linked filters
 * (?category=) are never hidden.
 *
 * @module pages/Categories/CategoryDistribution
 */

import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, ChevronUp, FolderOpen } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { formatCount, formatPercent } from '../../utils/numberFormat'
import { OTHER_CATEGORY } from '../../utils/displayLabels'
import { NEUTRAL_CHART_STEP, categoryChartSteps, chartStepVar } from './types'
import type { CategoryData } from './types'

/** Rows shown while collapsed. */
const MAX_COLLAPSED_ROWS = 5

interface CategoryDistributionProps {
  /** Categories sorted by value descending (as produced by the Categories page). */
  readonly categoryData: CategoryData[]
  /** Every review in the window (categorised + uncategorised), used to compute each bar's percentage. */
  readonly totalIssues: number
  /** Reviews with no category; shown as a last, non-selectable "Uncategorised" bar so the bars sum to the total. */
  readonly uncategorised?: number
  /** Optional lookback window (days) shown in the header. */
  readonly periodDays?: number
  /** Categories currently filtering the feedback list. */
  readonly selectedCategories: string[]
  /** Toggles a category in/out of the filter selection. */
  readonly onToggleCategory: (category: string) => void
}

/** Top rows plus any selected category ranked below the fold, and "Other" (the remainder, always last). */
function visibleWhileCollapsed(categoryData: CategoryData[], selectedCategories: string[]): CategoryData[] {
  return categoryData.filter(
    (category, index) => index < MAX_COLLAPSED_ROWS || selectedCategories.includes(category.name)
      || category.name === OTHER_CATEGORY
  )
}

export function CategoryDistribution({
  categoryData,
  totalIssues,
  uncategorised = 0,
  periodDays,
  selectedCategories,
  onToggleCategory,
}: CategoryDistributionProps) {
  const { t, i18n } = useTranslation('categories')
  const labels = useDisplayLabels()
  const [expanded, setExpanded] = useState(false)
  const headingId = useId()
  // Colours by rank over the WHOLE ranked list, so expanding or collapsing the
  // card never recolours a row.
  const steps = useMemo(() => categoryChartSteps(categoryData.map((category) => category.name)), [categoryData])
  if (categoryData.length === 0 && uncategorised === 0) {
    return (
      <section className="card" aria-labelledby={headingId}>
        <h2 id={headingId} className="text-base sm:text-lg font-semibold tracking-tight text-text-strong mb-3 sm:mb-4">{t('categoryDistribution')}</h2>
        <div className="py-8 text-center text-muted">
          <FolderOpen size={20} className="mx-auto mb-2 text-muted" aria-hidden="true" />
          <p className="text-sm">{t('noCategories')}</p>
        </div>
      </section>
    )
  }

  // "Other" is the remainder, not a category of its own: the header and the
  // "Show all N categories" toggle count the same rows (5.34.00: "8 categories"
  // beside "Show all 9 categories").
  const categoryCount = categoryData.filter((category) => category.name !== OTHER_CATEGORY).length
  const headerMeta = [
    t('categories', { count: categoryCount }),
    t('reviewTotal', { count: totalIssues, formatted: formatCount(totalIssues, i18n.language) }),
    ...(periodDays ? [t('lastDays', { count: periodDays })] : []),
  ].join(' • ')

  return (
    <section className="card" aria-labelledby={headingId}>
      {/* Stacked, not side-by-side: in the 3-up row the card is ~370px wide and
          a row layout wrapped the title onto two lines next to the meta. */}
      <h2 id={headingId} className="text-base sm:text-lg font-semibold tracking-tight text-text-strong">{t('categoryDistribution')}</h2>
      <p className="text-xs text-muted mt-0.5">{headerMeta}</p>
      <p className="text-xs text-muted mt-2 mb-1.5">{t('categoryDistributionHint')}</p>
      <div className="divide-y divide-border">
        {(expanded ? categoryData : visibleWhileCollapsed(categoryData, selectedCategories)).map((category) => {
          const percentage = totalIssues > 0 ? (category.value / totalIssues) * 100 : 0
          const isSelected = selectedCategories.includes(category.name)
          const colour = chartStepVar(steps.get(category.name) ?? NEUTRAL_CHART_STEP)
          return (
            <button
              key={category.name}
              onClick={() => onToggleCategory(category.name)}
              aria-pressed={isSelected}
              title={category.name === OTHER_CATEGORY ? t('uncategorisedHint') : undefined}
              className={clsx(
                'block w-full text-left py-1.5 px-2 -mx-2 rounded-lg transition-colors active:scale-[0.99] focus-ring',
                isSelected ? 'bg-accent-subtle ring-1 ring-inset ring-accent/40' : 'hover:bg-bg-hover'
              )}
            >
              <BarLine colour={colour} percentage={percentage} value={category.value} nameClass={isSelected ? 'text-accent-text' : 'text-text-strong'}>
                {labels.category(category.name)}
              </BarLine>
            </button>
          )
        })}
        {uncategorised > 0 && <UncategorisedRow count={uncategorised} totalIssues={totalIssues} />}
      </div>
      {categoryData.length > MAX_COLLAPSED_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="btn btn-ghost btn-sm mt-1.5 -ml-2.5 text-accent-text"
        >
          {expanded ? (
            <>
              <ChevronUp size={14} />
              {t('showTop', { count: MAX_COLLAPSED_ROWS })}
            </>
          ) : (
            <>
              <ChevronDown size={14} />
              {t('showAllCategories', { count: categoryCount })}
            </>
          )}
        </button>
      )}
    </section>
  )
}

/** The reviews no category claims: same bar recipe in the neutral step, but not a filter (there is no "no category" route). */
function UncategorisedRow({ count, totalIssues }: Readonly<{ count: number; totalIssues: number }>) {
  const { t } = useTranslation('categories')
  const percentage = totalIssues > 0 ? (count / totalIssues) * 100 : 0
  const colour = chartStepVar(NEUTRAL_CHART_STEP)
  return (
    <div data-testid="uncategorised-row" className="py-1.5 px-2 -mx-2" title={t('uncategorisedHint')}>
      <BarLine colour={colour} percentage={percentage} value={count} nameClass="text-muted">{t('uncategorised')}</BarLine>
    </div>
  )
}

/** One row's name, count and bar. The name and count carry the meaning; the bar repeats them visually. */
function BarLine({ colour, percentage, value, nameClass, children }: Readonly<{
  colour: string; percentage: number; value: number; nameClass: string; children: ReactNode
}>) {
  const { i18n } = useTranslation()
  return (
    <>
      {/* Wraps: in a narrow card (or at 200 % text) the counts drop under the
          name instead of overlapping it ("Technical Support" over "16%"). */}
      <div data-testid="category-row-text" className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 mb-0.5">
        <span className="flex min-w-0 items-center gap-2">
          {/* Legend swatch: the bar's colour beside the name it belongs to. */}
          <span aria-hidden="true" data-testid="category-swatch" className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: colour }} />
          <span className={clsx('min-w-0 font-medium text-sm leading-tight hyphens-auto [overflow-wrap:break-word]', nameClass)}>{children}</span>
        </span>
        <span data-testid="category-row-count" className="ml-auto whitespace-nowrap text-xs font-mono text-text leading-tight">
          {formatCount(value, i18n.language)} ({formatPercent(percentage, i18n.language, 1)})
        </span>
      </div>
      <div aria-hidden="true" className="h-1.5 bg-border rounded-full overflow-hidden">
        <div data-testid="category-bar" className="h-full rounded-full" style={{ width: `${percentage}%`, backgroundColor: colour }} />
      </div>
    </>
  )
}
