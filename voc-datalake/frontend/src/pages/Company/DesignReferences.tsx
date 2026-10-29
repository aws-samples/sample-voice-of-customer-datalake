/**
 * @fileoverview Design-system references (the logo upload is ./LogoUpload).
 *
 * References are live websites (opened in a secure browser server-side), Figma /
 * GitHub links (fetched with the integration tokens) or screenshots / HTML pages
 * (uploaded through a presigned PUT), then read by AI into a summary and a
 * structured design (colours, fonts, logo…) shown as a preview. "Use as design
 * system" and "Use this logo" load into the editor as an unsaved draft (Save stores
 * them). Archiving keeps the link or file — nothing is deleted. Admins manage;
 * everyone else sees the list.
 *
 * @module pages/Company/DesignReferences
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Archive, ExternalLink, FileCode, Frame, GitBranch, Globe, Image, Loader2, RefreshCw } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { designSystemApi, designSystemKey, UPLOAD_KINDS } from '../../api/designSystemApi'
import type { DesignReference, DraftLogo, ReferenceKind, ReferenceStatus } from '../../api/designSystemApi'
import { serverReason } from '../../lib/errors'
import AddReference from './AddReference'
import { GroupLabel } from './ContextParts'
import { hasDesign } from './designDraftSummary'
import ReferenceDesignPreview from './ReferenceDesignPreview'
import type { PreviewActions } from './ReferenceDesignPreview'

// lucide's brand marks (Figma, Github) are deprecated; neutral glyphs instead.
const KIND_ICONS: Record<ReferenceKind, LucideIcon> = { website: Globe, screenshot: Image, html: FileCode, figma: Frame, github: GitBranch }
const STATUS_TONE: Record<ReferenceStatus, string> = {
  pending: 'badge-info', ready: 'badge-ok', failed: 'badge-danger', archived: 'badge-muted',
}

/** The apply ("Use as design system") wiring the section owns: the editor lives there. */
export interface ApplyControls {
  applyingId: string | null
  applyErrorFor: (id: string) => string | null
  onApply: (reference: DesignReference) => void
}

/** Archiving keeps what the reference points at: the uploaded file, or the link and what was read from it. */
function archiveMessageKey(kind: ReferenceKind | undefined): string {
  return kind && UPLOAD_KINDS.has(kind) ? 'designSystem.archiveMessage' : 'designSystem.archiveMessageLink'
}

export function ReferencesPanel({ references, canEdit, apply, onLogoDrafted }: Readonly<{
  references: readonly DesignReference[]
  canEdit: boolean
  apply: ApplyControls
  /** "Use this logo": the logo goes into the editor's draft (nothing is saved). */
  onLogoDrafted: (logo: DraftLogo) => void
}>) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const [archiving, setArchiving] = useState<DesignReference | null>(null)
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: designSystemKey() })
  const refresh = useMutation({ mutationFn: designSystemApi.refreshReference, onSuccess: invalidate })
  const archive = useMutation({
    mutationFn: designSystemApi.archiveReference,
    onSuccess: () => { setArchiving(null); invalidate() },
  })
  const adoptLogo = useMutation({
    mutationFn: async (id: string) => {
      const logo = await designSystemApi.draftReferenceLogo(id)
      if (!logo) throw new Error('no logo in the answer')
      return logo
    },
    onSuccess: onLogoDrafted,
  })
  const logoErrorFor = (id: string) => (adoptLogo.isError && adoptLogo.variables === id
    ? serverReason(adoptLogo.error) ?? t('designSystem.preview.logoFailed')
    : null)
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
            preview={canEdit ? {
              applying: apply.applyingId === reference.id,
              applyError: apply.applyErrorFor(reference.id),
              onApply: () => apply.onApply(reference),
              adoptingLogo: adoptLogo.isPending && adoptLogo.variables === reference.id,
              logoError: logoErrorFor(reference.id),
              onAdoptLogo: () => adoptLogo.mutate(reference.id),
            } : undefined}
          />
        ))}
      </ul>
      {canEdit ? <AddReference references={visible} onAdded={invalidate} onFetchAgain={(id) => refresh.mutate(id)} /> : null}
      <ConfirmModal
        isOpen={archiving !== null}
        title={t('designSystem.archiveTitle')}
        message={t(archiveMessageKey(archiving?.kind), { title: archiving?.title ?? '' })}
        confirmLabel={t('designSystem.archive')}
        variant="warning"
        isLoading={archive.isPending}
        onConfirm={() => { if (archiving) archive.mutate(archiving.id) }}
        onCancel={() => setArchiving(null)}
      />
    </div>
  )
}

