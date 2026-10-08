import { Loader2, AlertCircle, AlertTriangle, CalendarClock, CheckCircle, Plus, ArrowLeft, Upload, ClipboardPaste } from 'lucide-react'
import {
  useEffect, useId, useRef, useCallback, useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { scrapersApi } from '../../api/scrapersApi'
import { ApiError } from '../../lib/errors'
import { useManualImportStore } from '../../store/manualImportStore'
import ParsedReviewCard from './ParsedReviewCard'
import { countDefaultedDates, countMissingDates } from './scraper-helpers'
import ModalShell from '../../components/ModalShell/ModalShell'
import SourceDialogHeader from './SourceDialogHeader'

const MAX_CHARACTERS = 10000
const POLL_INTERVAL = 2000

function extractDomainDisplay(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace('www.', '')
    // Capitalize first letter of each part
    const [label = ''] = hostname.split('.')
    return label.charAt(0).toUpperCase() + label.slice(1)
  } catch {
    return ''
  }
}

/** The server's own reason (`{message}` of a 4xx) or the generic fallback. */
function confirmErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.message !== new ApiError(error.status).message) return error.message
  return fallback
}

function InputStep() {
  const { t } = useTranslation('scrapers')
  const id = useId()
  const {
    sourceUrl, rawText, setSourceUrl, setRawText, processingError,
  } = useManualImportStore()
  const detectedSource = sourceUrl === '' ? '' : extractDomainDisplay(sourceUrl)
  const charCount = rawText.length
  const isOverLimit = charCount > MAX_CHARACTERS

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={`${id}-url`} className="block text-sm font-medium text-text mb-1">
          {t('manualImport.sourceUrl')} <span className="text-danger" aria-hidden="true">*</span>
        </label>
        <input
          id={`${id}-url`}
          required
          type="url"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder={t('manualImport.sourceUrlPlaceholder')}
          className="input"
        />
        {detectedSource === '' ? null : <p className="mt-1 text-sm text-ok flex items-center gap-1">
          <CheckCircle size={14} /> {t('manualImport.detected', { source: detectedSource })}
        </p>}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor={`${id}-text`} className="block text-sm font-medium text-text">
            {t('manualImport.pasteReviews')} <span className="text-danger" aria-hidden="true">*</span>
          </label>
          <span className={`text-xs font-mono ${isOverLimit ? 'text-danger font-medium' : 'text-muted'}`}>
            {charCount.toLocaleString()} / {MAX_CHARACTERS.toLocaleString()}
          </span>
        </div>
        <textarea
          id={`${id}-text`}
          required
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder={t('manualImport.pasteReviewsPlaceholder')}
          rows={12}
          className={`input resize-none ${isOverLimit ? 'border-danger' : ''}`}
        />
        {isOverLimit ? <p className="mt-1 text-sm text-danger">
          {t('manualImport.exceedsMax', { max: MAX_CHARACTERS.toLocaleString() })}
        </p> : null}
      </div>

      {processingError != null && processingError !== '' ? <div className="p-3 bg-danger-subtle border border-danger/30 rounded-lg text-sm text-danger flex items-start gap-2">
        <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
        <span>{processingError}</span>
      </div> : null}
    </div>
  )
}

function ProcessingStep() {
  const { t } = useTranslation('scrapers')
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <Loader2 className="h-12 w-12 text-accent-text animate-spin mb-4" />
      <h3 className="text-lg font-medium text-text-strong mb-2">{t('manualImport.parsingTitle')}</h3>
      <p className="text-sm text-muted">{t('manualImport.parsingDescription')}</p>
    </div>
  )
}

