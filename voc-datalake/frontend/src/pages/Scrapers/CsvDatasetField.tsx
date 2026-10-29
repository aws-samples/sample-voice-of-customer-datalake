/**
 * @fileoverview The optional "Dataset name" of a CSV upload (issue #411, docs/csv-import.md).
 *
 * Rows that carry their own `id` are keyed by (dataset, id), so re-uploading a corrected
 * file under the same name updates them instead of adding them again. Not offered for a
 * Radar upload, which has no update path (the API refuses the combination).
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { DATASET_NAME_MAX_LENGTH, datasetNameProblem } from '../../api/csvDatasetSchema'
import type { DatasetNameProblem } from '../../api/csvDatasetSchema'

// Held as `…Key:` data so scripts/i18n-check.mjs sees each message.
const PROBLEMS: Record<DatasetNameProblem, { messageKey: string }> = {
  tooLong: { messageKey: 'scrapers:csvUpload.dataset.problems.tooLong' },
  invalidChars: { messageKey: 'scrapers:csvUpload.dataset.problems.invalidChars' },
}

interface CsvDatasetFieldProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly disabled: boolean
  /** A Radar brand is chosen: the field is off and says why. */
  readonly radar: boolean
}

export default function CsvDatasetField({ value, onChange, disabled, radar }: CsvDatasetFieldProps) {
  const { t } = useTranslation()
  const id = useId()
  const problem = datasetNameProblem(value)
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-text mb-1">{t('scrapers:csvUpload.dataset.label')}</label>
      <input
        id={id}
        type="text"
        value={radar ? '' : value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || radar}
        aria-invalid={problem !== null}
        className="input"
        placeholder={t('scrapers:csvUpload.dataset.placeholder')}
      />
      {problem !== null && !radar ? (
        <p role="alert" className="text-xs text-danger mt-1">{t(PROBLEMS[problem].messageKey, { max: DATASET_NAME_MAX_LENGTH })}</p>
      ) : (
        <p className="text-xs text-muted mt-1">{t(radar ? 'scrapers:csvUpload.dataset.radarNote' : 'scrapers:csvUpload.dataset.hint')}</p>
      )}
    </div>
  )
}
