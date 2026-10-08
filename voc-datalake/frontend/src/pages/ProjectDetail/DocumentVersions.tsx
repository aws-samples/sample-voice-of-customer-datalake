/**
 * The Versions list under a document (QA s3 F4): every version, newest first, to
 * open, compare with the current one, or restore.
 *
 * Every edit is a new version (a PRD / PR-FAQ edit is the next `(vN)` of its
 * series; a research / custom edit saves what it replaced), so nothing a user or
 * the assistant overwrote is lost. Restoring adds a NEW version with the old
 * content — history is only added to. Collapsed by default: the list (with each
 * version's content) is fetched only when opened.
 *
 * @module pages/ProjectDetail/DocumentVersions
 */
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { ChevronDown, ChevronRight, History, Loader2, RotateCcw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import ModalShell from '../../components/ModalShell/ModalShell'
import { ContentDiff } from '../../assistant/approvals/previews/DocumentDiffPreview'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'
import type { DocumentVersion } from '../../api/projectDetailSchema'
import type { ProjectDocument } from '../../api/types'

interface DocumentVersionsProps {
  readonly projectId: string
  readonly document: ProjectDocument
  readonly canEdit: boolean
  readonly onSelectDoc: (doc: ProjectDocument) => void
}

type ViewMode = 'content' | 'compare'

const versionsKey = (projectId: string, documentId: string) =>
  [...projectKey(projectId), 'document-versions', documentId] as const

function formatWhen(value: string | null): string {
  if (value === null || value === '') return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : format(date, 'MMM d, yyyy HH:mm')
}

function VersionBadges({ version }: Readonly<{ version: DocumentVersion }>) {
  const { t } = useTranslation('projectDetail')
  return (
    <>
      {version.current ? <span className="badge badge-ok">{t('documents.versions.current')}</span> : null}
      {version.edit_kind === 'restore' && version.restored_from_version != null ? (
        <span className="badge badge-info">{t('documents.versions.restoredFrom', { n: version.restored_from_version })}</span>
      ) : null}
      {version.edit_kind === 'edit' ? <span className="badge badge-muted">{t('documents.versions.edited')}</span> : null}
    </>
  )
}

function VersionRow({ version, canRestore, restoring, onOpen, onRestore }: Readonly<{
  version: DocumentVersion; canRestore: boolean; restoring: boolean
  onOpen: (mode: ViewMode) => void; onRestore: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  const label = t('documents.versions.label', { n: version.version })
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <span className="font-mono text-[12px] text-text-strong">{label}</span>
      <span className="text-[12px] text-muted">{formatWhen(version.created_at)}</span>
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
  const { t } = useTranslation('projectDetail')
  const titleId = useId()
  const label = t('documents.versions.label', { n: version.version })
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-3xl">
      <div className="dialog-header">
        <div>
          <h2 id={titleId} className="dialog-title">
            {mode === 'compare' ? t('documents.versions.compareTitle', { label }) : `${version.title} · ${label}`}
          </h2>
          <p className="dialog-description">{formatWhen(version.created_at)}</p>
        </div>
      </div>
      <div className="dialog-body max-h-[70vh] overflow-y-auto">
        {mode === 'compare' && current !== undefined ? (
          <ContentDiff before={version.content} after={current.content} identicalText={t('documents.versions.identical')} />
        ) : (
          <div className="md-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{version.content}</ReactMarkdown></div>
        )}
      </div>
      <div className="dialog-footer">
        <button type="button" className="btn btn-secondary" onClick={onClose}>{t('documents.versions.close')}</button>
      </div>
    </ModalShell>
  )
}

function useVersionRestore(projectId: string, documentId: string, onSelectDoc: (doc: ProjectDocument) => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (versionId: string) =>
      projectsApi.restoreDocumentVersion(projectId, documentId, versionId, crypto.randomUUID()),
    onSuccess: (restored) => {
      // The project prefix also covers every versions list of this project.
      void queryClient.invalidateQueries({ queryKey: projectKey(projectId) })
      if (restored !== null) onSelectDoc(restored)
    },
  })
}

function VersionsBody({ projectId, document, canEdit, onSelectDoc }: DocumentVersionsProps) {
  const { t } = useTranslation('projectDetail')
  const { data: versions, isLoading, isError } = useQuery({
    queryKey: versionsKey(projectId, document.document_id),
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

export default function DocumentVersions(props: DocumentVersionsProps) {
  const { t } = useTranslation('projectDetail')
  const [open, setOpen] = useState(false)
  const panelId = useId()
  return (
    <section className="mt-4 border-t border-border pt-3">
      <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <History size={14} aria-hidden />
        {t('documents.versions.title')}
      </button>
      {open ? (
        <div id={panelId} className="mt-2 space-y-2">
          <p className="text-[12px] text-muted">{t('documents.versions.hint')}</p>
          <VersionsBody {...props} />
        </div>
      ) : null}
    </section>
  )
}