function PreviewStep({
  onConfirm, isConfirming,
}: {
  readonly onConfirm: () => void;
  readonly isConfirming: boolean
}) {
  const { t } = useTranslation('scrapers')
  const {
    parsedReviews,
    unparsedSections,
    sourceOrigin,
    processingError,
    updateReview,
    deleteReview,
    addEmptyReview,
    setStep,
  } = useManualImportStore()

  const hasReviews = parsedReviews.length > 0
  const hasValidReviews = parsedReviews.some((r) => r.text.trim().length > 0)
  // POST /scrapers/manual/confirm refuses the whole import (400) when any review
  // lacks a date, so say so here rather than after a silent failed click.
  const missingDates = countMissingDates(parsedReviews)
  // The parse gives a review with no date in the text the import date; say so.
  const defaultedDates = countDefaultedDates(parsedReviews)

  const getReviewCountText = () => {
    if (!hasReviews) return t('manualImport.noReviewsDetected')
    return t('manualImport.reviewsFound', { count: parsedReviews.length })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-text-strong">
            {getReviewCountText()}
          </h3>
          {sourceOrigin != null && sourceOrigin !== '' ? <p className="text-sm text-muted">{t('manualImport.source', { source: sourceOrigin })}</p> : null}
        </div>
        <button
          onClick={() => setStep('input')}
          className="text-sm text-text hover:text-text-strong flex items-center gap-1"
        >
          <ArrowLeft size={14} /> {t('manualImport.backToEdit')}
        </button>
      </div>

      {!hasReviews && (
        <div className="p-4 bg-warn-subtle border border-warn/30 rounded-lg">
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="text-warn mt-0.5" />
            <div>
              <p className="text-sm text-warn font-medium">{t('manualImport.noReviewsTitle')}</p>
              <p className="text-sm text-warn mt-1">
                {t('manualImport.noReviewsDescription')}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3 max-h-96 overflow-y-auto">
        {parsedReviews.map((review, index) => (
          <ParsedReviewCard
            key={`review-${review.text.slice(0, 30)}-${review.author ?? 'anon'}`}
            review={review}
            index={index}
            onUpdate={updateReview}
            onDelete={deleteReview}
          />
        ))}
      </div>

      <button
        onClick={addEmptyReview}
        className="w-full py-2 border-2 border-dashed border-border-strong rounded-lg text-sm text-text hover:border-border-strong hover:text-text flex items-center justify-center gap-2 transition-colors"
      >
        <Plus size={16} /> {t('manualImport.addReviewManually')}
      </button>

      {unparsedSections.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-warn hover:text-warn">
            <AlertTriangle size={14} aria-hidden="true" className="inline mr-1.5 -mt-0.5" />
            {t('manualImport.unparsedSections', { count: unparsedSections.length })}
          </summary>
          <div className="mt-2 p-3 bg-bg-accent rounded-lg text-text max-h-32 overflow-y-auto">
            {unparsedSections.map((section) => (
              <p key={section.slice(0, 50)} className="mb-2 last:mb-0">{section}</p>
            ))}
          </div>
        </details>
      )}

      {defaultedDates > 0 && (
        <p className="text-sm text-muted flex items-start gap-2">
          <CalendarClock size={14} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
          {t('manualImport.datesDefaulted', { count: defaultedDates })}
        </p>
      )}

      {missingDates > 0 && (
        <p className="text-sm text-warn flex items-start gap-2">
          <AlertTriangle size={14} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
          {t('manualImport.datesRequired', { count: missingDates })}
        </p>
      )}

      {processingError != null && processingError !== '' ? (
        <div role="alert" className="p-3 bg-danger-subtle border border-danger/30 rounded-lg text-sm text-danger flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{processingError}</span>
        </div>
      ) : null}

      <div className="flex justify-end gap-3 pt-4 border-t">
        <button
          onClick={onConfirm}
          disabled={!hasValidReviews || missingDates > 0 || isConfirming}
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isConfirming ? (
            <>
              <Loader2 size={16} className="animate-spin" /> {t('manualImport.importing')}
            </>
          ) : (
            <>
              <Upload size={16} /> {t('manualImport.importReviews', { count: parsedReviews.filter((r) => r.text.trim() !== '').length })}
            </>
          )}
        </button>
      </div>
    </div>
  )
}

