/**
 * Document-upload pane for the ProductTab.
 * Extracted from ProductTab.tsx to keep that file under the max-lines budget.
 *
 * Handles drag-and-drop / click-to-pick / paste uploads via presigned S3 URLs,
 * lists uploaded docs with extraction status, and polls while extraction is in
 * flight.
 *
 * Images take one extra step: they are downscaled and re-encoded in the browser
 * (see resizeImage.ts) before anything is declared to the API, because the
 * per-image Converse cap is far below the general file cap and a screenshot
 * routinely exceeds it.
 */
import {
  Upload, FileText, Trash2, CheckCircle2, AlertCircle, Loader2,
} from 'lucide-react'
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import { isImagePrepError, resizeImageForUpload } from './resizeImage'
import type { ProductDoc } from '../../api/types'

/**
 * Exactly the content types the upload boundary accepts — see
 * `ALLOWED_CONTENT_TYPES` in lambda/api/product_context.py. PDF and .docx are
 * deliberately absent: no extractor handles them, so the API refuses them with a
 * "not supported yet". Listing them here would only move that refusal later.
 */
const ALLOWED_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'text/markdown': '.md',
  'text/plain': '.txt',
} as const

type AllowedMime = keyof typeof ALLOWED_MIME

/**
 * Narrows a MIME string to a key of ALLOWED_MIME.
 *
 * A type guard rather than a cast, so the two places that index into the map are
 * checked against it at runtime instead of asserting their way past the
 * compiler — `file.type` is browser-supplied and can be anything, including ''.
 */
function isAllowedMime(value: string): value is AllowedMime {
  return Object.hasOwn(ALLOWED_MIME, value)
}

/**
 * MIME types plus extensions. The MIME types are what the picker filters on
 * (same shape as ImportPersonaModal), and the extensions are there because
 * text/markdown is not a registered type on every OS — without `.md` a Markdown
 * file is unpickable on those.
 */
const ACCEPT_ATTR = [...Object.keys(ALLOWED_MIME), '.md', '.txt'].join(',')

/**
 * Extension list for user-facing messages, derived so adding an accepted type
 * cannot leave the message stale. Deliberately the same rendering as
 * `_ACCEPTED_EXTENSIONS_LABEL` in product_context.py, so a client-side refusal
 * and a server-side one name the same set.
 */
const ACCEPTED_LABEL = [...new Set(Object.values(ALLOWED_MIME))]
  .sort((a, b) => a.localeCompare(b))
  .join(', ')

// Mirrored in lambda/api/product_context.py and pinned to it by
// lambda/shared/test/test_image_limits_lockstep.py, which reads this line as
// source text — keep it a single plain multiplication.
const MAX_FILE_BYTES = 10 * 1024 * 1024

/** Tolerates a clipboard/file collection that is absent rather than empty. */
function toArray<T>(source: ArrayLike<T> | undefined | null): readonly T[] {
  return source ? Array.from(source) : []
}

/**
 * Images carried by a paste.
 *
 * Prefers `items` (the shape every browser fills for a copied bitmap) and falls
 * back to `files`, which is the only one populated for some paste sources.
 * Returning empty is what lets a text paste through untouched.
 */
