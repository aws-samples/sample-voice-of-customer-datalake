/**
 * @fileoverview The advanced (shared-model) feedback-filter controls for the
 * DataSourceWizard's feedback step.
 * @module components/DataSourceWizard/AdvancedFeedbackFilters
 */
import { useTranslation } from 'react-i18next'
import { ENRICHMENT_FIELDS, enrichmentFilterOptions } from '../../api/enrichmentFields'
import { EMPTY_FEEDBACK_FILTERS, toggleValue } from '../../api/feedbackFilters'
import type { FeedbackFilterState } from '../../api/feedbackFilters'
import { CheckboxGroup } from '../FeedbackFilterPanel/CheckboxGroup'
import type { CustomFilterControl } from '../FeedbackFilterPanel'
import { enrichmentLabel, enrichmentValueLabel } from '../../utils/enrichmentLabels'

/**
 * The shared-model dimensions the wizard's own source/category/sentiment/time
 * controls don't cover: subcategory (via enrichment/registry are separate),
 * urgent-only, enrichment registry fields, and admin-configured custom fields.
 * Writes into `contextConfig.feedback` (a FeedbackFilterState) using the same
 * CheckboxGroup the pages' panel uses, so the wizard stays visually consistent
 * without embedding the whole panel.
 *
 * Rendered only when there is something to show (an enrichment field exists or
 * a custom filter is configured) so a deployment with neither sees the wizard
 * exactly as before.
 */
export function AdvancedFeedbackFilters({
  feedback,
  onChange,
  customFilterControls,
}: Readonly<{
  feedback: FeedbackFilterState
  onChange: (next: FeedbackFilterState) => void
  customFilterControls: readonly CustomFilterControl[]
}>) {
  const { t } = useTranslation('components')
  // Belt-and-braces: a stale caller may pass neither prop. Normalize to the
  // empty filter set / empty controls so this never reads through undefined
  // (the wire-shape rule — components don't trust runtime data to match types).
  const safeFeedback = feedback ?? EMPTY_FEEDBACK_FILTERS
  const controls = customFilterControls ?? []
  const hasEnrichment = ENRICHMENT_FIELDS.length > 0
  const hasCustom = controls.length > 0
  if (!hasEnrichment && !hasCustom) return null

  const toggleUrgent = () => onChange({ ...safeFeedback, urgentOnly: !safeFeedback.urgentOnly })

  const setEnrichment = (field: string, values: string[]) => {
    const enrichment = { ...safeFeedback.enrichment }
    if (values.length > 0) enrichment[field] = values
    else delete enrichment[field]
    onChange({ ...safeFeedback, enrichment })
  }

  const toggleEnrichment = (field: string, value: string) => {
    setEnrichment(field, toggleValue(safeFeedback.enrichment[field] ?? [], value))
  }

  const setCustom = (key: string, values: string[]) => {
    const customFields = { ...safeFeedback.customFields }
    if (values.length > 0) customFields[key] = values
    else delete customFields[key]
    onChange({ ...safeFeedback, customFields })
  }

  const toggleCustom = (key: string, value: string) => {
    setCustom(key, toggleValue(safeFeedback.customFields[key] ?? [], value))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input
          id="wizard-urgent-only"
          type="checkbox"
          checked={safeFeedback.urgentOnly}
          onChange={toggleUrgent}
          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
        />
        <label htmlFor="wizard-urgent-only" className="text-sm text-gray-700 cursor-pointer">
          {t('common:feedbackFilters.urgentOnly')}
        </label>
      </div>

      {ENRICHMENT_FIELDS.map((field) => (
        <CheckboxGroup
          key={field.name}
          legend={enrichmentLabel(t, field.name)}
          options={enrichmentFilterOptions(field).map((value) => ({
            value,
            label: enrichmentValueLabel(t, field.name, value),
          }))}
          selected={safeFeedback.enrichment[field.name] ?? []}
          onToggle={(value) => toggleEnrichment(field.name, value)}
          onClear={() => setEnrichment(field.name, [])}
        />
      ))}

      {controls.map((control) => (
        <CheckboxGroup
          key={control.key}
          legend={control.label}
          options={control.values.map((value) => ({ value, label: value }))}
          selected={safeFeedback.customFields[control.key] ?? []}
          onToggle={(value) => toggleCustom(control.key, value)}
          onClear={() => setCustom(control.key, [])}
          humanizeMissing={false}
        />
      ))}
    </div>
  )
}
