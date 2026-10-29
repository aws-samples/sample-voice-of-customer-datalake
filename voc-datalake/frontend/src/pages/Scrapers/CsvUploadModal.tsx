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
 * - the default channel for rows without a channel column;
 * - "Radar source" (`radar_brand`, a key of the Radar brand list): the rows are another
 *   brand's reviews and go to Radar only (docs/radar.md);
 * - an optional dataset name (`dataset_name`, issue #411): a corrected re-upload under the
 *   same name updates the stored rows that carry an id. The upload is then previewed first
 *   (`CsvUpdatePreview`) and stored only once the person confirms (docs/csv-import.md).
 */
import { Upload, Download, FileText, AlertCircle, CheckCircle, Loader2, Eye } from 'lucide-react'
import { useCallback, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { datasetNameProblem } from '../../api/csvDatasetSchema'
import { useInvalidateFeedbackData } from '../../api/invalidateFeedbackData'
import { MANUAL_IMPORT_SOURCE } from '../../api/sourceProfilesApi'
import ModalShell from '../../components/ModalShell/ModalShell'
import SourceProfileSelect from '../../components/DimensionFields/SourceProfileSelect'
import { useDimensionsConfig, useSourceProfiles } from '../../hooks/useDimensions'
import CsvColumnMapping from './CsvColumnMapping'
import { mappingProblem } from './csvColumns'
import SourceDialogHeader from './SourceDialogHeader'
import { downloadFile, formatFileSize } from '../../utils/file'
import { useCsvSelection } from './useCsvSelection'
import RadarSourcePicker from './RadarSourcePicker'
import CsvDatasetField from './CsvDatasetField'
import CsvUpdatePreview from './CsvUpdatePreview'
import { useCsvUploadFlow } from './useCsvUploadFlow'
import type { CsvUploadFlow } from './useCsvUploadFlow'
import type { CsvDatasetPreview, CsvUploadResult } from '../../api/csvDatasetSchema'
import { useRadarBrandLabel } from './useRadarBrands'
import type { CsvPickError, CsvSelection } from './useCsvSelection'
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

const downloadCsvTemplate = () => downloadFile(TEMPLATE, 'feedback-template.csv', 'text/csv;charset=utf-8')

/**
 * The Radar brand the rows go to: the one chosen here, else a legacy profile's (`radar_brand` on
 * source profile ``sourceId``); undefined for our own feedback.
 */
function useRadarBrand(sourceId: string, chosen: string): string | undefined {
  const { data: profiles = [] } = useSourceProfiles()
  return useRadarBrandLabel(chosen) ?? profiles.find((p) => p.id === sourceId)?.radar_brand
}

export default function CsvUploadModal({ isOpen, onClose }: CsvUploadModalProps) {
  const { t } = useTranslation('scrapers')
  const { t: tAll } = useTranslation()
  const titleId = useId()
  const { data: dimensionsConfig } = useDimensionsConfig()
  const dimensions = dimensionsConfig?.dimensions ?? []
  const { selection, error: pickError, pick, setMapping, reset } = useCsvSelection(dimensions)
  const [sourceId, setSourceId] = useState(MANUAL_IMPORT_SOURCE)
  const [radarKey, setRadarKey] = useState('')
  const radarBrand = useRadarBrand(sourceId, radarKey)
  // Empty = the server's own default channel ("CSV upload"); never shown as the raw id `csv_upload`.
  const [defaultSource, setDefaultSource] = useState('')
  const [datasetName, setDatasetName] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const invalidateFeedbackData = useInvalidateFeedbackData()
  const onImported = useCallback((r: CsvUploadResult) => {
    if (r.imported_count > 0) invalidateFeedbackData({ afterIngest: true })
  }, [invalidateFeedbackData])
  const flow = useCsvUploadFlow(onImported)
  const { busy, result, preview } = flow
  const { dataset, blocked } = readiness(selection, datasetName, radarKey)

  const close = useCallback(() => {
    if (busy) return
    reset(); flow.reset(); setRadarKey(''); setDatasetName('')
    onClose()
  }, [busy, onClose, reset, flow])

  const onPickFile = useCallback((f: File | null) => {
    flow.reset()
    void pick(f)
  }, [pick, flow])

  const onSubmit = useCallback(async () => {
    if (!selection) return
    await flow.submit({
      csv_text: selection.text,
      default_source: defaultSource.trim() || undefined,
      source_id: sourceId,
      column_map: selection.mapping,
      ...(radarKey === '' ? {} : { radar_brand: radarKey }),
      ...(dataset === '' ? {} : { dataset_name: dataset }),
    }, t('csvUpload.uploadFailed'))
  }, [selection, defaultSource, sourceId, radarKey, dataset, t, flow])

  if (!isOpen) return null

  return (
    // Not dismissable mid-upload, matching the disabled Cancel / X.
    <ModalShell isOpen onClose={close} ariaLabelledBy={titleId} dismissable={!busy} panelClassName="max-w-2xl max-h-[90vh]">
        <SourceDialogHeader titleId={titleId} title={t('csvUpload.title')} icon={FileText} onClose={close} closeDisabled={busy} />

        <div className="dialog-body space-y-4 overflow-y-auto">
          <FlowView flow={flow} radarBrand={radarBrand} onClose={close} form={(
            <UploadForm
              sourceId={sourceId}
              onSourceIdChange={setSourceId}
              radarKey={radarKey}
              onRadarKeyChange={setRadarKey}
              defaultSource={defaultSource}
              onDefaultSourceChange={setDefaultSource}
              datasetName={datasetName}
              onDatasetNameChange={setDatasetName}
              busy={busy}
              file={selection?.file ?? null}
              onPick={onPickFile}
              fileInputRef={fileInputRef}
              mapping={selection?.mapping}
              dimensions={dimensions}
              onMappingChange={setMapping}
              error={flow.error ?? pickMessage(pickError, tAll)}
            />
          )} />
        </div>
        {result ? null : (
          <UploadFooter
            busy={busy} blocked={blocked} step={footerStep(dataset, preview)}
            onCancel={preview === null ? close : flow.back} onSubmit={() => void onSubmit()}
          />
        )}
    </ModalShell>
  )
}

/** The dataset name to send ('' = none) and whether the form cannot be submitted yet. */
function readiness(selection: CsvSelection | null, datasetName: string, radarKey: string) {
  // A Radar upload has no update path: its dataset name is never sent (the API refuses it).
  const dataset = radarKey === '' ? datasetName.trim() : ''
  const blocked = selection === null || mappingProblem(selection.mapping) !== null
    || (radarKey === '' && datasetNameProblem(datasetName) !== null)
  return { dataset, blocked }
}

const pickMessage = (error: CsvPickError | null, t: (key: string) => string): string | null =>
  error === null ? null : t(PICK_ERRORS[error].messageKey)

// ── Sub-components ─────────────────────────────────────────────────────────

/** The dialog body for the flow's step: the result, the dataset preview, or the form. */
function FlowView({ flow, radarBrand, onClose, form }: {
  readonly flow: CsvUploadFlow; readonly radarBrand: string | undefined
  readonly onClose: () => void; readonly form: ReactNode
}) {
  if (flow.result !== null) return <SuccessView result={flow.result} radarBrand={radarBrand} onClose={onClose} />
  if (flow.preview === null) return <>{form}</>
  return (
    <>
      <CsvUpdatePreview preview={flow.preview} />
      {flow.error === null ? null : <ErrorLine error={flow.error} />}
    </>
  )
}

interface UploadFormProps {
  readonly sourceId: string
  readonly onSourceIdChange: (id: string) => void
  readonly radarKey: string
  readonly onRadarKeyChange: (key: string) => void
  readonly defaultSource: string
  readonly onDefaultSourceChange: (value: string) => void
  readonly datasetName: string
  readonly onDatasetNameChange: (value: string) => void
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
      <FormatGuide onDownload={downloadCsvTemplate} />
      <SourceProfileSelect value={props.sourceId} onChange={props.onSourceIdChange} disabled={props.busy} />
      <RadarSourcePicker value={props.radarKey} onChange={props.onRadarKeyChange} disabled={props.busy} />
      <div>
        <label htmlFor={channelId} className="block text-sm font-medium text-text mb-1">{t('csvUpload.defaultSourceLabel')}</label>
        <input id={channelId} type="text" value={props.defaultSource} onChange={(e) => props.onDefaultSourceChange(e.target.value)} className="input" placeholder={t('csvUpload.defaultSourcePlaceholder')} />
        <p className="text-xs text-muted mt-1">{t('csvUpload.defaultSourceHint')}</p>
      </div>
      <CsvDatasetField value={props.datasetName} onChange={props.onDatasetNameChange} disabled={props.busy} radar={props.radarKey !== ''} />
      <DropZone file={props.file} onPick={props.onPick} fileInputRef={props.fileInputRef} t={t} />
      {props.mapping && <CsvColumnMapping mapping={props.mapping} dimensions={props.dimensions} onChange={props.onMappingChange} />}
      {props.error === null ? null : <ErrorLine error={props.error} />}
    </>
  )
}

function ErrorLine({ error }: { readonly error: string }) {
  return (
    <div role="alert" className="text-sm text-danger inline-flex items-start gap-2">
      <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>{error}</span>
    </div>
  )
}

/** Which step the footer drives: a plain upload, a dataset preview, or confirming one. */
type FooterStep = 'upload' | 'preview' | 'confirm' | 'confirmUpdates'

function footerStep(dataset: string, preview: CsvDatasetPreview | null): FooterStep {
  if (dataset === '') return 'upload'
  if (preview === null) return 'preview'
  return preview.counts.changed > 0 ? 'confirmUpdates' : 'confirm'
}

// Held as `…Key:` data so scripts/i18n-check.mjs sees each message.
const STEP_LABELS: Record<FooterStep, { labelKey: string; busyKey: string }> = {
  upload: { labelKey: 'scrapers:csvUpload.upload', busyKey: 'scrapers:csvUpload.uploading' },
  preview: { labelKey: 'scrapers:csvUpload.preview.check', busyKey: 'scrapers:csvUpload.preview.checking' },
  confirm: { labelKey: 'scrapers:csvUpload.preview.confirm', busyKey: 'scrapers:csvUpload.uploading' },
  confirmUpdates: { labelKey: 'scrapers:csvUpload.preview.confirmUpdates', busyKey: 'scrapers:csvUpload.uploading' },
}

function StepIcon({ busy, step }: { readonly busy: boolean; readonly step: FooterStep }) {
  if (busy) return <Loader2 size={14} className="animate-spin" />
  return step === 'preview' ? <Eye size={14} /> : <Upload size={14} />
}

function UploadFooter({ busy, blocked, step, onCancel, onSubmit }: {
  readonly busy: boolean; readonly blocked: boolean; readonly step: FooterStep
  readonly onCancel: () => void; readonly onSubmit: () => void
}) {
  const { t } = useTranslation()
  const confirming = step === 'confirm' || step === 'confirmUpdates'
  const label = STEP_LABELS[step]
  return (
    <div className="dialog-footer">
      <button onClick={onCancel} disabled={busy} className="btn btn-secondary">
        {t(confirming ? 'scrapers:csvUpload.preview.back' : 'scrapers:csvUpload.cancel')}
      </button>
      <button onClick={onSubmit} disabled={busy || (blocked && !confirming)} className="btn btn-primary">
        <StepIcon busy={busy} step={step} />
        {t(busy ? label.busyKey : label.labelKey)}
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
  const { i18n } = useTranslation()
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
          <div className="text-xs text-muted font-mono">{formatFileSize(file.size, i18n.language)}</div>
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
  result, radarBrand, onClose,
}: {
  readonly result: CsvUploadResult
  /** The chosen profile's Radar brand: its rows go to the Radar page, not the Feedback page. */
  readonly radarBrand: string | undefined
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
        {radarBrand === undefined
          ? t('csvUpload.pipelineNote', { defaultValue: 'Rows will appear on the Feedback page once Bedrock enrichment completes (usually within a minute).' })
          : t('csvUpload.pipelineNoteRadar', { brand: radarBrand })}
      </p>
      {result.counts !== undefined && (result.counts.changed > 0 || result.counts.unchanged > 0) ? (
        <p className="text-sm text-muted mb-4">
          {t('csvUpload.preview.resultUpdated', { count: result.counts.changed })}{' '}
          {t('csvUpload.preview.resultUnchanged', { count: result.counts.unchanged })}
        </p>
      ) : null}
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
