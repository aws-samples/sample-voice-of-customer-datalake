/**
 * @fileoverview The column-mapping step of the CSV upload: one row per header
 * with where it goes (a field, a dimension, metadata, or ignore), pre-filled
 * with the suggestion, and the reason the mapping cannot be sent yet.
 *
 * @module pages/Scrapers/CsvColumnMapping
 */
import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import { dimensionKeyOf, isCsvColumnTarget, mappingProblem, targetOptions } from './csvColumns'
import type { Dimension } from '../../api/dimensionsSchema'
import type { CsvColumnTarget } from '../../api/types'

// Held as `…Key:` data so scripts/i18n-check.mjs sees each label.
const TARGET_LABELS: Record<string, { labelKey: string }> = {
  text: { labelKey: 'scrapers:csvUpload.mapping.targets.text' },
  id: { labelKey: 'scrapers:csvUpload.mapping.targets.id' },
  rating: { labelKey: 'scrapers:csvUpload.mapping.targets.rating' },
  date: { labelKey: 'scrapers:csvUpload.mapping.targets.date' },
  author: { labelKey: 'scrapers:csvUpload.mapping.targets.author' },
  title: { labelKey: 'scrapers:csvUpload.mapping.targets.title' },
  url: { labelKey: 'scrapers:csvUpload.mapping.targets.url' },
  channel: { labelKey: 'scrapers:csvUpload.mapping.targets.channel' },
  tags: { labelKey: 'scrapers:csvUpload.mapping.targets.tags' },
  metadata: { labelKey: 'scrapers:csvUpload.mapping.targets.metadata' },
  ignore: { labelKey: 'scrapers:csvUpload.mapping.targets.ignore' },
}

interface CsvColumnMappingProps {
  mapping: Readonly<Record<string, CsvColumnTarget>>
  dimensions: readonly Dimension[]
  onChange: (mapping: Record<string, CsvColumnTarget>) => void
}

export default function CsvColumnMapping({ mapping, dimensions, onChange }: Readonly<CsvColumnMappingProps>) {
  const { t } = useTranslation('scrapers', { keyPrefix: 'csvUpload.mapping' })
  const { t: tAll } = useTranslation()
  const problem = mappingProblem(mapping)

  const labelOf = (target: string): string => {
    const key = dimensionKeyOf(target)
    if (key === undefined) return tAll(TARGET_LABELS[target]?.labelKey ?? target)
    return t('dimensionTarget', { name: dimensions.find((d) => d.key === key)?.label ?? key })
  }

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-text">{t('title')}</legend>
      <p className="text-xs text-muted">{t('hint')}</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {Object.entries(mapping).map(([header, target]) => (
          <li key={header} className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-center px-3 py-2">
            <span className="font-mono text-sm text-text-strong truncate" title={header}>{header}</span>
            <select
              value={target}
              aria-label={t('columnLabel', { header })}
              onChange={(e) => { if (isCsvColumnTarget(e.target.value, dimensions)) onChange({ ...mapping, [header]: e.target.value }) }}
              className="select select-sm"
            >
              {targetOptions(dimensions).map((option) => <option key={option} value={option}>{labelOf(option)}</option>)}
            </select>
          </li>
        ))}
      </ul>
      {problem !== null && (
        <p role="status" className="text-sm text-warn flex items-center gap-2">
          <AlertCircle size={14} aria-hidden="true" />
          {tAll(problem.messageKey, { target: problem.params['target'] === undefined ? '' : labelOf(problem.params['target']) })}
        </p>
      )}
    </fieldset>
  )
}
