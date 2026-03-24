/**
 * @fileoverview JSON file upload modal for bulk feedback import.
 * @module pages/Scrapers/JsonUploadModal
 *
 * Allows users to upload a JSON file of feedback items, validates with Zod,
 * previews the data, and imports through the existing processing pipeline.
 */

import { useState, useRef, useCallback, type DragEvent } from 'react'
import { X, Upload, Download, FileJson, AlertCircle, CheckCircle, Loader2, Trash2 } from 'lucide-react'
import { z } from 'zod'
import clsx from 'clsx'
import { api } from '../../api/client'

// ============================================
// Zod Schema — matches pipeline minimum fields
// ============================================

const JsonFeedbackItemSchema = z.object({
  text: z.string().min(1, 'text is required').max(50_000),
  id: z.string().min(1, 'id is required for deduplication').max(256),
  source: z.string().min(1, 'source is required').max(64).optional(),
  source_channel: z.string().max(64).optional(),
  timestamp: z.string().min(1).optional(),
  created_at: z.string().min(1).optional(),
  user_id: z.string().max(256).optional(),
  author: z.string().max(256).optional(),
  rating: z.number().min(1).max(5).optional(),
  title: z.string().max(500).optional(),
  url: z.string().max(2048).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (item) => Boolean(item.timestamp ?? item.created_at),
  { message: 'timestamp (or created_at) is required — provide the original date of the feedback in ISO 8601 format', path: ['timestamp'] }
).refine(
  (item) => Boolean(item.source ?? item.source_channel),
  { message: 'source (or source_channel) is required — identifies where the feedback came from (e.g. "trustpilot", "zendesk")', path: ['source'] }
)

const JsonFeedbackArraySchema = z.array(JsonFeedbackItemSchema).min(1, 'File must contain at least one item').max(500, 'Maximum 500 items per upload')

type JsonFeedbackItem = z.infer<typeof JsonFeedbackItemSchema>

// ============================================
// Template
// ============================================

const TEMPLATE_DATA = {
  _instructions: {
    _note: 'This section is documentation only. Remove it before uploading, or leave it — it will be ignored.',
    _llm_instruction: 'If you are an LLM generating data for this template: produce a JSON array (or an object with an "items" array) following the field definitions below. Every item MUST have: text, id, source, and timestamp. Ensure each "id" is unique within its source to prevent duplicates. Output valid JSON only, no markdown fences.',
    format: 'JSON array of feedback objects. Each object represents one piece of customer feedback.',
    fields: {
      'text (REQUIRED)': 'The feedback content. This is mandatory. Escape newlines as \\n. Do not include HTML tags or control characters.',
      'id (REQUIRED)': 'A unique identifier for this feedback item. Critical for deduplication — if two items share the same id, only the first is kept. Use the original review ID, ticket number, or any stable unique key from your data source.',
      'source (REQUIRED)': 'The channel or origin of the feedback (e.g. "trustpilot", "g2_review", "support_ticket", "nps_survey"). Keep this consistent across imports from the same origin. Used for dashboard filtering and source breakdown.',
      'timestamp (REQUIRED)': 'ISO 8601 datetime of when the feedback was originally created (e.g. "2026-03-20T14:30:00Z"). Use UTC. This drives time-series charts on the dashboard and is used in fallback deduplication.',
      'rating (optional)': 'Numeric rating from 1 to 5. Omit if not applicable.',
      'title (optional)': 'A short title or subject line for the feedback. Max 500 characters.',
      'user_id (optional)': 'Author name or user identifier. Max 256 characters.',
      'url (optional)': 'Direct link to the original feedback. Must start with http:// or https://.',
      'metadata (optional)': 'Flat key-value object for extra context (e.g. {"location": "US", "plan": "enterprise"}). Values must be strings, numbers, or booleans — no nested objects.',
    },
    deduplication: 'The system deduplicates using: sha256(source_platform + ":" + id). If you import the same file twice, items with the same id+source will be skipped automatically. To avoid duplicates: (1) always provide a stable "id" from your source data, (2) keep "source" consistent across imports from the same origin.',
    text_formatting: 'Keep the original text as-is. Do not summarize or paraphrase. Escape special characters for valid JSON. Newlines should be \\n. The system handles language detection, translation, and sentiment analysis automatically.',
    limits: 'Max 500 items per file. Max 50,000 characters per text field. Max 5MB file size.',
  },
  items: [
    {
      id: 'review-2026-0420-001',
      text: 'The delivery was late by 3 days and the package was damaged. Very disappointed with the service.',
      timestamp: '2026-03-20T14:30:00Z',
      source: 'trustpilot',
      rating: 2,
      title: 'Disappointing delivery experience',
      user_id: 'customer_123',
    },
    {
      id: 'review-2026-0421-002',
      text: 'Great product quality, exactly what I expected! Will buy again.',
      timestamp: '2026-03-21T09:15:00Z',
      source: 'trustpilot',
      rating: 5,
      user_id: 'happy_buyer',
    },
    {
      id: 'ticket-4821',
      text: 'Customer support was helpful but slow to respond. Took 48 hours to get a reply.',
      timestamp: '2026-03-19T16:00:00Z',
      source: 'zendesk',
      user_id: 'user_456',
      metadata: { priority: 'medium', channel: 'email' },
    },
  ],
}

function isObjectWithItems(raw: unknown): raw is { items: unknown } {
  return typeof raw === 'object' && raw !== null && 'items' in raw
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function extractJsonArray(raw: unknown): unknown[] | null {
  if (isUnknownArray(raw)) return raw
  if (isObjectWithItems(raw) && isUnknownArray(raw.items)) return raw.items
  return null
}

function formatValidationErrors(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? `Item ${String(issue.path[0])}` : 'Root'
    const field = issue.path.length > 1 ? `.${issue.path.slice(1).map(String).join('.')}` : ''
    return `${path}${field}: ${issue.message}`
  }).slice(0, 10)
}

