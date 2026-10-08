/**
 * @fileoverview Design-system logo and references.
 *
 * References are screenshots / HTML pages (uploaded through a presigned PUT) or
 * Figma / GitHub links (fetched server-side with the integration tokens, then
 * summarised by AI). Archiving keeps the object — nothing is deleted. Admins
 * manage; everyone else sees the list.
 *
 * @module pages/Company/DesignReferences
 */
import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Archive, ExternalLink, FileCode, Frame, GitBranch, Image, Link2, Loader2, RefreshCw, Upload } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import {
  designSystemApi, designSystemKey, putToPresigned, REFERENCE_KINDS, UPLOAD_KINDS, UPLOAD_LIMITS, uploadRejection,
} from '../../api/designSystemApi'
import type { DesignReference, ReferenceKind, ReferenceStatus, UploadTarget } from '../../api/designSystemApi'
import { GroupLabel } from './ContextParts'

// lucide's brand marks (Figma, Github) are deprecated; neutral glyphs instead.
const KIND_ICONS: Record<ReferenceKind, LucideIcon> = { screenshot: Image, html: FileCode, figma: Frame, github: GitBranch }
const STATUS_TONE: Record<ReferenceStatus, string> = {
  pending: 'badge-muted', processing: 'badge-info', ready: 'badge-ok', failed: 'badge-danger', archived: 'badge-muted',
}

function isReferenceKind(value: string): value is ReferenceKind {
  return REFERENCE_KINDS.some((k) => k === value)
}

/** The upload limits a kind is sent under, or null for link kinds. */
function uploadTargetFor(kind: ReferenceKind): UploadTarget | null {
  if (kind === 'screenshot' || kind === 'html') return kind
  return null
}

/** Translates a rejected file into the message the user sees. */
function useUploadError() {
  const { t } = useTranslation('settings')
  return (target: UploadTarget, file: File): string | null => {
    const rejection = uploadRejection(target, file)
    if (rejection === 'type') return t('designSystem.uploadBadType', { name: file.name })
    if (rejection === 'size') return t('designSystem.uploadTooLarge', { name: file.name, mb: UPLOAD_LIMITS[target].maxBytes / 1024 / 1024 })
    return null
  }
}

export function LogoUpload({ logoUrl, canEdit }: Readonly<{ logoUrl: string | undefined; canEdit: boolean }>) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const rejectionFor = useUploadError()
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const target = await designSystemApi.createLogoUpload(file.type, file.size)
      if (!target) throw new Error('no upload target')
      await putToPresigned(target, file)
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: designSystemKey() }),
    onError: () => setError(t('designSystem.uploadFailed')),
  })
  const onFile = (file: File | undefined) => {
    if (!file) return
    const rejection = rejectionFor('logo', file)
    setError(rejection)
    if (rejection === null) upload.mutate(file)
  }

  return (
    <div>
      <GroupLabel>{t('designSystem.logo')}</GroupLabel>
      <div className="flex items-center gap-3">
        <div className="w-16 h-16 rounded-lg border border-border bg-bg-accent flex items-center justify-center overflow-hidden">
          {logoUrl ? <img src={logoUrl} alt={t('designSystem.logoAlt')} className="max-w-full max-h-full object-contain" /> : <Image size={20} className="text-muted" />}
        </div>
        {canEdit ? (
          <>
            {/* tabIndex -1: the button below is the control; the hidden input was a second, invisible Tab stop. */}
            <input ref={inputRef} type="file" tabIndex={-1} accept={UPLOAD_LIMITS.logo.types.join(',')} className="sr-only" aria-label={t('designSystem.uploadLogo')} onChange={(e) => onFile(e.target.files?.[0])} />
            <button type="button" onClick={() => inputRef.current?.click()} disabled={upload.isPending} className="btn btn-secondary btn-sm flex items-center gap-1.5">
              {upload.isPending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} {t('designSystem.uploadLogo')}
            </button>
          </>
        ) : null}
      </div>
      {error ? <p role="alert" className="text-xs text-danger mt-1">{error}</p> : null}
    </div>
  )
}

