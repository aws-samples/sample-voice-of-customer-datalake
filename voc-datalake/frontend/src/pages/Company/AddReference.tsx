/**
 * @fileoverview The "Add reference" form under Company → Design system.
 *
 * A link kind explains, beside the field, why its address cannot be sent (not https, not a URL, no
 * host, credentials, localhost — the API's rules, `./referenceUrl`): from the first character that
 * cannot become `https://`, and after the field loses focus. An address that is already a
 * reference is named, with "Fetch again" on that reference instead of a second (billed) read; the
 * API's 409 says the same when two admins race.
 *
 * @module pages/Company/AddReference
 */
import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link2, Loader2, RefreshCw } from 'lucide-react'
import { designSystemApi, putToPresigned, REFERENCE_KINDS, UPLOAD_LIMITS } from '../../api/designSystemApi'
import type { DesignReference, ReferenceKind, UploadTarget } from '../../api/designSystemApi'
import { ApiError, serverReason } from '../../lib/errors'
import { urlHost } from './designDraftSummary'
import { duplicateReference, isTypingHttps, referenceUrlProblem, typedScheme } from './referenceUrl'
import { useUploadError } from './useUploadError'

/** What happens to each kind once added, in plain words (the upload kinds explain themselves). */
const KIND_HINT_KEYS: Readonly<Record<ReferenceKind, string | null>> = {
  website: 'designSystem.kindHints.website',
  github: 'designSystem.kindHints.github',
  figma: 'designSystem.kindHints.figma',
  screenshot: null,
  html: null,
}

function isReferenceKind(value: string): value is ReferenceKind {
  return REFERENCE_KINDS.some((k) => k === value)
}

/** The upload limits a kind is sent under, or null for link kinds. */
function uploadTargetFor(kind: ReferenceKind): UploadTarget | null {
  if (kind === 'screenshot' || kind === 'html') return kind
  return null
}

/** The link field with its inline, announced reason (and the duplicate's "Fetch again"). */
function UrlField({ kind, url, onChange, references, onFetchAgain }: Readonly<{
  kind: ReferenceKind
  url: string
  onChange: (url: string) => void
  references: readonly DesignReference[]
  onFetchAgain: (id: string) => void
}>) {
  const { t } = useTranslation('settings')
  const messageId = useId()
  const [blurred, setBlurred] = useState(false)
  const problem = referenceUrlProblem(url, kind)
  const shownProblem = problem !== null && (blurred || !isTypingHttps(url)) ? problem : null
  const duplicate = problem === null ? duplicateReference(references, url) : null
  const invalid = shownProblem !== null || duplicate !== null
  return (
    <div>
      <input
        type="url"
        aria-label={t('designSystem.referenceUrl')}
        placeholder="https://"
        value={url}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setBlurred(true)}
        aria-invalid={invalid}
        aria-describedby={invalid ? messageId : undefined}
        className="input w-full"
      />
      <div id={messageId} aria-live="polite">
        {shownProblem ? <p className="text-xs text-danger mt-1">{t(`designSystem.urlProblems.${shownProblem}`, { scheme: typedScheme(url) })}</p> : null}
        {duplicate ? (
          <p className="text-xs text-danger mt-1 flex flex-wrap items-center gap-2">
            {t('designSystem.duplicateReference', { title: duplicate.title || urlHost(duplicate.url ?? '') })}
            <button type="button" onClick={() => onFetchAgain(duplicate.id)} disabled={duplicate.status === 'pending'} className="btn btn-secondary btn-sm inline-flex items-center gap-1">
              <RefreshCw size={12} aria-hidden="true" /> {t('designSystem.refresh')}
            </button>
          </p>
        ) : null}
      </div>
    </div>
  )
}

export default function AddReference({ references, onAdded, onFetchAgain }: Readonly<{
  /** The non-archived references: an address already among them is not added twice. */
  references: readonly DesignReference[]
  onAdded: () => void
  onFetchAgain: (id: string) => void
}>) {
  const { t } = useTranslation('settings')
  const [kind, setKind] = useState<ReferenceKind>('website')
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rejectionFor = useUploadError()
  const uploadTarget = uploadTargetFor(kind)
  const isUpload = uploadTarget !== null

  const add = useMutation({
    mutationFn: async () => {
      const created = await designSystemApi.createReference(isUpload && file
        ? { kind, title: title.trim(), content_type: file.type, size_bytes: file.size }
        : { kind, title: title.trim() || urlHost(url.trim()), url: url.trim() })
      if (isUpload && file) {
        if (!created.upload) throw new Error('no upload target')
        await putToPresigned(created.upload, file)
      }
    },
    // Back to the default kind, so the next reference starts from Live website.
    onSuccess: () => { setKind('website'); setTitle(''); setUrl(''); setFile(null); setError(null); onAdded() },
    onError: (failure) => {
      setError(serverReason(failure) ?? t('designSystem.addReferenceFailed'))
      // A 409 names a reference this page may not list yet: reload so its "Fetch again" shows.
      if (failure instanceof ApiError && failure.status === 409) onAdded()
    },
  })

  const onFile = (picked: File | undefined) => {
    const next = picked ?? null
    const rejection = next && uploadTarget ? rejectionFor(uploadTarget, next) : null
    setError(rejection)
    setFile(rejection === null ? next : null)
  }
  // A link's title may be left empty: the site's host names it.
  const linkReady = url.trim() !== '' && referenceUrlProblem(url, kind) === null && duplicateReference(references, url) === null
  const ready = isUpload ? title.trim() !== '' && file !== null : linkReady
  const hint = KIND_HINT_KEYS[kind]

  return (
    <div className="border border-dashed border-border-strong rounded-md p-3 mt-3 space-y-2">
      <div className="flex flex-col sm:flex-row gap-2">
        <select aria-label={t('designSystem.referenceKind')} value={kind} onChange={(e) => { if (isReferenceKind(e.target.value)) { setKind(e.target.value); setFile(null) } }} className="select sm:w-40">
          {REFERENCE_KINDS.map((k) => <option key={k} value={k}>{t(`designSystem.kinds.${k}`)}</option>)}
        </select>
        <input aria-label={t('designSystem.referenceTitle')} placeholder={isUpload ? t('designSystem.referenceTitle') : t('designSystem.referenceTitleOptional')} value={title} onChange={(e) => setTitle(e.target.value)} className="input flex-1" />
      </div>
      {uploadTarget ? (
        <input
          type="file"
          aria-label={t('designSystem.referenceFile')}
          accept={UPLOAD_LIMITS[uploadTarget].types.join(',')}
          onChange={(e) => onFile(e.target.files?.[0])}
          className="text-sm text-text"
        />
      ) : (
        <UrlField kind={kind} url={url} onChange={(next) => { setUrl(next); setError(null) }} references={references} onFetchAgain={onFetchAgain} />
      )}
      {hint ? <p className="text-xs text-muted">{t(hint)}</p> : null}
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
      <button type="button" onClick={() => add.mutate()} disabled={!ready || add.isPending} className="btn btn-secondary btn-sm flex items-center gap-1.5">
        {add.isPending ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} {t('designSystem.addReference')}
      </button>
    </div>
  )
}