export default function ManualImportModal() {
  const { t } = useTranslation('scrapers')
  const titleId = useId()
  const {
    isModalOpen,
    step,
    sourceUrl,
    rawText,
    jobId,
    parsedReviews,
    setStep,
    setJobId,
    setSourceOrigin,
    setParsedReviews,
    setUnparsedSections,
    setProcessingError,
    clearDraft,
    resetModal,
    lastUpdated,
  } = useManualImportStore()

  const pollIntervalRef = useRef<number | null>(null)
  // State (not a ref): the value is read during render to drive the disabled +
  // "Importing…" button UI, and mutating a ref never re-renders — with a ref
  // the in-flight state silently never showed.
  const [isConfirming, setIsConfirming] = useState(false)

  // Check for stale draft on mount
  useEffect(() => {
    if (lastUpdated != null && lastUpdated !== '' && !isModalOpen) {
      const lastUpdate = new Date(lastUpdated)
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
      if (lastUpdate > hourAgo && (rawText !== '' || parsedReviews.length > 0)) {
        /* Has recent draft - keep the draft for now */
      }
    }
  }, [lastUpdated, isModalOpen, rawText, parsedReviews.length])

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current != null) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  const pollJobStatus = useCallback(async (id: string) => {
    try {
      const result = await scrapersApi.getManualImportStatus(id)

      if (result.status === 'completed') {
        stopPolling()
        setParsedReviews(result.reviews ?? [])
        setUnparsedSections(result.unparsed_sections ?? [])
        setSourceOrigin(result.source_origin ?? null)
        setStep('preview')
      } else if (result.status === 'failed') {
        stopPolling()
        setProcessingError(result.error ?? 'Processing failed')
        setStep('input')
      }
      // Keep polling if still processing
    } catch {
      stopPolling()
      setProcessingError('Failed to check processing status')
      setStep('input')
    }
  }, [stopPolling, setParsedReviews, setUnparsedSections, setSourceOrigin, setStep, setProcessingError])

  // Start polling when we have a job ID and are in processing step
  useEffect(() => {
    if (step === 'processing' && jobId != null && jobId !== '') {
      void pollJobStatus(jobId)
      pollIntervalRef.current = window.setInterval(() => void pollJobStatus(jobId), POLL_INTERVAL)
    }
    return stopPolling
  }, [step, jobId, pollJobStatus, stopPolling])

  const handleClose = () => {
    stopPolling()
    resetModal()
  }

  const handleParse = async () => {
    if (sourceUrl.trim() === '' || rawText.trim() === '') {
      setProcessingError(t('manualImport.enterBothFields'))
      return
    }

    if (rawText.length > MAX_CHARACTERS) {
      setProcessingError(t('manualImport.exceedsMax', { max: MAX_CHARACTERS }))
      return
    }

    setProcessingError(null)
    setStep('processing')

    try {
      const result = await scrapersApi.startManualImportParse(sourceUrl, rawText)

      if (!result.success) {
        setProcessingError(result.error ?? 'Failed to start parsing')
        setStep('input')
        return
      }

      setJobId(result.job_id)
      setSourceOrigin(result.source_origin ?? null)
      // Polling will start via useEffect
    } catch {
      setProcessingError('Failed to start parsing')
      setStep('input')
    }
  }

  const handleConfirm = async () => {
    if (isConfirming || (jobId == null || jobId === '')) return
    setIsConfirming(true)
    setProcessingError(null)

    try {
      const validReviews = parsedReviews.filter((r) => r.text.trim().length > 0)
      const result = await scrapersApi.confirmManualImport(jobId, validReviews)

      if (result.success) {
        clearDraft()
        resetModal()
        // Refresh to show new feedback
        window.location.reload()
      } else {
        setProcessingError(result.error ?? t('manualImport.importFailed'))
      }
    } catch (error) {
      setProcessingError(confirmErrorText(error, t('manualImport.importFailed')))
    } finally {
      setIsConfirming(false)
    }
  }

  if (!isModalOpen) return null

  const canParse = sourceUrl.trim() !== '' && rawText.trim() !== '' && rawText.length <= MAX_CHARACTERS

  return (
    // ModalShell owns the backdrop click (and Escape) that a full-screen
    // "Close modal" button used to provide — off while reviews are being saved.
    <ModalShell isOpen onClose={handleClose} ariaLabelledBy={titleId} dismissable={!isConfirming} panelClassName="max-w-2xl max-h-[90vh]">
        <SourceDialogHeader titleId={titleId} title={t('manualImport.title')} icon={ClipboardPaste} tone="warn" onClose={handleClose} />

        <div className="dialog-body">
          {step === 'input' && <InputStep />}
          {step === 'processing' && <ProcessingStep />}
          {step === 'preview' && <PreviewStep onConfirm={() => void handleConfirm()} isConfirming={isConfirming} />}
        </div>

        {step === 'input' && (
          <div className="dialog-footer">
            <button onClick={handleClose} className="btn btn-secondary">
              {t('manualImport.cancel')}
            </button>
            <button
              onClick={() => void handleParse()}
              disabled={!Boolean(canParse)}
              className="btn btn-primary"
            >
              {t('manualImport.parseReviews')}
            </button>
          </div>
        )}
    </ModalShell>
  )
}