export function ReferencesPanel({ references, canEdit }: Readonly<{ references: readonly DesignReference[]; canEdit: boolean }>) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const [archiving, setArchiving] = useState<DesignReference | null>(null)
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: designSystemKey() })
  const refresh = useMutation({ mutationFn: designSystemApi.refreshReference, onSuccess: invalidate })
  const archive = useMutation({
    mutationFn: designSystemApi.archiveReference,
    onSuccess: () => { setArchiving(null); invalidate() },
  })
  const visible = references.filter((r) => r.status !== 'archived')

  return (
    <div>
      <GroupLabel>{t('designSystem.references')}</GroupLabel>
      {visible.length === 0 ? <p className="text-sm text-muted italic">{t('designSystem.noReferences')}</p> : null}
      <ul className="space-y-2">
        {visible.map((reference) => (
          <ReferenceRow
            key={reference.id}
            reference={reference}
            canEdit={canEdit}
            refreshing={refresh.isPending && refresh.variables === reference.id}
            onRefresh={() => refresh.mutate(reference.id)}
            onArchive={() => setArchiving(reference)}
          />
        ))}
      </ul>
      {canEdit ? <AddReference onAdded={invalidate} /> : null}
      <ConfirmModal
        isOpen={archiving !== null}
        title={t('designSystem.archiveTitle')}
        message={t('designSystem.archiveMessage', { title: archiving?.title ?? '' })}
        confirmLabel={t('designSystem.archive')}
        variant="warning"
        isLoading={archive.isPending}
        onConfirm={() => { if (archiving) archive.mutate(archiving.id) }}
        onCancel={() => setArchiving(null)}
      />
    </div>
  )
}

function ReferenceRow({ reference, canEdit, refreshing, onRefresh, onArchive }: Readonly<{
  reference: DesignReference
  canEdit: boolean
  refreshing: boolean
  onRefresh: () => void
  onArchive: () => void
}>) {
  const { t } = useTranslation('settings')
  const Icon = KIND_ICONS[reference.kind]
  const isLink = !UPLOAD_KINDS.has(reference.kind)
  return (
    <li className="border border-border rounded-md p-3">
      <div className="flex items-center gap-2">
        <Icon size={16} className="text-muted flex-shrink-0" />
        <span className="text-sm font-medium text-text-strong truncate flex-1">{reference.title || t(`designSystem.kinds.${reference.kind}`)}</span>
        <span className={`badge ${STATUS_TONE[reference.status]}`}>{t(`designSystem.statuses.${reference.status}`)}</span>
        {reference.url ? (
          <a href={reference.url} target="_blank" rel="noopener noreferrer" className="icon-btn" aria-label={t('designSystem.openLink')} title={t('designSystem.openLink')}>
            <ExternalLink size={16} />
          </a>
        ) : null}
        {canEdit && isLink ? (
          <button type="button" onClick={onRefresh} disabled={refreshing} className="icon-btn" aria-label={t('designSystem.refresh')} title={t('designSystem.refresh')}>
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : undefined} />
          </button>
        ) : null}
        {canEdit ? (
          <button type="button" onClick={onArchive} className="icon-btn" aria-label={t('designSystem.archive')} title={t('designSystem.archive')}>
            <Archive size={16} />
          </button>
        ) : null}
      </div>
      {reference.status === 'failed' && reference.error ? <p className="text-xs text-danger mt-2">{reference.error}</p> : null}
      {reference.extracted_summary ? <p className="text-xs text-muted mt-2 line-clamp-3">{reference.extracted_summary}</p> : null}
    </li>
  )
}

function AddReference({ onAdded }: Readonly<{ onAdded: () => void }>) {
  const { t } = useTranslation('settings')
  const [kind, setKind] = useState<ReferenceKind>('figma')
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
        : { kind, title: title.trim(), url: url.trim() })
      if (isUpload && file) {
        if (!created.upload) throw new Error('no upload target')
        await putToPresigned(created.upload, file)
      }
    },
    onSuccess: () => { setTitle(''); setUrl(''); setFile(null); setError(null); onAdded() },
    onError: () => setError(t('designSystem.addReferenceFailed')),
  })

  const onFile = (picked: File | undefined) => {
    const next = picked ?? null
    const rejection = next && uploadTarget ? rejectionFor(uploadTarget, next) : null
    setError(rejection)
    setFile(rejection === null ? next : null)
  }
  const ready = title.trim() !== '' && (isUpload ? file !== null : /^https:\/\//.test(url.trim()))

  return (
    <div className="border border-dashed border-border-strong rounded-md p-3 mt-3 space-y-2">
      <div className="flex flex-col sm:flex-row gap-2">
        <select aria-label={t('designSystem.referenceKind')} value={kind} onChange={(e) => { if (isReferenceKind(e.target.value)) { setKind(e.target.value); setFile(null) } }} className="select sm:w-40">
          {REFERENCE_KINDS.map((k) => <option key={k} value={k}>{t(`designSystem.kinds.${k}`)}</option>)}
        </select>
        <input aria-label={t('designSystem.referenceTitle')} placeholder={t('designSystem.referenceTitle')} value={title} onChange={(e) => setTitle(e.target.value)} className="input flex-1" />
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
        <input type="url" aria-label={t('designSystem.referenceUrl')} placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} className="input" />
      )}
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
      <button type="button" onClick={() => add.mutate()} disabled={!ready || add.isPending} className="btn btn-secondary btn-sm flex items-center gap-1.5">
        {add.isPending ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} {t('designSystem.addReference')}
      </button>
    </div>
  )
}
