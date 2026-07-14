/**
 * Document-upload pane for the ProductTab.
 * Extracted from ProductTab.tsx to keep that file under the max-lines budget.
 *
 * Handles drag-and-drop / click-to-pick uploads via presigned S3 URLs, lists
 * uploaded docs with extraction status, and polls while extraction is in
 * flight.
 */
import {
  Upload, FileText, Trash2, CheckCircle2, AlertCircle, Loader2,
} from 'lucide-react'
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import type { ProductDoc } from '../../api/types'

const ALLOWED_MIME = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'text/markdown': '.md',
  'text/plain': '.txt',
} as const

const MAX_FILE_BYTES = 10 * 1024 * 1024

export function DocsUpload({ projectId }: { readonly projectId: string }) {
  // Owns its namespace so i18next-parser attributes product.upload.* keys to
  // projectDetail.json (a passed-in `t` prop gets attributed to `common`).
  const { t } = useTranslation('projectDetail')
  const [docs, setDocs] = useState<ProductDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await projectsApi.listProductDocs(projectId)
      setDocs(r.docs)
    } catch (e) {
      console.error('Failed to list product docs', e)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  // Initial load uses the promise-callback lifecycle pattern (all setState
  // happens asynchronously in .then/.finally); `refresh` stays for polling
  // and post-upload updates, which run from timer/event contexts.
  useEffect(() => {
    const lifecycle = { cancelled: false }
    projectsApi.listProductDocs(projectId).then((r) => {
      if (!lifecycle.cancelled) setDocs(r.docs)
    }).catch((e) => {
      console.error('Failed to list product docs', e)
    }).finally(() => {
      if (!lifecycle.cancelled) setLoading(false)
    })
    return () => { lifecycle.cancelled = true }
  }, [projectId])

  const inFlight = useMemo(() => docs.some((d) => d.status === 'pending' || d.status === 'extracting'), [docs])
  useEffect(() => {
    if (!inFlight) return
    const start = Date.now()
    const id = setInterval(() => {
      if (Date.now() - start > 60_000) { clearInterval(id); return }
      refresh()
    }, 3000)
    return () => clearInterval(id)
  }, [inFlight, refresh])

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files) return
    setUploadError(null)
    for (const file of Array.from(files)) {
      if (!(file.type in ALLOWED_MIME)) {
        setUploadError(t('product.upload.errors.unsupportedType', { name: file.name, type: file.type || 'unknown' }))
        continue
      }
      if (file.size > MAX_FILE_BYTES) {
        setUploadError(t('product.upload.errors.tooLarge', { name: file.name }))
        continue
      }
      try {
        const presigned = await projectsApi.createProductDocUploadUrl(projectId, {
          filename: file.name,
          content_type: file.type,
          size_bytes: file.size,
        })
        const putResp = await fetch(presigned.presigned_url, {
          method: 'PUT',
          headers: presigned.headers,
          body: file,
        })
        if (!putResp.ok) throw new Error(`S3 PUT ${putResp.status}`)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Upload failed'
        setUploadError(t('product.upload.errors.uploadFailed', { name: file.name, message: msg }))
      }
    }
    refresh()
    if (fileInput.current) fileInput.current.value = ''
  }, [projectId, refresh, t])

  const onDelete = useCallback(async (docId: string) => {
    try {
      await projectsApi.deleteProductDoc(projectId, docId)
      refresh()
    } catch (e) {
      console.error('Delete failed', e)
    }
  }, [projectId, refresh])

  return (
    <div className="bg-white border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Upload size={16} className="text-blue-600" /> {t('product.upload.heading')}
        </h3>
        <span className="text-xs text-gray-400">{t('product.upload.hint')}</span>
      </div>

      {/*
        Drag-and-drop wrapper. preventDefault on dragOver/dragEnter is required:
        without it the browser falls back to "open the dropped file" and navigates
        away from the app. The hidden file input still handles click-to-pick.
      */}
      <label
        className={`block border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
          dragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-400 hover:bg-blue-50'
        }`}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragActive(true) }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragActive(true) }}
        onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragActive(false) }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragActive(false)
          handleFiles(e.dataTransfer.files)
        }}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={Object.values(ALLOWED_MIME).join(',')}
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
        />
        <div className="text-sm text-gray-600">
          <Upload size={20} className="mx-auto text-gray-400 mb-1" />
          {t('product.upload.dropZone')}
        </div>
      </label>

      {uploadError && (
        <div className="mt-2 text-xs text-red-600 inline-flex items-center gap-1">
          <AlertCircle size={12} /> {uploadError}
        </div>
      )}

      <ul className="mt-3 space-y-2">
        {loading && <li className="text-xs text-gray-400">{t('product.upload.loading')}</li>}
        {!loading && docs.length === 0 && (
          <li className="text-xs text-gray-400">{t('product.upload.empty')}</li>
        )}
        {docs.map((d) => (
          <li key={d.doc_id} className="flex items-center justify-between border rounded-md px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <FileText size={14} className="text-gray-400 flex-shrink-0" />
                <span className="truncate">{d.filename}</span>
                <DocStatusBadge status={d.status} error={d.error} />
              </div>
              <div className="text-xs text-gray-400 mt-0.5">
                {/* size_bytes can be 0/missing on legacy records — hide the KB
                    label rather than rendering "0.0 KB", which reads as broken */}
                {d.size_bytes > 0 ? `${(d.size_bytes / 1024).toFixed(1)} KB` : null}
                {d.status === 'ready' && (d.size_bytes > 0 ? ' · ' : '') + t('product.upload.extractedChars', { count: d.extracted_chars })}
                {d.status === 'failed' && d.error && ` · ${d.error}`}
              </div>
            </div>
            <button
              onClick={() => onDelete(d.doc_id)}
              className="ml-2 text-gray-400 hover:text-red-600"
              aria-label={t('product.upload.delete')}
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function DocStatusBadge({ status, error }: { readonly status: ProductDoc['status']; readonly error: string | null }) {
  const { t } = useTranslation('projectDetail')
  if (status === 'ready') {
    return <span className="inline-flex items-center gap-1 text-xs text-green-700"><CheckCircle2 size={12} /> {t('product.upload.statusReady')}</span>
  }
  if (status === 'failed') {
    return <span className="inline-flex items-center gap-1 text-xs text-red-600" title={error || ''}><AlertCircle size={12} /> {t('product.upload.statusFailed')}</span>
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-500">
      <Loader2 size={12} className="animate-spin" />
      {status === 'pending' ? t('product.upload.statusUploading') : t('product.upload.statusExtracting')}
    </span>
  )
}
