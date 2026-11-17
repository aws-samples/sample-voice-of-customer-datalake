/**
 * The Versions list under a document (QA s3 F4): every version, newest first, to
 * open, compare with the current one, or restore.
 *
 * Every edit is a new version (a PRD / PR/FAQ edit is the next `(vN)` of its
 * series; a research / custom edit saves what it replaced), so nothing a user or
 * the assistant overwrote is lost. Restoring adds a NEW version with the old
 * content — history is only added to. Shown in the document page's History dialog:
 * the list (with each version's content) is fetched only when it opens. A version opened
 * or compared opens beside it in the document component's sheet (SideSheet, wide).
 *
 * @module pages/ProjectDetail/DocumentVersions
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import DocumentSurface from '../../components/Document/DocumentSurface'
import { projectsApi } from '../../api/projectsApi'
import { useVersionRestore } from './useVersionRestore'
import { formatDateTime } from '../../utils/dateUtils'
import { documentVersionsKey } from './documentEdit'
import type { DocumentAdapter } from '../../components/Document/types'
import type { DocumentVersion } from '../../api/projectDetailSchema'
import type { ProjectDocument } from '../../api/types'

interface DocumentVersionsProps {
  readonly projectId: string
  readonly document: ProjectDocument
  readonly canEdit: boolean
  readonly onSelectDoc: (doc: ProjectDocument) => void
}

type ViewMode = 'content' | 'compare'

function VersionBadges({ version }: Readonly<{ version: DocumentVersion }>) {
  const { t } = useTranslation('projectDetail')
  return (
    <>
      {version.current ? <span className="badge badge-ok">{t('documents.versions.current')}</span> : null}
      {version.edit_kind === 'restore' && version.restored_from_version != null ? (
        <span className="badge badge-info">{t('documents.versions.restoredFrom', { n: version.restored_from_version })}</span>
      ) : null}
      {version.edit_kind === 'edit' ? <span className="badge badge-muted">{t('documents.versions.edited')}</span> : null}
      {/* Saved from the changes a person accepted from "Revise from comments", or applied by the pass (D4). */}
      {version.edit_kind === 'revise' ? <span className="badge badge-info">{revisedLabel(version, t)}</span> : null}
    </>
  )
}

/** "Revised from comments", with the model that wrote it when the version records one (its label, else its id). */
function revisedLabel(version: DocumentVersion, t: TFunction<'projectDetail'>): string {
  const llm = version.llm_metadata
  const model = llm ? (llm.model_label ?? llm.model) : null
  return model === null ? t('documents.versions.revised') : t('documents.versions.revisedWith', { model })
}

function VersionRow({ version, canRestore, restoring, onOpen, onRestore }: Readonly<{
  version: DocumentVersion; canRestore: boolean; restoring: boolean
  onOpen: (mode: ViewMode) => void; onRestore: () => void
}>) {
  const { t, i18n } = useTranslation('projectDetail')
  const label = t('documents.versions.label', { n: version.version })
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <span className="font-mono text-[12px] text-text-strong">{label}</span>
      <span className="text-[12px] text-muted">{formatDateTime(version.created_at, i18n.language)}</span>
      <VersionBadges version={version} />
      <span className="ml-auto flex items-center gap-1">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpen('content')}
          aria-label={t('documents.versions.openNamed', { label })}>
          {t('documents.versions.open')}
        </button>
        {version.current ? null : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpen('compare')}
            aria-label={t('documents.versions.compareNamed', { label })}>
            {t('documents.versions.compare')}
          </button>
        )}
        {canRestore && !version.current ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={restoring} onClick={onRestore}
            aria-label={t('documents.versions.restoreNamed', { label })}>
            {restoring ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RotateCcw size={14} aria-hidden />}
            {t('documents.versions.restore')}
          </button>
        ) : null}
      </span>
    </li>
  )
}

