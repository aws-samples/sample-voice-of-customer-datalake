import { useEffect, useRef, useCallback } from 'react'
import { X, Loader2, AlertCircle, CheckCircle, Plus, ArrowLeft, Upload, ClipboardPaste } from 'lucide-react'
import { useManualImportStore } from '../../store/manualImportStore'
import { api } from '../../api/client'
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
  const { sourceUrl, rawText, setSourceUrl, setRawText, processingError } = useManualImportStore()
  const detectedSource = sourceUrl ? extractDomainDisplay(sourceUrl) : ''
  const charCount = rawText.length
  const isOverLimit = charCount > MAX_CHARACTERS

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Source URL <span className="text-red-500">*</span>
        </label>
        <input
          type="url"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="https://example.com/reviews"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        {detectedSource && (
          <p className="mt-1 text-sm text-green-600 flex items-center gap-1">
            <CheckCircle size={14} /> Detected: {detectedSource}
          </p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-sm font-medium text-gray-700">
            Paste reviews <span className="text-red-500">*</span>
          </label>
          <span className={`text-sm ${isOverLimit ? 'text-red-500 font-medium' : 'text-gray-500'}`}>
            {charCount.toLocaleString()} / {MAX_CHARACTERS.toLocaleString()}
          </span>
        </div>
        <textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder="Paste the reviews you copied from the website here..."
          rows={12}
          className={`w-full border rounded-lg px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
            isOverLimit ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        {isOverLimit && (
          <p className="mt-1 text-sm text-red-500">
            Text exceeds maximum of {MAX_CHARACTERS.toLocaleString()} characters
          </p>
        )}
      </div>

      {processingError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <span>{processingError}</span>
        </div>
      )}
    </div>
  )
}

function ProcessingStep() {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <Loader2 className="h-12 w-12 text-blue-500 animate-spin mb-4" />
      <h3 className="text-lg font-medium text-gray-900 mb-2">Parsing reviews with AI...</h3>
      <p className="text-sm text-gray-500">This may take 30-60 seconds for large pastes</p>
    </div>
  )
}

function PreviewStep({ onConfirm, isConfirming }: { readonly onConfirm: () => void; readonly isConfirming: boolean }) {
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
    if (!hasReviews) return 'No reviews detected'
    const plural = parsedReviews.length !== 1 ? 's' : ''
    return `${parsedReviews.length} review${plural} found`
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-gray-900">
            {getReviewCountText()}
          </h3>
          {sourceOrigin && (
            <p className="text-sm text-gray-500">Source: {sourceOrigin}</p>
          )}
        </div>
        <button
          onClick={() => setStep('input')}
          className="text-sm text-gray-600 hover:text-gray-900 flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Back to edit
        </button>
      </div>

      {!hasReviews && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="text-amber-600 mt-0.5" />
            <div>
              <p className="text-sm text-amber-800 font-medium">No reviews could be detected</p>
              <p className="text-sm text-amber-700 mt-1">
                The pasted text didn't contain recognizable reviews. You can add reviews manually below.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3 max-h-96 overflow-y-auto">
        {parsedReviews.map((review, index) => (
          <ParsedReviewCard
            key={index}
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
        <Plus size={16} /> Add Review Manually
      </button>

      {unparsedSections.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-amber-600 hover:text-amber-700">
            ⚠️ {unparsedSections.length} section{unparsedSections.length !== 1 ? 's' : ''} could not be parsed
          </summary>
          <div className="mt-2 p-3 bg-gray-50 rounded-lg text-gray-600 max-h-32 overflow-y-auto">
            {unparsedSections.map((section, i) => (
              <p key={i} className="mb-2 last:mb-0">{section}</p>
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
              <Loader2 size={16} className="animate-spin" /> Importing...
            </>
          ) : (
            <>
              <Upload size={16} /> Import {parsedReviews.filter((r) => r.text.trim()).length} Reviews
            </>
          )}
        </button>
      </div>
    </div>
  )
}

export default function ManualImportModal() {
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
    if (lastUpdated && !isModalOpen) {
      const lastUpdate = new Date(lastUpdated)
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
      if (lastUpdate > hourAgo && (rawText || parsedReviews.length > 0)) {
        // Has recent draft - could show "Resume draft?" prompt
        // For now, just keep the draft
      }
    }
  }, [lastUpdated, isModalOpen, rawText, parsedReviews.length])

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }, [])

  const pollJobStatus = useCallback(async (id: string) => {
    try {
      const result = await api.getManualImportStatus(id)
      
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
    if (step === 'processing' && jobId) {
      pollJobStatus(jobId)
      pollIntervalRef.current = window.setInterval(() => pollJobStatus(jobId), POLL_INTERVAL)
    }
    return stopPolling
  }, [step, jobId, pollJobStatus, stopPolling])

  const handleClose = () => {
    stopPolling()
    resetModal()
  }

  const handleParse = async () => {
    if (!sourceUrl.trim() || !rawText.trim()) {
      setProcessingError('Please enter both URL and review text')
      return
    }

    if (rawText.length > MAX_CHARACTERS) {
      setProcessingError(`Text exceeds maximum of ${MAX_CHARACTERS} characters`)
      return
    }

    setProcessingError(null)
    setStep('processing')

    try {
      const result = await api.startManualImportParse(sourceUrl, rawText)
      
      if (!result.success) {
        setProcessingError(result.message ?? 'Failed to start parsing')
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
    if (isConfirmingRef.current || !jobId) return
    isConfirmingRef.current = true

    try {
      const validReviews = parsedReviews.filter((r) => r.text.trim().length > 0)
      const result = await api.confirmManualImport(jobId, validReviews)

      if (result.success) {
        clearDraft()
        resetModal()
        // Could show success toast here
        window.location.reload() // Refresh to show new feedback
      } else {
        setProcessingError(result.message ?? 'Failed to import reviews')
      }
    } catch {
      setProcessingError('Failed to import reviews')
    } finally {
      isConfirmingRef.current = false
    }
  }

  if (!isModalOpen) return null

  const canParse = sourceUrl.trim() && rawText.trim() && rawText.length <= MAX_CHARACTERS

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center">
              <ClipboardPaste className="text-purple-600" size={20} />
            </div>
            <h2 className="text-lg font-semibold">Manual Import</h2>
          </div>
          <button onClick={handleClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {step === 'input' && <InputStep />}
          {step === 'processing' && <ProcessingStep />}
          {step === 'preview' && <PreviewStep onConfirm={handleConfirm} isConfirming={isConfirmingRef.current} />}
        </div>

        {step === 'input' && (
          <div className="flex justify-end gap-3 px-6 py-4 border-t bg-gray-50">
            <button onClick={handleClose} className="btn btn-secondary">
              Cancel
            </button>
            <button
              onClick={handleParse}
              disabled={!canParse}
              className="btn btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Parse Reviews →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