function StatusBadge({ status }: Readonly<{ status: ReferenceStatus }>) {
  const { t } = useTranslation('settings')
  return (
    <span className={`badge ${STATUS_TONE[status]} inline-flex items-center gap-1`}>
      {status === 'pending' ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : null}
      {t(`designSystem.statuses.${status}`)}
    </span>
  )
}

function ReferenceRow({ reference, canEdit, refreshing, onRefresh, onArchive, preview }: Readonly<{
  reference: DesignReference
  canEdit: boolean
  refreshing: boolean
  onRefresh: () => void
  onArchive: () => void
  preview: PreviewActions | undefined
}>) {
  const { t } = useTranslation('settings')
  const Icon = KIND_ICONS[reference.kind]
  const design = reference.status === 'ready' && hasDesign(reference.extracted_design) ? reference.extracted_design : null
  return (
    <li className="border border-border rounded-md p-3">
      <div className="flex items-center gap-2">
        <Icon size={16} className="text-muted flex-shrink-0" />
        <span className="text-sm font-medium text-text-strong break-words [overflow-wrap:anywhere] flex-1 min-w-0">{reference.title || t(`designSystem.kinds.${reference.kind}`)}</span>
        <StatusBadge status={reference.status} />
        <RowActions reference={reference} canEdit={canEdit} refreshing={refreshing} onRefresh={onRefresh} onArchive={onArchive} />
      </div>
      <RowNotes reference={reference} />
      {design ? <ReferenceDesignPreview design={design} actions={preview} /> : null}
    </li>
  )
}

function RowActions({ reference, canEdit, refreshing, onRefresh, onArchive }: Readonly<{
  reference: DesignReference
  canEdit: boolean
  refreshing: boolean
  onRefresh: () => void
  onArchive: () => void
}>) {
  const { t } = useTranslation('settings')
  const isLink = !UPLOAD_KINDS.has(reference.kind)
  return (
    <>
      {reference.url ? (
        <a href={reference.url} target="_blank" rel="noopener noreferrer" className="icon-btn" aria-label={t('designSystem.openLink')} title={t('designSystem.openLink')}>
          <ExternalLink size={16} />
        </a>
      ) : null}
      {canEdit && isLink ? (
        <button type="button" onClick={onRefresh} disabled={refreshing || reference.status === 'pending'} className="icon-btn" aria-label={t('designSystem.refresh')} title={t('designSystem.refresh')}>
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : undefined} />
        </button>
      ) : null}
      {canEdit ? (
        <button type="button" onClick={onArchive} className="icon-btn" aria-label={t('designSystem.archive')} title={t('designSystem.archive')}>
          <Archive size={16} />
        </button>
      ) : null}
    </>
  )
}

/** "Reading…" detail, the failure reason, and the AI summary. */
function RowNotes({ reference }: Readonly<{ reference: DesignReference }>) {
  const { t } = useTranslation('settings')
  const isLink = !UPLOAD_KINDS.has(reference.kind)
  return (
    <>
      {reference.status === 'pending' ? <p className="text-xs text-muted mt-2">{t(isLink ? 'designSystem.readingHint.link' : 'designSystem.readingHint.file')}</p> : null}
      {reference.status === 'failed' ? <p className="text-xs text-danger mt-2">{reference.error ?? t('designSystem.failedNoReason')}</p> : null}
      {reference.extracted_summary ? <p className="text-xs text-muted mt-2 line-clamp-3">{reference.extracted_summary}</p> : null}
    </>
  )
}