type ParseResult =
  | { ok: true; data: JsonFeedbackItem[] }
  | { ok: false; errors: string[] }

function parseJsonFeedback(content: string): ParseResult {
  const raw: unknown = JSON.parse(content)
  const arr = extractJsonArray(raw)
  if (!arr) {
    return { ok: false, errors: ['File must contain a JSON array or an object with an "items" array'] }
  }
  const result = JsonFeedbackArraySchema.safeParse(arr)
  if (!result.success) {
    return { ok: false, errors: formatValidationErrors(result.error.issues) }
  }
  return { ok: true, data: result.data }
}

function downloadTemplate() {
  const blob = new Blob([JSON.stringify(TEMPLATE_DATA, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'feedback-template.json'
  a.click()
  URL.revokeObjectURL(url)
}

function validateFileBasics(file: File): string | null {
  if (!file.name.endsWith('.json')) return 'File must be a .json file'
  if (file.size > 5 * 1024 * 1024) return 'File must be smaller than 5MB'
  return null
}

// ============================================
// Sub-components
// ============================================

function SuccessView({ count, onClose }: Readonly<{ count: number; onClose: () => void }>) {
  return (
    <div className="text-center py-8">
      <CheckCircle className="mx-auto h-12 w-12 text-green-500 mb-4" />
      <h3 className="text-lg font-medium text-gray-900 mb-2">
        {count} item{count !== 1 ? 's' : ''} imported
      </h3>
      <p className="text-sm text-gray-500 mb-6">
        Items are now being processed through the pipeline. They'll appear on the dashboard shortly.
      </p>
      <button onClick={onClose} className="btn btn-primary">
        Done
      </button>
    </div>
  )
}

function FormatGuide() {
  return (
    <div className="p-4 bg-gray-50 rounded-lg space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-gray-700">Format guide</div>
        <button
          onClick={downloadTemplate}
          className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium"
        >
          <Download size={14} /> Download template
        </button>
      </div>
      <div className="text-xs text-gray-500 space-y-1.5">
        <p><span className="font-medium text-gray-700">text</span> — the feedback content. Keep the original text as-is.</p>
        <p><span className="font-medium text-gray-700">id</span> — unique identifier from your source data (review ID, ticket number). Critical for deduplication — same id = skipped on re-import.</p>
        <p><span className="font-medium text-gray-700">source</span> — where the feedback came from (e.g. "trustpilot", "zendesk"). Keep consistent across imports from the same origin.</p>
        <p><span className="font-medium text-gray-700">timestamp</span> — ISO 8601 UTC (e.g. 2026-03-20T14:30:00Z). When the feedback was originally created.</p>
        <p><span className="text-gray-400">Optional:</span> rating (1-5), title, user_id, url, metadata (flat key-value).</p>
        <p className="text-gray-400">The template file includes full instructions and LLM-ready documentation.</p>
      </div>
    </div>
  )
}

function PreviewList({ items }: Readonly<{ items: JsonFeedbackItem[] }>) {
  if (items.length === 0) return null
  return (
    <div>
      <h4 className="text-sm font-medium text-gray-700 mb-2">
        Preview — {items.length} item{items.length !== 1 ? 's' : ''}
      </h4>
      <div className="border rounded-lg divide-y max-h-60 overflow-y-auto">
        {items.slice(0, 20).map((item, i) => (
          <PreviewItem key={i} item={item} index={i} />
        ))}
        {items.length > 20 && (
          <div className="px-3 py-2 text-xs text-gray-400 text-center">
            ...and {items.length - 20} more items
          </div>
        )}
      </div>
    </div>
  )
}

function PreviewItem({ item, index }: Readonly<{ item: JsonFeedbackItem; index: number }>) {
  return (
    <div className="px-3 py-2 text-sm">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs text-gray-400 font-mono w-6">#{index + 1}</span>
        {item.rating != null && (
          <span className="text-xs text-amber-600">{'★'.repeat(Math.round(item.rating))}</span>
        )}
        {item.source && (
          <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{item.source}</span>
        )}
        {(item.user_id ?? item.author) && (
          <span className="text-xs text-gray-400">{item.user_id ?? item.author}</span>
        )}
      </div>
      <p className="text-gray-700 line-clamp-2">{item.text}</p>
    </div>
  )
}

function DropZone({ isDragging, fileName, fileInputRef, onDragOver, onDragLeave, onDrop, onFileSelect, onReset }: Readonly<{
  isDragging: boolean
  fileName: string | null
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onDragOver: (e: DragEvent<HTMLDivElement>) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent<HTMLDivElement>) => void
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void
  onReset: () => void
}>) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => fileInputRef.current?.click()}
      className={clsx(
        'border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors',
        isDragging && 'border-blue-400 bg-blue-50',
        !isDragging && fileName && 'border-green-300 bg-green-50/50',
        !isDragging && !fileName && 'border-gray-300 hover:border-gray-400 hover:bg-gray-50',
      )}
    >
      <input ref={fileInputRef} type="file" accept=".json" onChange={onFileSelect} className="hidden" />
      {fileName ? (
        <div className="flex items-center justify-center gap-2">
          <FileJson size={20} className="text-green-600" />
          <span className="text-sm font-medium text-green-700">{fileName}</span>
          <button onClick={(e) => { e.stopPropagation(); onReset() }} className="p-1 hover:bg-green-100 rounded">
            <Trash2 size={14} className="text-gray-400" />
          </button>
        </div>
      ) : (
        <>
          <Upload size={24} className="mx-auto text-gray-400 mb-2" />
          <p className="text-sm text-gray-600">Drop a JSON file here or click to browse</p>
          <p className="text-xs text-gray-400 mt-1">Max 500 items, 5MB</p>
        </>
      )}
    </div>
  )
}

