/**
 * @fileoverview JSON file upload modal for bulk feedback import.
 * @module pages/Scrapers/JsonUploadModal
 */
import clsx from 'clsx'
import {
  X, Upload, Download, FileJson, AlertCircle, CheckCircle, Loader2, Trash2,
} from 'lucide-react'
import {
  useState, useRef, useCallback, type DragEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { scrapersApi } from '../../api/scrapersApi'
import {
  parseJsonFeedback, downloadTemplate, validateFileBasics, isLargeJsonFile,
} from './jsonUploadSchema'
import type { JsonFeedbackItem } from './jsonUploadSchema'
import { uploadFileToS3 } from '../../api/s3Upload'
import { detectFileFields } from './extraFieldDetection'

// ============================================
// Sub-components
// ============================================

function SuccessView({
  count, isAsync, onClose,
}: Readonly<{
  count: number;
  isAsync: boolean;
  onClose: () => void
}>) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="text-center py-8">
      <CheckCircle className="mx-auto h-12 w-12 text-green-500 mb-4" />
      <h3 className="text-lg font-medium text-gray-900 mb-2">
        {isAsync
          ? t('jsonUpload.largeUploadStarted', { defaultValue: 'Large file uploaded — processing in the background' })
          : t('jsonUpload.itemsImported', { count })}
      </h3>
      <p className="text-sm text-gray-500 mb-6">
        {isAsync
          ? t('jsonUpload.largeUploadNote', { defaultValue: 'The file is being imported and enriched. Rows will appear on the Feedback page as they finish — this can take several minutes for a large file.' })
          : t('jsonUpload.pipelineNote')}
      </p>
      <button onClick={onClose} className="btn btn-primary">{t('jsonUpload.done')}</button>
    </div>
  )
}

function FormatGuide() {
  const { t } = useTranslation('scrapers')
  return (
    <div className="p-4 bg-gray-50 rounded-lg space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-gray-700">{t('jsonUpload.formatGuide')}</div>
        <button onClick={downloadTemplate} className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium">
          <Download size={14} /> {t('jsonUpload.downloadTemplate')}
        </button>
      </div>
      <div className="text-xs text-gray-500 space-y-1.5">
        <p><span className="font-medium text-gray-700">text</span> — {t('jsonUpload.fieldText')}</p>
        <p><span className="font-medium text-gray-700">id</span> — {t('jsonUpload.fieldId')}</p>
        <p><span className="font-medium text-gray-700">source</span> — {t('jsonUpload.fieldSource')}</p>
        <p><span className="font-medium text-gray-700">timestamp</span> — {t('jsonUpload.fieldTimestamp')}</p>
        <p><span className="text-gray-400">{t('jsonUpload.optionalFields')}</span></p>
        <p className="text-gray-400">{t('jsonUpload.templateNote')}</p>
      </div>
    </div>
  )
}

function PreviewItem({
  item, index,
}: Readonly<{
  item: JsonFeedbackItem;
  index: number
}>) {
  return (
    <div className="px-3 py-2 text-sm">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs text-gray-400 font-mono w-6">#{index + 1}</span>
        {item.rating != null && <span className="text-xs text-amber-600">{'★'.repeat(Math.round(item.rating))}</span>}
        {item.source != null && item.source !== '' ? <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{item.source}</span> : null}
        {(item.user_id != null && item.user_id !== '') || (item.author != null && item.author !== '') ? <span className="text-xs text-gray-400">{item.user_id ?? item.author}</span> : null}
      </div>
      <p className="text-gray-700 line-clamp-2">{item.text}</p>
    </div>
  )
}

function PreviewList({ items }: Readonly<{ items: JsonFeedbackItem[] }>) {
  const { t } = useTranslation('scrapers')
  if (items.length === 0) return null
  return (
    <div>
      <h4 className="text-sm font-medium text-gray-700 mb-2">
        {t('jsonUpload.preview', {
          count: items.length,
          plural: items.length === 1 ? '' : 's',
        })}
      </h4>
      <div className="border rounded-lg divide-y max-h-60 overflow-y-auto">
        {items.slice(0, 20).map((item, i) => (
          <PreviewItem key={item.id} item={item} index={i} />
        ))}
        {items.length > 20 && (
          <div className="px-3 py-2 text-xs text-gray-400 text-center">{t('jsonUpload.moreItems', { count: items.length - 20 })}</div>
        )}
      </div>
    </div>
  )
}