function VersionDialog({ version, current, mode, onClose }: Readonly<{
  version: DocumentVersion; current: DocumentVersion | undefined; mode: ViewMode; onClose: () => void
}>) {
  const { t, i18n } = useTranslation('projectDetail')
  const label = t('documents.versions.label', { n: version.version })
  const comparing = mode === 'compare' && current !== undefined
  const title = comparing ? t('documents.versions.compareTitle', { label }) : `${version.title} · ${label}`
  const adapter = useMemo(() => versionAdapter(version), [version])
  return (
    // (the document component's sheet: the app's side sheet, SideSheet size="wide", 7.54.00)
    <DocumentSurface adapter={adapter} variant="sheet" title={title} headingLevel={2} stored={comparing ? current : version}
      meta={formatDateTime(version.created_at, i18n.language)}
      mode={comparing ? 'compare' : 'read'} comments={null} onSaved={onClose} onClose={onClose} fullPath={null} page={null}
      compare={comparing ? {
        before: version.content, beforeLabel: label, afterLabel: t('documents.versions.current'),
        identicalText: t('documents.versions.identical'),
      } : null}
      footer={<button type="button" className="btn btn-secondary ms-auto" onClick={onClose}>{t('documents.versions.close')}</button>}>
      {null}
    </DocumentSurface>
  )
}

/** A version opened from History, as a read-only document (an earlier one says so; the current one needs no note). */
function versionAdapter(version: DocumentVersion): DocumentAdapter<DocumentVersion> {
  return {
    id: `version:${version.version_id}`,
    contentType: 'markdown',
    permissions: { edit: version.current ? true : 'olderVersion' },
    versionOf: (stored) => ({ token: stored.version_id, number: stored.version }),
    load: (stored) => Promise.resolve(stored),
  }
}

/**
 * The versions (open, compare, restore), fetched when mounted: the body of the document
 * page's History dialog (DocumentCanvas/actions/DocumentActionsBar). A restore selects the
 * restored version through `onSelectDoc`, which reloads the canvas on it.
 */
export default function DocumentVersions({ projectId, document, canEdit, onSelectDoc }: DocumentVersionsProps) {
  const { t } = useTranslation('projectDetail')
  const { data: versions, isLoading, isError } = useQuery({
    queryKey: documentVersionsKey(projectId, document.document_id),
    queryFn: () => projectsApi.getDocumentVersions(projectId, document.document_id),
  })
  const restore = useVersionRestore(projectId, document.document_id, onSelectDoc)
  const [viewing, setViewing] = useState<{ version: DocumentVersion; mode: ViewMode } | null>(null)
  const [confirming, setConfirming] = useState<DocumentVersion | null>(null)

  if (isLoading) return <div className="skeleton h-12" />
  if (isError || versions === undefined) return <p className="text-[12px] text-danger">{t('documents.versions.loadFailed')}</p>
  const current = versions.find((version) => version.current)
  return (
    <>
      {restore.isError ? <p role="alert" className="text-[12px] text-danger">{t('documents.versions.restoreFailed')}</p> : null}
      <ul className="rounded-md border border-border divide-y divide-border">
        {versions.map((version) => (
          <VersionRow key={version.version_id} version={version} canRestore={canEdit}
            restoring={restore.isPending && restore.variables === version.version_id}
            onOpen={(mode) => setViewing({ version, mode })}
            onRestore={() => { restore.reset(); setConfirming(version) }} />
        ))}
      </ul>
      {viewing === null ? null : (
        <VersionDialog version={viewing.version} current={current} mode={viewing.mode} onClose={() => setViewing(null)} />
      )}
      <ConfirmModal
        isOpen={confirming !== null}
        title={t('documents.versions.restoreTitle')}
        message={t('documents.versions.restoreMessage', { n: confirming?.version ?? 0 })}
        confirmLabel={t('documents.versions.restore')}
        cancelLabel={t('documents.versions.cancel')}
        variant="info"
        onConfirm={() => {
          if (confirming !== null) restore.mutate(confirming.version_id)
          setConfirming(null)
        }}
        onCancel={() => setConfirming(null)}
      />
    </>
  )
}
