/**
 * @fileoverview Page title block with an "Export PDF" button, and the
 * centred loading spinner, shared by the Categories and Problem Analysis pages.
 * @module pages/Categories/ExportPageHeader
 */

import { FileDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function CenteredSpinner() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
    </div>
  )
}

export function ExportPageHeader({
  title, subtitle, onExport, exportDisabled = false,
}: {
  readonly title: string
  readonly subtitle: string
  readonly onExport: () => void
  readonly exportDisabled?: boolean
}) {
  const { t } = useTranslation('common')
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-text-strong">{title}</h1>
        <p className="text-sm text-muted mt-1">{subtitle}</p>
      </div>
      <button
        type="button"
        onClick={onExport}
        disabled={exportDisabled}
        className="btn btn-secondary btn-sm self-start sm:self-auto whitespace-nowrap"
        title={t('exportPdfTooltip')}
      >
        <FileDown size={14} aria-hidden="true" />
        {t('exportPdf')}
      </button>
    </div>
  )
}
