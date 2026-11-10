/**
 * @fileoverview What a CSV dataset upload will do, shown before anything is stored
 * (issue #411, docs/csv-import.md): new rows, stored rows that will be updated (with a
 * before / after snippet of the first ones), unchanged rows that are skipped, and rows
 * without an id that are added as new and cannot be updated by a later upload.
 */
import { ArrowRight, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CsvChangedRow, CsvDatasetPreview } from '../../api/csvDatasetSchema'

// Held as `…Key:` data so scripts/i18n-check.mjs sees each message.
const COUNT_LINES = [
  { field: 'new', messageKey: 'scrapers:csvUpload.preview.countNew' },
  { field: 'changed', messageKey: 'scrapers:csvUpload.preview.countChanged' },
  { field: 'unchanged', messageKey: 'scrapers:csvUpload.preview.countUnchanged' },
  { field: 'v1_rows', messageKey: 'scrapers:csvUpload.preview.countNotUpdatable' },
] as const

export default function CsvUpdatePreview({ preview }: { readonly preview: CsvDatasetPreview }) {
  const { t } = useTranslation()
  const { counts, changed_rows: rows } = preview
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-text-strong">{t('scrapers:csvUpload.preview.title')}</h3>
      <ul className="text-sm text-text space-y-1">
        {COUNT_LINES.filter((line) => counts[line.field] > 0).map((line) => (
          <li key={line.field}>{t(line.messageKey, { count: counts[line.field] })}</li>
        ))}
      </ul>
      {counts.v1_rows > 0 ? (
        <p className="text-xs text-muted inline-flex items-start gap-1.5">
          <Info size={14} className="mt-0.5 flex-shrink-0" /> {t('scrapers:csvUpload.preview.notUpdatableHint')}
        </p>
      ) : null}
      {rows.length > 0 ? <ChangedRows rows={rows} total={counts.changed} truncated={preview.changed_rows_truncated} /> : null}
    </div>
  )
}

function ChangedRows({ rows, total, truncated }: {
  readonly rows: readonly CsvChangedRow[]; readonly total: number; readonly truncated: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="border border-border rounded-lg max-h-64 overflow-y-auto">
      <div className="px-3 py-2 text-xs font-medium text-text border-b border-border">{t('scrapers:csvUpload.preview.changedHeader')}</div>
      <ul className="divide-y divide-border">
        {rows.map((row, index) => (
          <li key={`${row.row ?? 'x'}-${index}`} className="px-3 py-2 text-xs space-y-1">
            <div className="font-medium text-text">
              {row.csv_row_id === null
                ? t('scrapers:csvUpload.preview.row', { row: row.row ?? '' })
                : t('scrapers:csvUpload.preview.rowWithId', { row: row.row ?? '', id: row.csv_row_id })}
            </div>
            <div className="flex items-start gap-2 text-muted">
              <span className="flex-1 line-through break-words"><span className="sr-only">{t('scrapers:csvUpload.preview.before')} </span>{row.before}</span>
              <ArrowRight size={12} className="mt-0.5 flex-shrink-0" aria-hidden />
              <span className="flex-1 text-text break-words"><span className="sr-only">{t('scrapers:csvUpload.preview.after')} </span>{row.after}</span>
            </div>
          </li>
        ))}
      </ul>
      {truncated ? (
        <div className="px-3 py-2 text-xs text-muted border-t border-border">
          {t('scrapers:csvUpload.preview.truncated', { count: total, shown: rows.length })}
        </div>
      ) : null}
    </div>
  )
}
