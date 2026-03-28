import {
  X, Loader2, AlertCircle, CheckCircle, Plus, ArrowLeft, Upload, ClipboardPaste,
} from 'lucide-react'
import {
  useEffect, useRef, useCallback,
} from 'react'
import { useTranslation } from 'react-i18next'
import { scrapersApi } from '../../api/scrapersApi'
import { useManualImportStore } from '../../store/manualImportStore'
import ParsedReviewCard from './ParsedReviewCard'

const MAX_CHARACTERS = 10000
const POLL_INTERVAL = 2000

function extractDomainDisplay(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace('www.', '')
    // Capitalize first letter of each part
    return hostname.split('.')[0].charAt(0).toUpperCase() + hostname.split('.')[0].slice(1)
  } catch {
    return ''
  }
}

function InputStep() {
  const { t } = useTranslation('scrapers')
  const {
    sourceUrl, rawText, setSourceUrl, setRawText, processingError,
  } = useManualImportStore()
  const detectedSource = sourceUrl === '' ? '' : extractDomainDisplay(sourceUrl)
  const charCount = rawText.length
  const isOverLimit = charCount > MAX_CHARACTERS

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t('manualImport.sourceUrl')} <span className="text-red-500">*</span>
        </label>
        <input
          type="url"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder={t('manualImport.sourceUrlPlaceholder')}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        {detectedSource === '' ? null : <p className="mt-1 text-sm text-green-600 flex items-center gap-1">
          <CheckCircle size={14} /> {t('manualImport.detected', { source: detectedSource })}
        </p>}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-sm font-medium text-gray-700">
            {t('manualImport.pasteReviews')} <span className="text-red-500">*</span>
          </label>
          <span className={`text-sm ${isOverLimit ? 'text-red-500 font-medium' : 'text-gray-500'}`}>
            {charCount.toLocaleString()} / {MAX_CHARACTERS.toLocaleString()}
          </span>
        </div>
        <textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder={t('manualImport.pasteReviewsPlaceholder')}
          rows={12}
          className={`w-full border rounded-lg px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
            isOverLimit ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        {isOverLimit ? <p className="mt-1 text-sm text-red-500">
          {t('manualImport.exceedsMax', { max: MAX_CHARACTERS.toLocaleString() })}
        </p> : null}
      </div>

      {processingError != null && processingError !== '' ? <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
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
      <Loader2 className="h-12 w-12 text-blue-500 animate-spin mb-4" />
      <h3 className="text-lg font-medium text-gray-900 mb-2">{t('manualImport.parsingTitle')}</h3>
      <p className="text-sm text-gray-500">{t('manualImport.parsingDescription')}</p>
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
    updateReview,
    deleteReview,
    addEmptyReview,
    setStep,
  } = useManualImportStore()

  const hasReviews = parsedReviews.length > 0
  const hasValidReviews = parsedReviews.some((r) => r.text.trim().length > 0)

  const getReviewCountText = () => {
    if (!hasReviews) return t('manualImport.noReviewsDetected')
    return t('manualImport.reviewsFound', { count: parsedReviews.length })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-gray-900">
            {getReviewCountText()}
          </h3>
          {sourceOrigin != null && sourceOrigin !== '' ? <p className="text-sm text-gray-500">{t('manualImport.source', { source: sourceOrigin })}</p> : null}
        </div>
        <button
          onClick={() => setStep('input')}
          className="text-sm text-gray-600 hover:text-gray-900 flex items-center gap-1"
        >
          <ArrowLeft size={14} /> {t('manualImport.backToEdit')}
        </button>
      </div>

      {!hasReviews && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="text-amber-600 mt-0.5" />
            <div>
              <p className="text-sm text-amber-800 font-medium">{t('manualImport.noReviewsTitle')}</p>
              <p className="text-sm text-amber-700 mt-1">
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
        className="w-full py-2 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-600 hover:border-gray-400 hover:text-gray-700 flex items-center justify-center gap-2 transition-colors"
      >
        <Plus size={16} /> {t('manualImport.addReviewManually')}
      </button>

      {unparsedSections.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-amber-600 hover:text-amber-700">
            {t('manualImport.unparsedSections', { count: unparsedSections.length })}
          </summary>
          <div className="mt-2 p-3 bg-gray-50 rounded-lg text-gray-600 max-h-32 overflow-y-auto">
            {unparsedSections.map((section) => (
              <p key={section.slice(0, 50)} className="mb-2 last:mb-0">{section}</p>
            ))}
          </div>
        </details>
      )}

      <div className="flex justify-end gap-3 pt-4 border-t">
        <button
          onClick={onConfirm}
          disabled={!hasValidReviews || isConfirming}
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
  const isConfirmingRef = useRef(false)

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
    if (isConfirmingRef.current || (jobId == null || jobId === '')) return
    isConfirmingRef.current = true

    try {
      const validReviews = parsedReviews.filter((r) => r.text.trim().length > 0)
      const result = await scrapersApi.confirmManualImport(jobId, validReviews)

      if (result.success) {
        clearDraft()
        resetModal()
        // Refresh to show new feedback
        window.location.reload()
      } else {
        setProcessingError(result.error ?? 'Failed to import reviews')
      }
    } catch {
      setProcessingError('Failed to import reviews')
    } finally {
      isConfirmingRef.current = false
    }
  }

  if (!isModalOpen) return null

  const canParse = sourceUrl.trim() !== '' && rawText.trim() !== '' && rawText.length <= MAX_CHARACTERS

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/50" onClick={handleClose} aria-label="Close modal" />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center">
              <ClipboardPaste className="text-purple-600" size={20} />
            </div>
            <h2 className="text-lg font-semibold">{t('manualImport.title')}</h2>
          </div>
          <button onClick={handleClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {step === 'input' && <InputStep />}
          {step === 'processing' && <ProcessingStep />}
          {step === 'preview' && <PreviewStep onConfirm={() => void handleConfirm()} isConfirming={isConfirmingRef.current} />}
        </div>

        {step === 'input' && (
          <div className="flex justify-end gap-3 px-6 py-4 border-t bg-gray-50">
            <button onClick={handleClose} className="btn btn-secondary">
              {t('manualImport.cancel')}
            </button>
            <button
              onClick={() => void handleParse()}
              disabled={!Boolean(canParse)}
              className="btn btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('manualImport.parseReviews')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
