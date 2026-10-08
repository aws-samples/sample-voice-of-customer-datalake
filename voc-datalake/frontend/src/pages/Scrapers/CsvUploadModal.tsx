/**
 * @fileoverview CSV upload modal — bulk import customer feedback rows from a CSV file.
 *
 * The browser reads the file as text and posts it to /scrapers/manual/csv-upload,
 * which parses it and pushes each row to the same processing queue that
 * ingestor plugins feed into. End result: rows show up in the feedback table
 * with full Bedrock enrichment.
 *
 * Three choices before upload:
 * - the source profile the rows belong to (`source_id`, default `manual_import`),
 *   which decides their PII policy, retention, visibility and default dimensions;
 * - the column mapping (`column_map`), suggested from the header row — fields,
 *   dimension columns, `metadata` (the default for anything unrecognised, so
 *   nothing is dropped) or `ignore`;
 * - the default channel for rows without a channel column.
 */
import { Upload, Download, FileText, AlertCircle, CheckCircle, Loader2 } from 'lucide-react'
import { useCallback, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { scrapersApi } from '../../api/scrapersApi'
import { MANUAL_IMPORT_SOURCE } from '../../api/sourceProfilesApi'
import ModalShell from '../../components/ModalShell/ModalShell'
import SourceProfileSelect from '../../components/DimensionFields/SourceProfileSelect'
import { useDimensionsConfig } from '../../hooks/useDimensions'
import CsvColumnMapping from './CsvColumnMapping'
import { mappingProblem } from './csvColumns'
import SourceDialogHeader from './SourceDialogHeader'
import { useCsvSelection } from './useCsvSelection'
import type { CsvPickError } from './useCsvSelection'
import type { Dimension } from '../../api/dimensionsSchema'
import type { CsvColumnTarget } from '../../api/types'

const TEMPLATE = 'id,text,rating,date,author,channel,tags\n' +
  '1,"Great app, fast and reliable",5,2026-01-15,Alice,app_review,"vip"\n' +
  '2,"Login fails on iOS",1,2026-01-16,Bob,app_review,"login;ios"\n'

// Held as `…Key:` data so scripts/i18n-check.mjs sees each message.
const PICK_ERRORS: Record<CsvPickError, { messageKey: string }> = {
  tooLarge: { messageKey: 'scrapers:csvUpload.errorTooLarge' },
  notCsv: { messageKey: 'scrapers:csvUpload.errorNotCsv' },
  noHeader: { messageKey: 'scrapers:csvUpload.errorNoHeader' },
  unreadable: { messageKey: 'scrapers:csvUpload.errorUnreadable' },
}

interface CsvUploadModalProps {
  readonly isOpen: boolean
  readonly onClose: () => void
}

interface UploadResult {
  imported_count: number
  total_rows: number
  warnings?: string[]
  errors?: string[]
}

function downloadTemplate() {
  const blob = new Blob([TEMPLATE], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'feedback-template.csv'
  a.click()
  URL.revokeObjectURL(url)
}

export default function CsvUploadModal({ isOpen, onClose }: CsvUploadModalProps) {
  const { t } = useTranslation('scrapers')
  const { t: tAll } = useTranslation()
  const titleId = useId()
  const { data: dimensionsConfig } = useDimensionsConfig()
  const dimensions = dimensionsConfig?.dimensions ?? []
  const { selection, error: pickError, pick, setMapping, reset } = useCsvSelection(dimensions)
  const [sourceId, setSourceId] = useState(MANUAL_IMPORT_SOURCE)
  const [defaultSource, setDefaultSource] = useState('csv_upload')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const blocked = selection === null || mappingProblem(selection.mapping) !== null

  const close = useCallback(() => {
    if (busy) return
    reset(); setResult(null); setError(null); setBusy(false)
    onClose()
  }, [busy, onClose, reset])

  const onPickFile = useCallback((f: File | null) => {
    setError(null); setResult(null)
    void pick(f)
  }, [pick])

  const onSubmit = useCallback(async () => {
    if (!selection) return
    setBusy(true); setError(null); setResult(null)
    try {
      const r = await scrapersApi.uploadCsvFeedback({
        csv_text: selection.text,
        default_source: defaultSource.trim() || undefined,
        source_id: sourceId,
        column_map: selection.mapping,
      })
      setResult({ imported_count: r.imported_count, total_rows: r.total_rows, warnings: r.warnings, errors: r.errors })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('csvUpload.uploadFailed'))
    } finally {
      setBusy(false)
    }
  }, [selection, defaultSource, sourceId, t])

  if (!isOpen) return null

  return (
    // Not dismissable mid-upload, matching the disabled Cancel / X.
    <ModalShell isOpen onClose={close} ariaLabelledBy={titleId} dismissable={!busy} panelClassName="max-w-2xl max-h-[90vh]">
        <SourceDialogHeader titleId={titleId} title={t('csvUpload.title')} icon={FileText} tone="ok" onClose={close} closeDisabled={busy} />

        <div className="dialog-body space-y-4 overflow-y-auto">
          {result ? <SuccessView result={result} onClose={close} /> : (
            <UploadForm
              sourceId={sourceId}
              onSourceIdChange={setSourceId}
              defaultSource={defaultSource}
              onDefaultSourceChange={setDefaultSource}
              busy={busy}
              file={selection?.file ?? null}
              onPick={onPickFile}
              fileInputRef={fileInputRef}
              mapping={selection?.mapping}
              dimensions={dimensions}
              onMappingChange={setMapping}
              error={error ?? (pickError === null ? null : tAll(PICK_ERRORS[pickError].messageKey))}
            />
          )}
        </div>
        {result ? null : <UploadFooter busy={busy} blocked={blocked} onCancel={close} onSubmit={() => void onSubmit()} />}
    </ModalShell>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────

interface UploadFormProps {
  readonly sourceId: string
  readonly onSourceIdChange: (id: string) => void
  readonly defaultSource: string
  readonly onDefaultSourceChange: (value: string) => void
  readonly busy: boolean
  readonly file: File | null
  readonly onPick: (f: File | null) => void
  readonly fileInputRef: React.RefObject<HTMLInputElement | null>
  readonly mapping: Record<string, CsvColumnTarget> | undefined
  readonly dimensions: readonly Dimension[]
  readonly onMappingChange: (mapping: Record<string, CsvColumnTarget>) => void
  readonly error: string | null
}

function UploadForm(props: UploadFormProps) {
  const { t } = useTranslation('scrapers')
  const channelId = useId()
  return (
    <>
      <FormatGuide onDownload={downloadTemplate} />
      <SourceProfileSelect value={props.sourceId} onChange={props.onSourceIdChange} disabled={props.busy} />
      <div>
        <label htmlFor={channelId} className="block text-sm font-medium text-text mb-1">{t('csvUpload.defaultSourceLabel')}</label>
        <input id={channelId} type="text" value={props.defaultSource} onChange={(e) => props.onDefaultSourceChange(e.target.value)} className="input" placeholder="csv_upload" />
        <p className="text-xs text-muted mt-1">{t('csvUpload.defaultSourceHint')}</p>
      </div>
      <DropZone file={props.file} onPick={props.onPick} fileInputRef={props.fileInputRef} t={t} />
      {props.mapping && <CsvColumnMapping mapping={props.mapping} dimensions={props.dimensions} onChange={props.onMappingChange} />}
      {props.error === null ? null : (
        <div role="alert" className="text-sm text-danger inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>{props.error}</span>
        </div>
      )}
    </>
  )
}

function UploadFooter({ busy, blocked, onCancel, onSubmit }: {
  readonly busy: boolean; readonly blocked: boolean; readonly onCancel: () => void; readonly onSubmit: () => void
}) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="dialog-footer">
      <button onClick={onCancel} disabled={busy} className="btn btn-secondary">{t('csvUpload.cancel')}</button>
      <button onClick={onSubmit} disabled={busy || blocked} className="btn btn-primary">
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
        {busy ? t('csvUpload.uploading') : t('csvUpload.upload')}
      </button>
    </div>
  )
}

function FormatGuide({ onDownload }: { readonly onDownload: () => void }) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="p-3 bg-bg-accent rounded-lg space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-text">
          {t('csvUpload.formatGuide', { defaultValue: 'CSV format' })}
        </div>
        <button
          onClick={onDownload}
          className="flex items-center gap-1.5 text-sm text-accent-text hover:text-accent-hover font-medium"
        >
          <Download size={14} />
          {t('csvUpload.downloadTemplate', { defaultValue: 'Download template' })}
        </button>
      </div>
      <div className="text-xs text-muted space-y-1">
        <p>
          <span className="font-medium text-text">text</span>{' '}
          {t('csvUpload.fieldText', { defaultValue: '— required. The feedback content.' })}
        </p>
        <p>
          <span className="font-medium text-text">id, rating, date, author, title, url, channel, tags</span>{' '}
          {t('csvUpload.fieldOptional', { defaultValue: '— optional.' })}
        </p>
        <p className="text-muted">
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
      className="block border-2 border-dashed rounded-lg p-6 text-center cursor-pointer border-border-strong hover:border-accent hover:bg-accent-subtle"
      onDragOver={(e) => { e.preventDefault() }}
      onDrop={(e) => {
        e.preventDefault()
        onPick(e.dataTransfer.files.item(0))
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        className="hidden"
      />
      <Upload size={24} className="mx-auto text-muted mb-2" />
      {file ? (
        <div className="text-sm">
          <div className="font-medium text-text">{file.name}</div>
          <div className="text-xs text-muted font-mono">{(file.size / 1024).toFixed(1)} KB</div>
        </div>
      ) : (
        <div className="text-sm text-text">
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
      <CheckCircle className="mx-auto h-10 w-10 text-ok mb-3" />
      <h3 className="text-base font-medium text-text-strong mb-1">
        {t('csvUpload.imported', { count: result.imported_count, defaultValue: '{{count}} rows queued for processing' })}
      </h3>
      <p className="text-sm text-muted mb-4">
        {t('csvUpload.pipelineNote', { defaultValue: 'Rows will appear on the Feedback page once Bedrock enrichment completes (usually within a minute).' })}
      </p>
      {result.warnings && result.warnings.length > 0 ? (
        <div className="text-left text-xs bg-warn-subtle border border-warn/30 rounded-sm p-3 mb-3 max-h-40 overflow-y-auto">
          <div className="font-medium text-warn mb-1">
            {t('csvUpload.warningsHeader', { defaultValue: 'Warnings' })}
          </div>
          <ul className="list-disc pl-4 text-warn space-y-0.5">
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