function LargeFilePanel({
  file, source, onSourceChange, detectedFields, sourceField, onSourceFieldChange,
}: Readonly<{
  file: File;
  source: string;
  onSourceChange: (value: string) => void;
  detectedFields: string[];
  sourceField: string;
  onSourceFieldChange: (value: string) => void
}>) {
  const { t } = useTranslation('scrapers')
  const sizeMb = (file.size / (1024 * 1024)).toFixed(1)
  return (
    <div className="space-y-3">
      <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
        {t('jsonUpload.largeFileDetected', {
          size: sizeMb,
          defaultValue: `Large file (${sizeMb} MB) — it will be uploaded and processed in the background rather than previewed here.`,
        })}
      </div>
      <div>
        <label htmlFor="large-import-source" className="block text-sm font-medium text-gray-700 mb-1">
          {t('jsonUpload.sourceLabel', { defaultValue: 'Source' })} <span className="text-red-500">*</span>
        </label>
        <input
          id="large-import-source"
          type="text"
          value={source}
          onChange={(e) => onSourceChange(e.target.value)}
          placeholder={t('jsonUpload.sourcePlaceholder', { defaultValue: 'e.g. trustpilot, zendesk' })}
          className="w-full px-3 py-2 border rounded-md text-sm"
        />
        <p className="text-xs text-gray-500 mt-1">
          {t('jsonUpload.sourceHint', { defaultValue: 'Labels where this batch came from. Rows that carry their own source field override this.' })}
        </p>
      </div>
      <SourceFieldMapper
        detectedFields={detectedFields}
        sourceField={sourceField}
        onSourceFieldChange={onSourceFieldChange}
      />
    </div>
  )
}

/**
 * Phase 5: map a per-row source column. When the file carries a few distinct
 * sources (e.g. a column named "platform"), picking it here makes each row take
 * its own source instead of the single file-level label above. Only shown once
 * the file head has yielded field names; a file whose head couldn't be sniffed
 * simply offers no mapping and falls back to the file-level source.
 */
function SourceFieldMapper({
  detectedFields, sourceField, onSourceFieldChange,
}: Readonly<{
  detectedFields: string[];
  sourceField: string;
  onSourceFieldChange: (value: string) => void
}>) {
  const { t } = useTranslation('scrapers')
  if (detectedFields.length === 0) return null
  // Keep a previously-chosen value selectable even if it's not in the sniffed
  // head (the first record may omit an optional column present later).
  const options = sourceField && !detectedFields.includes(sourceField)
    ? [sourceField, ...detectedFields]
    : detectedFields
  return (
    <div>
      <label htmlFor="large-import-source-field" className="block text-sm font-medium text-gray-700 mb-1">
        {t('jsonUpload.sourceFieldLabel', { defaultValue: 'Per-row source field' })}
      </label>
      <select
        id="large-import-source-field"
        value={sourceField}
        onChange={(e) => onSourceFieldChange(e.target.value)}
        className="w-full px-3 py-2 border rounded-md text-sm bg-white"
      >
        <option value="">{t('jsonUpload.sourceFieldNone', { defaultValue: 'None — use the source above for every row' })}</option>
        {options.map((field) => (
          <option key={field} value={field}>{field}</option>
        ))}
      </select>
      <p className="text-xs text-gray-500 mt-1">
        {t('jsonUpload.sourceFieldHint', { defaultValue: "Optional. Pick a column whose value sets each row's source — useful when one file holds a few sources." })}
      </p>
    </div>
  )
}

function LargeFileFooter({
  isUploading, canUpload, onUpload, onClose,
}: Readonly<{
  isUploading: boolean;
  canUpload: boolean;
  onUpload: () => void;
  onClose: () => void
}>) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="flex justify-end gap-3 px-6 py-4 border-t bg-gray-50">
      <button onClick={onClose} className="btn btn-secondary">{t('jsonUpload.cancel')}</button>
      <button onClick={onUpload} disabled={!canUpload || isUploading} className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
        {isUploading
          ? <><Loader2 size={16} className="animate-spin" /> {t('jsonUpload.uploading', { defaultValue: 'Uploading…' })}</>
          : <><Upload size={16} /> {t('jsonUpload.uploadLargeFile', { defaultValue: 'Upload & process' })}</>}
      </button>
    </div>
  )
}

