/**
 * @fileoverview CSV upload modal — bulk import customer feedback rows from a CSV file.
 *
 * The browser reads the file as text and posts it to /scrapers/manual/csv-upload,
 * which parses, archives the original to S3, and pushes each row to the same
 * processing queue that ingestor plugins (iOS, Android, etc.) feed into. End
 * result: rows show up in the feedback table with full Bedrock enrichment.
 *
 * Required column: `text`. Optional: `id`, `rating`, `date`/`timestamp`, `author`,
 * `title`, `url`, `source`. Header names are case-insensitive; common synonyms
 * (review, comment, stars, score, user, name) are accepted server-side.
 */
import {
  X, Upload, Download, FileText, AlertCircle, CheckCircle, Loader2,
} from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { scrapersApi } from '../../api/scrapersApi'

const MAX_BYTES = 10 * 1024 * 1024
const TEMPLATE = 'id,text,rating,date,author,source\n' +
  '1,"Great app, fast and reliable",5,2026-01-15,Alice,app_review\n' +
  '2,"Login fails on iOS",1,2026-01-16,Bob,app_review\n'

interface CsvUploadModalProps {
  readonly isOpen: boolean
  readonly onClose: () => void
}

export default function CsvUploadModal({ isOpen, onClose }: CsvUploadModalProps) {
  const { t } = useTranslation('scrapers')
  const [file, setFile] = useState<File | null>(null)
  const [defaultSource, setDefaultSource] = useState('csv_upload')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    imported_count: number
    total_rows: number
    warnings?: string[]
    errors?: string[]
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const close = useCallback(() => {
    if (busy) return
    setFile(null); setResult(null); setError(null); setBusy(false)
    onClose()
  }, [busy, onClose])

  const downloadTemplate = useCallback(() => {
    const blob = new Blob([TEMPLATE], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'feedback-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  const onPickFile = useCallback((f: File | null) => {
    setError(null); setResult(null)
    if (!f) { setFile(null); return }
    if (f.size > MAX_BYTES) {
      setError(t('csvUpload.errorTooLarge', { defaultValue: 'File exceeds 10 MB limit.' }))
      return
    }
    if (!/\.csv$/i.test(f.name) && f.type !== 'text/csv') {
      setError(t('csvUpload.errorNotCsv', { defaultValue: 'Please select a .csv file.' }))
      return
    }
    setFile(f)
  }, [t])

  const onSubmit = useCallback(async () => {
    if (!file) return
    setBusy(true); setError(null); setResult(null)
    try {
      const csvText = await file.text()
      const r = await scrapersApi.uploadCsvFeedback({
        csv_text: csvText,
        default_source: defaultSource.trim() || undefined,
      })
      setResult({
        imported_count: r.imported_count,
        total_rows: r.total_rows,
        warnings: r.warnings,
        errors: r.errors,
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Upload failed'
      setError(msg)
    } finally {
      setBusy(false)
    }
  }, [file, defaultSource])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <FileText size={18} className="text-emerald-600" />
            {t('csvUpload.title', { defaultValue: 'CSV upload' })}
          </h2>
          <button onClick={close} disabled={busy} className="text-gray-400 hover:text-gray-600 disabled:opacity-50">
            <X size={20} />
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-4">
          {result ? (
            <SuccessView result={result} onClose={close} />
          ) : (
            <>
              <FormatGuide onDownload={downloadTemplate} />

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('csvUpload.defaultSourceLabel', { defaultValue: 'Default source label' })}
                </label>
                <input
                  type="text"
                  value={defaultSource}
                  onChange={(e) => setDefaultSource(e.target.value)}
                  className="w-full px-3 py-2 border rounded-md text-sm"
                  placeholder="csv_upload"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t('csvUpload.defaultSourceHint', { defaultValue: 'Used for rows that don\'t have a "source" column.' })}
                </p>
              </div>

              <DropZone file={file} onPick={onPickFile} fileInputRef={fileInputRef} t={t} />

              {error ? (
                <div className="text-sm text-red-600 inline-flex items-start gap-2">
                  <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>{error}</span>
                </div>
              ) : null}
            </>
          )}
        </div>

        {!result ? (
          <div className="flex items-center justify-end gap-2 p-4 border-t">
            <button onClick={close} disabled={busy} className="btn btn-secondary">
              {t('csvUpload.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              onClick={onSubmit}
              disabled={busy || !file}
              className="btn btn-primary inline-flex items-center gap-2"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              {busy
                ? t('csvUpload.uploading', { defaultValue: 'Uploading…' })
                : t('csvUpload.upload', { defaultValue: 'Upload' })}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────

function FormatGuide({ onDownload }: { readonly onDownload: () => void }) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="p-3 bg-gray-50 rounded-lg space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-gray-700">
          {t('csvUpload.formatGuide', { defaultValue: 'CSV format' })}
        </div>
        <button
          onClick={onDownload}
          className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium"
        >
          <Download size={14} />
          {t('csvUpload.downloadTemplate', { defaultValue: 'Download template' })}
        </button>
      </div>
      <div className="text-xs text-gray-500 space-y-1">
        <p>
          <span className="font-medium text-gray-700">text</span>{' '}
          {t('csvUpload.fieldText', { defaultValue: '— required. The feedback content.' })}
        </p>
        <p>
          <span className="font-medium text-gray-700">id, rating, date, author, title, url, source</span>{' '}
          {t('csvUpload.fieldOptional', { defaultValue: '— optional.' })}
        </p>
        <p className="text-gray-400">
          {t('csvUpload.headerNote', { defaultValue: 'Headers are case-insensitive. Up to 50,000 rows / 10 MB per upload.' })}
        </p>
      </div>
    </div>
  )
}

function DropZone({
  file, onPick, fileInputRef, t,
}: {
  readonly file: File | null
  readonly onPick: (f: File | null) => void
  readonly fileInputRef: React.RefObject<HTMLInputElement | null>
  readonly t: (k: string, opts?: Record<string, unknown>) => string
}) {
  return (
    <label
      className="block border-2 border-dashed rounded-lg p-6 text-center cursor-pointer border-gray-300 hover:border-blue-400 hover:bg-blue-50"
      onDragOver={(e) => { e.preventDefault() }}
      onDrop={(e) => {
        e.preventDefault()
        const f = e.dataTransfer.files?.[0] ?? null
        onPick(f)
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        className="hidden"
      />
      <Upload size={24} className="mx-auto text-gray-400 mb-2" />
      {file ? (
        <div className="text-sm">
          <div className="font-medium text-gray-700">{file.name}</div>
          <div className="text-xs text-gray-500">{(file.size / 1024).toFixed(1)} KB</div>
        </div>
      ) : (
        <div className="text-sm text-gray-600">
          {t('csvUpload.dropZone', { defaultValue: 'Drop a .csv file here or click to choose' })}
        </div>
      )}
    </label>
  )
}

function SuccessView({
  result, onClose,
}: {
  readonly result: { imported_count: number; total_rows: number; warnings?: string[]; errors?: string[] }
  readonly onClose: () => void
}) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="text-center py-4">
      <CheckCircle className="mx-auto h-10 w-10 text-green-500 mb-3" />
      <h3 className="text-base font-medium text-gray-900 mb-1">
        {t('csvUpload.imported', { count: result.imported_count, defaultValue: '{{count}} rows queued for processing' })}
      </h3>
      <p className="text-sm text-gray-500 mb-4">
        {t('csvUpload.pipelineNote', { defaultValue: 'Rows will appear on the Feedback page once Bedrock enrichment completes (usually within a minute).' })}
      </p>
      {result.warnings && result.warnings.length > 0 ? (
        <div className="text-left text-xs bg-amber-50 border border-amber-200 rounded p-3 mb-3 max-h-40 overflow-y-auto">
          <div className="font-medium text-amber-700 mb-1">
            {t('csvUpload.warningsHeader', { defaultValue: 'Warnings' })}
          </div>
          <ul className="list-disc pl-4 text-amber-700 space-y-0.5">
            {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      ) : null}
      <button onClick={onClose} className="btn btn-primary">
        {t('csvUpload.done', { defaultValue: 'Done' })}
      </button>
    </div>
  )
}