function pastedImages(clipboard: DataTransfer | null): readonly File[] {
  if (!clipboard) return []
  const fromItems = toArray(clipboard.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
  if (fromItems.length > 0) return fromItems
  return toArray(clipboard.files).filter((file) => file.type.startsWith('image/'))
}

/**
 * A pasted bitmap has no filename. Synthesize one — the list would otherwise
 * render a blank row, and `filename` is required by the upload API.
 */
function withSyntheticName(file: File): File {
  if (file.name) return file
  // The extension comes from ALLOWED_MIME, not from the MIME subtype: the
  // subtype of image/jpeg is "jpeg", while every other name in this app for that
  // type ends `.jpg` (ALLOWED_MIME here, IMAGE_EXTENSIONS in resizeImage.ts,
  // ALLOWED_CONTENT_TYPES server-side). A pasted JPEG already inside both limits
  // passes through resize untouched and keeps whatever name it is given here, so
  // the disagreement is reachable rather than theoretical.
  const ext = isAllowedMime(file.type) ? ALLOWED_MIME[file.type] : '.png'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return new File([file], `pasted-${stamp}${ext}`, { type: file.type })
}

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

  const uploadOne = useCallback(async (file: File) => {
    if (!isAllowedMime(file.type)) {
      setUploadError(t('product.upload.errors.unsupportedType', {
        name: file.name, type: file.type || 'unknown', accepted: ACCEPTED_LABEL,
      }))
      return
    }
    // NON-IMAGES only. An image's size is not yet decided at this point: the
    // resize ladder below re-encodes it, and what the server judges is the
    // PREPARED blob against the image cap. Applying the general cap here refused
    // a 12 MB screenshot as "too large" when the very next step would have
    // brought it to a few hundred KB — a refusal for a limit that was never going
    // to be the binding one. Images too big for the ladder still fail, with the
    // message that names the real reason ('imageTooLarge').
    if (!file.type.startsWith('image/') && file.size > MAX_FILE_BYTES) {
      setUploadError(t('product.upload.errors.tooLarge', { name: file.name }))
      return
    }
    try {
      // Images are downscaled/re-encoded here, so what gets declared and what
      // gets PUT are both the PREPARED blob. The presigned URL signs
      // ContentLength from `size_bytes`, so declaring the original File's size
      // and then PUTting a smaller blob makes S3 reject the upload.
      const prepared = await resizeImageForUpload(file)
      const presigned = await projectsApi.createProductDocUploadUrl(projectId, {
        filename: prepared.filename,
        content_type: prepared.contentType,
        size_bytes: prepared.sizeBytes,
      })
      const putResp = await fetch(presigned.presigned_url, {
        method: 'PUT',
        headers: presigned.headers,
        body: prepared.blob,
      })
      if (!putResp.ok) throw new Error(`S3 PUT ${putResp.status}`)
    } catch (e: unknown) {
      if (isImagePrepError(e)) {
        setUploadError(e.failure === 'too-large'
          ? t('product.upload.errors.imageTooLarge', { name: file.name })
          : t('product.upload.errors.imageUnreadable', { name: file.name }))
        return
      }
      const msg = e instanceof Error ? e.message : 'Upload failed'
      setUploadError(t('product.upload.errors.uploadFailed', { name: file.name, message: msg }))
    }
  }, [projectId, t])

  const handleFiles = useCallback(async (files: ArrayLike<File> | null) => {
    if (!files) return
    setUploadError(null)
    for (const file of toArray(files)) {
      await uploadOne(file)
    }
    refresh()
    if (fileInput.current) fileInput.current.value = ''
  }, [refresh, uploadOne])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const images = pastedImages(e.clipboardData)
    // No image on the clipboard ⇒ do nothing at all, so a paste into a text
    // field inside this pane still behaves like a paste.
    if (images.length === 0) return
    e.preventDefault()
    handleFiles(images.map(withSyntheticName))
  }, [handleFiles])

  // The single activation path for the hidden file input — see the drop zone.
  const openPicker = useCallback(() => { fileInput.current?.click() }, [])

  const onDelete = useCallback(async (docId: string) => {
    try {
      await projectsApi.deleteProductDoc(projectId, docId)
      refresh()
    } catch (e) {
      console.error('Delete failed', e)
    }
  }, [projectId, refresh])

  return (
    // onPaste sits on the pane, not on window: a React paste handler only fires
    // for events originating inside this subtree, so pasting into an input
    // elsewhere on the page is untouched.
    <div className="bg-white border rounded-xl p-4" onPaste={handlePaste}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Upload size={16} className="text-blue-600" /> {t('product.upload.heading')}
        </h3>
        <span className="text-xs text-gray-400">{t('product.upload.hint')}</span>
      </div>

      {/*
        Drag-and-drop zone. preventDefault on dragOver/dragEnter is required:
        without it the browser falls back to "open the dropped file" and navigates
        away from the app.

        role="button" on a div rather than a <label> wrapping the input, and the
        input is a SIBLING rather than a child. Both details are about there being
        exactly ONE way to open the picker per input modality:
          - a <label> associated with a file input has its own activation
            behaviour, which on some browsers synthesizes a click on the control;
            adding an Enter/Space handler that also calls input.click() can then
            open two dialogs;
          - if the input were nested, `input.click()` would bubble a click event
            back up to this element's own onClick, which would call click() again.
        A div with role="button" has no built-in keyboard activation, so onClick
        (pointer) and the keyboard handlers (Enter on keydown, Space on keyup) are
        the only paths, and they cannot fire for the same gesture. The div is still focusable, which is
        what lets a keyboard user land here and paste — the input is
        display:none and cannot take focus itself.

        aria-label reuses the visible drop-zone string rather than introducing a
        second one to translate; role="button" + that name is what makes the focus
        stop announce as an activatable control.
      */}
      <div
        role="button"
        tabIndex={0}
        aria-label={t('product.upload.dropZone')}
        className={`block border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
          dragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-400 hover:bg-blue-50'
        }`}
        onClick={openPicker}
        onKeyDown={(e) => {
          // Enter activates on keydown, Space on keyUP — the ARIA APG button
          // pattern, and not a formality: a held Space repeats keydown, so
          // activating there opens a file dialog per repeat. preventDefault still
          // happens on the Space keydown, because that is the event whose default
          // action scrolls the page.
          if (e.key === 'Enter') {
            e.preventDefault()
            openPicker()
            return
          }
          if (e.key === ' ') e.preventDefault()
        }}
        onKeyUp={(e) => {
          if (e.key !== ' ') return
          e.preventDefault()
          openPicker()
        }}
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
        <div className="text-sm text-gray-600">
          <Upload size={20} className="mx-auto text-gray-400 mb-1" />
          {t('product.upload.dropZone')}
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        onChange={(e) => handleFiles(e.target.files)}
        className="hidden"
      />

      {/* PDF/DOCX are named explicitly rather than just omitted: they used to be
          accepted here, so a user who uploaded one before needs to read "not
          yet". Full width, unlike the header hint, which has a narrow slot. */}
      <p className="mt-2 text-xs text-gray-400">
        {t('product.upload.accepted')}
        {' · '}
        {t('product.upload.notYet')}
      </p>

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
                {/* The reason is carried in its own red span, not the gray-400
                    metadata colour this line otherwise uses. Two reasons: at 12px
                    #9ca3af on white is ~2.5:1, under the 4.5:1 WCAG 1.4.3 floor;
                    and a failure reason styled as metadata reads like metadata.
                    Only reachable from this rung on — nothing wrote `failed`
                    before it, so this text had never actually rendered. */}
                {d.status === 'failed' && d.error && (
                  <>{' · '}<span className="text-red-600">{d.error}</span></>
                )}
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
