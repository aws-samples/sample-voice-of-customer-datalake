/**
 * @fileoverview The four facet selectors (source, category, sentiment, usefulness), each a
 * {@link FacetMultiSelect} with its own labels. The Dashboard shows all four; the Categories
 * page shows the source and usefulness ones (its category and sentiment controls are its
 * charts). One definition, so a facet reads the same on every page.
 *
 * @module components/FacetMultiSelect/FacetSelects
 */
import { useTranslation } from 'react-i18next'
import { SENTIMENT_FACET_VALUES, USEFULNESS_FACET_VALUES } from '../../api/feedbackFacets'
import type { SentimentFacet, UsefulnessFacet } from '../../api/feedbackFacets'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import FacetMultiSelect from './FacetMultiSelect'

interface ListSelectProps<T extends string> {
  readonly selected: readonly T[]
  readonly onToggle: (value: T) => void
  readonly onClear: () => void
}

interface OpenListSelectProps extends ListSelectProps<string> {
  /** The values to offer (the window's sources or categories). */
  readonly options: readonly string[]
}

export function SourceFacetSelect({ options, selected, onToggle, onClear }: OpenListSelectProps) {
  const { t } = useTranslation('components')
  const labels = useDisplayLabels()
  return (
    <FacetMultiSelect label={t('facetFilters.source')} allLabel={t('facetFilters.allSources')} display={labels.source}
      options={withSelected(options, selected)} selected={selected} onToggle={onToggle} onClear={onClear} />
  )
}

export function CategoryFacetSelect({ options, selected, onToggle, onClear }: OpenListSelectProps) {
  const { t } = useTranslation('components')
  const labels = useDisplayLabels()
  return (
    <FacetMultiSelect label={t('facetFilters.category')} allLabel={t('facetFilters.allCategories')} display={labels.category}
      options={withSelected(options, selected)} selected={selected} onToggle={onToggle} onClear={onClear} />
  )
}

export function SentimentFacetSelect({ selected, onToggle, onClear }: ListSelectProps<SentimentFacet>) {
  const { t } = useTranslation('components')
  return (
    <FacetMultiSelect label={t('facetFilters.sentiment')} allLabel={t('facetFilters.allSentiments')}
      display={(value) => t(`facetFilters.sentiments.${value}`)}
      options={SENTIMENT_FACET_VALUES} selected={selected} onToggle={onToggle} onClear={onClear} />
  )
}

export function UsefulnessFacetSelect({ selected, onToggle, onClear }: ListSelectProps<UsefulnessFacet>) {
  const { t } = useTranslation('components')
  return (
    <FacetMultiSelect label={t('facetFilters.usefulness')} allLabel={t('facetFilters.allUsefulness')}
      display={(value) => t(`facetFilters.usefulnessValues.${value}`)}
      options={USEFULNESS_FACET_VALUES} selected={selected} onToggle={onToggle} onClear={onClear} />
  )
}

/** The options plus any selected value they lack (a deep link to a value outside the window stays clearable). */
function withSelected(options: readonly string[], selected: readonly string[]): string[] {
  return [...options, ...selected.filter((value) => !options.includes(value))]
}
