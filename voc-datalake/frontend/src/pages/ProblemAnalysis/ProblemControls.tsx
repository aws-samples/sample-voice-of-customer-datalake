/**
 * @fileoverview Problem Analysis's page-local controls: show resolved, the
 * similarity threshold the tree is merged at, expand/collapse, and PDF export.
 * The feedback filters themselves live in the shared FeedbackFilterPanel.
 *
 * @module pages/ProblemAnalysis/ProblemControls
 */
import { useTranslation } from 'react-i18next'
import { FileDown } from 'lucide-react'

const SIMILARITY_OPTIONS = [
  { value: 0.2, key: 'similarityLow' },
  { value: 0.4, key: 'similarityMed' },
  { value: 0.6, key: 'similarityHigh' },
  { value: 1.0, key: 'similarityOff' },
] as const

interface ProblemControlsProps {
  readonly showResolved: boolean
  readonly onShowResolvedChange: (value: boolean) => void
  /** Resolved problems within the CURRENT filters (what the toggle would reveal). */
  readonly resolvedCount: number
  readonly similarityThreshold: number
  readonly onSimilarityChange: (value: number) => void
  readonly onExpandAll: () => void
  readonly onCollapseAll: () => void
  readonly onExportPdf: () => void
  readonly canExport: boolean
}

export function ProblemControls(props: ProblemControlsProps) {
  const { t } = useTranslation(['problemAnalysis', 'common'])
  const buttonClass = 'btn btn-secondary text-xs px-2 py-1 sm:px-3 sm:py-1.5 active:scale-95'
  return (
    <div className="card !py-3 flex flex-wrap items-center justify-between gap-2 sm:gap-4">
      <label className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
        <input
          type="checkbox"
          checked={props.showResolved}
          onChange={(e) => props.onShowResolvedChange(e.target.checked)}
          className="rounded border-gray-300 w-3.5 h-3.5 sm:w-4 sm:h-4"
        />
        <span>{t('common:problemResolution.showResolved', { total: props.resolvedCount })}</span>
      </label>
      <div className="flex flex-wrap items-center gap-2 sm:gap-4">
        <label className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
          <span className="text-gray-500 hidden xs:inline">{t('filters.similarity')}</span>
          <select
            value={props.similarityThreshold}
            onChange={(e) => props.onSimilarityChange(parseFloat(e.target.value))}
            className="px-2 py-1 border border-gray-300 rounded text-xs sm:text-sm"
          >
            {SIMILARITY_OPTIONS.map((option) => (
              <option key={option.key} value={option.value}>{t(`filters.${option.key}`)}</option>
            ))}
          </select>
        </label>
        <div className="flex gap-1.5 sm:gap-2">
          <button type="button" onClick={props.onExpandAll} className={buttonClass}>{t('filters.expandAll')}</button>
          <button type="button" onClick={props.onCollapseAll} className={buttonClass}>{t('filters.collapseAll')}</button>
          <button
            type="button"
            onClick={props.onExportPdf}
            disabled={!props.canExport}
            className={`${buttonClass} flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed`}
            title={t('common:exportPdfTooltip')}
          >
            <FileDown size={14} />
            {t('common:exportPdfShort')}
          </button>
        </div>
      </div>
    </div>
  )
}