function DropZone({
  isDragging, fileName, fileInputRef, onDragOver, onDragLeave, onDrop, onFileSelect, onReset,
}: Readonly<{
  isDragging: boolean;
  fileName: string | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onDragOver: (e: DragEvent<HTMLButtonElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLButtonElement>) => void
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onReset: () => void
}>) {
  const { t } = useTranslation('scrapers')
  return (
    <button type="button" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onClick={() => fileInputRef.current?.click()}
      className={clsx('border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors w-full',
        isDragging && 'border-blue-400 bg-blue-50', !isDragging && fileName != null && fileName !== '' && 'border-green-300 bg-green-50/50',
        !isDragging && (fileName == null || fileName === '') && 'border-gray-300 hover:border-gray-400 hover:bg-gray-50')}>
      <input ref={fileInputRef} type="file" accept=".json" onChange={onFileSelect} className="hidden" />
      {fileName != null && fileName !== '' ? (
        <div className="flex items-center justify-center gap-2">
          <FileJson size={20} className="text-green-600" />
          <span className="text-sm font-medium text-green-700">{fileName}</span>
          <button onClick={(e) => {
            e.stopPropagation()
            onReset()
          }} className="p-1 hover:bg-green-100 rounded"><Trash2 size={14} className="text-gray-400" /></button>
        </div>
      ) : (
        <>
          <Upload size={24} className="mx-auto text-gray-400 mb-2" />
          <p className="text-sm text-gray-600">{t('jsonUpload.dropHint')}</p>
          <p className="text-xs text-gray-400 mt-1">{t('jsonUpload.dropLimits')}</p>
        </>
      )}
    </button>
  )
}

function UploadFooter({
  isUploading, itemCount, onImport, onClose,
}: Readonly<{
  isUploading: boolean;
  itemCount: number;
  onImport: () => void;
  onClose: () => void
}>) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="flex justify-end gap-3 px-6 py-4 border-t bg-gray-50">
      <button onClick={onClose} className="btn btn-secondary">{t('jsonUpload.cancel')}</button>
      <button onClick={onImport} disabled={itemCount === 0 || isUploading} className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
        {isUploading
          ? <><Loader2 size={16} className="animate-spin" /> {t('jsonUpload.importing')}</>
          : <><Upload size={16} /> {t('jsonUpload.importItems', {
            count: itemCount,
            plural: itemCount === 1 ? '' : 's',
          })}</>}
      </button>
    </div>
  )
}

// ============================================
// Component
// ============================================

interface JsonUploadModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void
}