function UploadFooter({ isUploading, itemCount, onImport, onClose }: Readonly<{
  isUploading: boolean
  itemCount: number
  onImport: () => void
  onClose: () => void
}>) {
  return (
    <div className="flex justify-end gap-3 px-6 py-4 border-t bg-gray-50">
      <button onClick={onClose} className="btn btn-secondary">Cancel</button>
      <button
        onClick={onImport}
        disabled={itemCount === 0 || isUploading}
        className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isUploading ? (
          <><Loader2 size={16} className="animate-spin" /> Importing...</>
        ) : (
          <><Upload size={16} /> Import {itemCount} Item{itemCount !== 1 ? 's' : ''}</>
        )}
      </button>
    </div>
  )
}

// ============================================
// Component
// ============================================

interface JsonUploadModalProps {
  readonly isOpen: boolean
  readonly onClose: () => void
}

export default function JsonUploadModal({ isOpen, onClose }: JsonUploadModalProps) {
  const [items, setItems] = useState<JsonFeedbackItem[]>([])
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [fileName, setFileName] = useState<string | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<{ success: boolean; count: number } | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const reset = useCallback(() => {
    setItems([])
    setValidationErrors([])
    setFileName(null)
    setIsUploading(false)
    setUploadResult(null)
    setUploadError(null)
    setIsDragging(false)
  }, [])

  const handleClose = () => {
    reset()
    onClose()
  }

  const processFile = useCallback((file: File) => {
    setUploadResult(null)
    setUploadError(null)

    const basicError = validateFileBasics(file)
    if (basicError) {
      setValidationErrors([basicError])
      return
    }

    const reader = new FileReader()
    reader.onload = (e) => {
      const content = e.target?.result
      if (typeof content !== 'string') {
        setValidationErrors(['Could not read file content'])
        setItems([])
        setFileName(null)
        return
      }
      try {
        const parsed = parseJsonFeedback(content)
        if (!parsed.ok) {
          setValidationErrors(parsed.errors)
          setItems([])
          setFileName(null)
          return
        }
        setItems(parsed.data)
        setValidationErrors([])
        setFileName(file.name)
      } catch {
        setValidationErrors(['Invalid JSON — could not parse file'])
        setItems([])
        setFileName(null)
      }
    }
    reader.readAsText(file)
  }, [])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) processFile(file)
    e.target.value = ''
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) processFile(file)
  }

  const handleImport = async () => {
    if (items.length === 0 || isUploading) return
    setIsUploading(true)
    setUploadError(null)

    try {
      const payload = items.map((item) => ({ ...item }))
      const result = await api.uploadJsonFeedback(payload)
      if (result.success) {
        setUploadResult({ success: true, count: result.imported_count })
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
              <FileJson className="text-blue-600" size={20} />
            </div>
            <h2 className="text-lg font-semibold">JSON Upload</h2>
          </div>
          <button onClick={handleClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {uploadResult?.success ? (
            <SuccessView count={uploadResult.count} onClose={handleClose} />
          ) : (
            <>
              <FormatGuide />

              <DropZone
                isDragging={isDragging}
                fileName={fileName}
                fileInputRef={fileInputRef}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onFileSelect={handleFileSelect}
                onReset={reset}
              />

              {validationErrors.length > 0 && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                  <div className="flex items-start gap-2">
                    <AlertCircle size={16} className="text-red-500 mt-0.5 flex-shrink-0" />
                    <div className="text-sm text-red-700 space-y-1">
                      {validationErrors.map((err, i) => (<div key={i}>{err}</div>))}
                    </div>
                  </div>
                </div>
              )}

              <PreviewList items={items} />

              {uploadError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
                  <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
                  <span>{uploadError}</span>
                </div>
              )}
            </>
          )}
        </div>

        {!uploadResult?.success && (
          <UploadFooter isUploading={isUploading} itemCount={items.length} onImport={handleImport} onClose={handleClose} />
        )}
      </div>
    </div>
  )
}
