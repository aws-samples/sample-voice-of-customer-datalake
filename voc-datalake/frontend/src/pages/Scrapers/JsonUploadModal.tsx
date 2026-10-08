/**
 * @fileoverview JSON file upload modal for bulk feedback import.
 * @module pages/Scrapers/JsonUploadModal
 */
import clsx from 'clsx'
import { Upload, Download, FileJson, AlertCircle, CheckCircle, Loader2, Trash2 } from 'lucide-react'
import RatingStars from '../../components/RatingStars'
import {
  useId, useState, useRef, useCallback, type DragEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { scrapersApi } from '../../api/scrapersApi'
import {
  parseJsonFeedback, downloadTemplate, validateFileBasics,
} from './jsonUploadSchema'
import type { JsonFeedbackItem } from './jsonUploadSchema'
import ModalShell from '../../components/ModalShell/ModalShell'
import SourceDialogHeader from './SourceDialogHeader'

// ============================================
// Sub-components
// ============================================

function SuccessView({
  count, onClose,
}: Readonly<{
  count: number;
  onClose: () => void
}>) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="text-center py-8">
      <CheckCircle className="mx-auto h-12 w-12 text-ok mb-4" />
      <h3 className="text-lg font-medium text-text-strong mb-2">{t('jsonUpload.itemsImported', { count })}</h3>
      <p className="text-sm text-muted mb-6">{t('jsonUpload.pipelineNote')}</p>
      <button onClick={onClose} className="btn btn-primary">{t('jsonUpload.done')}</button>
    </div>
  )
}

function FormatGuide() {
  const { t } = useTranslation('scrapers')
  return (
    <div className="p-4 bg-bg-accent rounded-lg space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-text">{t('jsonUpload.formatGuide')}</div>
        <button onClick={downloadTemplate} className="flex items-center gap-1.5 text-sm text-accent-text hover:text-accent-hover font-medium">
          <Download size={14} /> {t('jsonUpload.downloadTemplate')}
        </button>
      </div>
      <div className="text-xs text-muted space-y-1.5">
        <p><span className="font-medium text-text">text</span> — {t('jsonUpload.fieldText')}</p>
        <p><span className="font-medium text-text">id</span> — {t('jsonUpload.fieldId')}</p>
        <p><span className="font-medium text-text">source</span> — {t('jsonUpload.fieldSource')}</p>
        <p><span className="font-medium text-text">timestamp</span> — {t('jsonUpload.fieldTimestamp')}</p>
        <p><span className="text-muted">{t('jsonUpload.optionalFields')}</span></p>
        <p className="text-muted">{t('jsonUpload.templateNote')}</p>
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
        <span className="text-xs text-muted font-mono w-6">#{index + 1}</span>
        {item.rating != null && <RatingStars rating={Math.round(item.rating)} size={12} />}
        {item.source != null && item.source !== '' ? <span className="text-xs bg-bg-hover text-muted px-1.5 py-0.5 rounded-sm">{item.source}</span> : null}
        {(item.user_id != null && item.user_id !== '') || (item.author != null && item.author !== '') ? <span className="text-xs text-muted">{item.user_id ?? item.author}</span> : null}
      </div>
      <p className="text-text line-clamp-2">{item.text}</p>
    </div>
  )
}

function PreviewList({ items }: Readonly<{ items: JsonFeedbackItem[] }>) {
  const { t } = useTranslation('scrapers')
  if (items.length === 0) return null
  return (
    <div>
      <h4 className="text-sm font-medium text-text mb-2">
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
          <div className="px-3 py-2 text-xs text-muted text-center">{t('jsonUpload.moreItems', { count: items.length - 20 })}</div>
        )}
      </div>
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
        isDragging && 'border-accent bg-accent-subtle', !isDragging && fileName != null && fileName !== '' && 'border-ok/30 bg-ok-subtle',
        !isDragging && (fileName == null || fileName === '') && 'border-border-strong hover:border-border-strong hover:bg-bg-hover')}>
      <input ref={fileInputRef} type="file" accept=".json" onChange={onFileSelect} className="hidden" />
      {fileName != null && fileName !== '' ? (
        <div className="flex items-center justify-center gap-2">
          <FileJson size={20} className="text-ok" />
          <span className="text-sm font-medium text-ok">{fileName}</span>
          <button onClick={(e) => {
            e.stopPropagation()
            onReset()
          }} className="p-1 hover:bg-ok-subtle rounded-sm"><Trash2 size={14} className="text-muted" /></button>
        </div>
      ) : (
        <>
          <Upload size={24} className="mx-auto text-muted mb-2" />
          <p className="text-sm text-text">{t('jsonUpload.dropHint')}</p>
          <p className="text-xs text-muted mt-1">{t('jsonUpload.dropLimits')}</p>
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
    <div className="dialog-footer">
      <button onClick={onClose} className="btn btn-secondary">{t('jsonUpload.cancel')}</button>
      <button onClick={onImport} disabled={itemCount === 0 || isUploading} className="btn btn-primary">
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
  const titleId = useId()
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
  const fileInputRef = useRef<HTMLInputElement>(null)

  const reset = useCallback(() => {
    setItems([]); setValidationErrors([]); setFileName(null)
    setIsUploading(false); setUploadResult(null); setUploadError(null); setIsDragging(false)
  }, [])

  const handleClose = () => {
    reset(); onClose()
  }

  const processFile = useCallback((file: File) => {
    setUploadResult(null); setUploadError(null)
    const basicError = validateFileBasics(file)
    if (basicError != null && basicError !== '') {
      setValidationErrors([basicError]); return
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
    const file = e.dataTransfer.files.item(0)
    if (file != null) processFile(file)
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

  if (!isOpen) return null

  return (
    // ModalShell owns the backdrop click (and Escape) that a full-screen
    // "Close modal" button used to provide — off while an import is in flight.
    <ModalShell isOpen onClose={handleClose} ariaLabelledBy={titleId} dismissable={!isUploading} panelClassName="max-w-2xl max-h-[90vh]">
        <SourceDialogHeader titleId={titleId} title={t('jsonUpload.title')} icon={FileJson} tone="info" onClose={handleClose} />
        <div className="dialog-body space-y-4">
          {uploadResult?.success === true ? <SuccessView count={uploadResult.count} onClose={handleClose} /> : (
            <>
              <FormatGuide />
              <DropZone isDragging={isDragging} fileName={fileName} fileInputRef={fileInputRef}
                onDragOver={(e) => {
                  e.preventDefault(); setIsDragging(true)
                }} onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop} onFileSelect={handleFileSelect} onReset={reset} />
              {validationErrors.length > 0 && (
                <div className="p-3 bg-danger-subtle border border-danger/30 rounded-lg">
                  <div className="flex items-start gap-2">
                    <AlertCircle size={16} className="text-danger mt-0.5 flex-shrink-0" />
                    <div className="text-sm text-danger space-y-1">{validationErrors.map((err) => (<div key={err}>{err}</div>))}</div>
                  </div>
                </div>
              )}
              <PreviewList items={items} />
              {uploadError != null && uploadError !== '' ? <div className="p-3 bg-danger-subtle border border-danger/30 rounded-lg text-sm text-danger flex items-start gap-2">
                <AlertCircle size={16} className="mt-0.5 flex-shrink-0" /><span>{uploadError}</span>
              </div> : null}
            </>
          )}
        </div>
        {uploadResult?.success !== true && <UploadFooter isUploading={isUploading} itemCount={items.length} onImport={() => void handleImport()} onClose={handleClose} />}
    </ModalShell>
  )
}