export default function JsonUploadModal({
  isOpen, onClose,
}: JsonUploadModalProps) {
  const { t } = useTranslation('scrapers')
  const [items, setItems] = useState<JsonFeedbackItem[]>([])
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [fileName, setFileName] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<{
    success: boolean;
    count: number
  } | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  // Set when the picked file is too large to parse/preview in the browser; it is
  // uploaded to S3 and processed asynchronously instead (see handleImport).
  const [largeFile, setLargeFile] = useState<File | null>(null)
  const [largeFileSource, setLargeFileSource] = useState('')
  // Phase 5 mapping: the file's detected field names, and the one the user
  // picks to supply each row's source_platform (empty = none, keep file source).
  const [detectedFields, setDetectedFields] = useState<string[]>([])
  const [sourceField, setSourceField] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const reset = useCallback(() => {
    setItems([]); setValidationErrors([]); setFileName(null)
    setIsUploading(false); setUploadResult(null); setUploadError(null); setIsDragging(false)
    setLargeFile(null); setLargeFileSource(''); setDetectedFields([]); setSourceField('')
  }, [])

  const handleClose = () => {
    reset(); onClose()
  }

  const processFile = useCallback((file: File) => {
    setUploadResult(null); setUploadError(null); setLargeFile(null); setItems([])
    setDetectedFields([]); setSourceField('')
    const basicError = validateFileBasics(file)
    if (basicError != null && basicError !== '') {
      setValidationErrors([basicError]); return
    }
    // Large files are not parsed in the browser — they go straight to S3 and
    // are processed asynchronously. Stage the file and collect a source label
    // instead of previewing rows. Sniff the file head for field names so the
    // mapping step can offer a per-row source column (Phase 5); best-effort, so
    // a head that can't be read just leaves the dropdown empty.
    if (isLargeJsonFile(file)) {
      setLargeFile(file); setFileName(file.name); setValidationErrors([])
      void detectFileFields(file).then(({ fields }) => setDetectedFields(fields))
      return
    }
    const reader = new FileReader()
    reader.onload = (e) => {
      const content = e.target?.result
      if (typeof content !== 'string') {
        setValidationErrors(['Could not read file content']); setItems([]); setFileName(null); return
      }
      try {
        const parsed = parseJsonFeedback(content)
        if (!parsed.ok) {
          setValidationErrors(parsed.errors); setItems([]); setFileName(null); return
        }
        setItems(parsed.data); setValidationErrors([]); setFileName(file.name)
      } catch {
        setValidationErrors(['Invalid JSON — could not parse file']); setItems([]); setFileName(null)
      }
    }
    reader.readAsText(file)
  }, [])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file != null) {
      processFile(file)
    }
    e.target.value = ''
  }
  const handleDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault(); setIsDragging(false)
    const file = e.dataTransfer.files[0]
    processFile(file)
  }

  const handleImport = async () => {
    if (items.length === 0 || isUploading) return
    setIsUploading(true); setUploadError(null)
    try {
      const result = await scrapersApi.uploadJsonFeedback(items.map((item) => ({ ...item })))
      if (result.success) {
        setUploadResult({
          success: true,
          count: result.imported_count,
        })
      } else {
        setUploadError('Import failed')
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setIsUploading(false)
    }
  }

  const handleLargeImport = async () => {
    const source = largeFileSource.trim()
    if (largeFile == null || source === '' || isUploading) return
    setIsUploading(true); setUploadError(null)
    const result = await uploadFileToS3(largeFile, source, sourceField.trim() || undefined)
    setIsUploading(false)
    if (result.ok) {
      // Async path: the file is now in S3 and will be ingested + enriched in the
      // background, so there is no synchronous imported count to report.
      setUploadResult({ success: true, count: 0 })
    } else {
      setUploadError(result.error ?? 'Upload failed')
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/50" onClick={handleClose} aria-label="Close modal" />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center"><FileJson className="text-blue-600" size={20} /></div>
            <h2 className="text-lg font-semibold">{t('jsonUpload.title')}</h2>
          </div>
          <button onClick={handleClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors"><X size={20} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {uploadResult?.success === true ? <SuccessView count={uploadResult.count} isAsync={largeFile != null} onClose={handleClose} /> : (
            <>
              <FormatGuide />
              <DropZone isDragging={isDragging} fileName={fileName} fileInputRef={fileInputRef}
                onDragOver={(e) => {
                  e.preventDefault(); setIsDragging(true)
                }} onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop} onFileSelect={handleFileSelect} onReset={reset} />
              {validationErrors.length > 0 && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                  <div className="flex items-start gap-2">
                    <AlertCircle size={16} className="text-red-500 mt-0.5 flex-shrink-0" />
                    <div className="text-sm text-red-700 space-y-1">{validationErrors.map((err) => (<div key={err}>{err}</div>))}</div>
                  </div>
                </div>
              )}
              {largeFile != null
                ? <LargeFilePanel file={largeFile} source={largeFileSource} onSourceChange={setLargeFileSource}
                    detectedFields={detectedFields} sourceField={sourceField} onSourceFieldChange={setSourceField} />
                : <PreviewList items={items} />}
              {uploadError != null && uploadError !== '' ? <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
                <AlertCircle size={16} className="mt-0.5 flex-shrink-0" /><span>{uploadError}</span>
              </div> : null}
            </>
          )}
        </div>
        {uploadResult?.success !== true && (
          largeFile != null
            ? <LargeFileFooter isUploading={isUploading} canUpload={largeFileSource.trim() !== ''} onUpload={() => void handleLargeImport()} onClose={handleClose} />
            : <UploadFooter isUploading={isUploading} itemCount={items.length} onImport={() => void handleImport()} onClose={handleClose} />
        )}
      </div>
    </div>
  )
}
