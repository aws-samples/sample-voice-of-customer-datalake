/**
 * DocumentsTab - Documents list and detail view, plus the prototype builder.
 *
 * A prose document opens on its page (components/DocumentCanvas/page/DocumentPage, lazy-loaded so the editor's
 * bundle loads only on this tab), edited in place there; its Export, Delete and Save live in the page's action bar.
 * A prototype keeps its preview pane, with Delete in the pane's header.
 */

import clsx from 'clsx'
import { FileText, Loader2 } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import DocumentList from './DocumentList'
import { canEditProject } from './projectAccess'
import { seriesKeyOf } from './documentEdit'
import { isVersionManagedDocument } from '../../api/documentLineage'
import type { ProjectDocument } from '../../api/types'
import type { Project, ProductDoc } from '../../api/projectTypes'
import ErasedEvidenceNote from './ErasedEvidenceNote'
import FeedbackCorpus from './FeedbackCorpus'
import { featureRequestIdsOf } from './featureRequestCitations'
import { stillPresent, hasDroppedSource, inheritedExtraSources } from './documentLineage'
import { PrototypeView } from './DocumentPrototypeView'
import { DocumentCoachingNotice } from '../../components/AiCoach/HumanDrivenNotice'
import DocumentProvenance from '../../components/DocumentCanvas/page/DocumentProvenance'
import DeleteDocumentButton from '../../components/DocumentCanvas/actions/DeleteDocumentButton'
import PrototypeBackButton from './PrototypeBack'
import { PrototypeWithDraft } from './PrototypeDraftBanner'
import { useFocusViewActive } from '../../components/DocumentCanvas/page/focusView'

const DocumentPage = lazy(() => import('../../components/DocumentCanvas/page/DocumentPage'))

/** The pane every state of the detail column shares (the page draws its own). */
const PANE = 'bg-card rounded-xl border p-4 sm:p-6 min-h-[400px] min-w-0'

interface DocumentsTabProps {
  readonly project: Project
  readonly documents: ProjectDocument[]
  /**
   * The project's uploaded product docs, used only to drop an inherited visual that
   * has since been deleted — see `inheritedExtraSources`. Undefined means the list
   * is unknown, which is NOT the same as empty.
   */
  readonly productDocs?: ProductDoc[]
  readonly selectedDoc: ProjectDocument | null
  readonly onSelectDoc: (doc: ProjectDocument) => void
  readonly onDeleteDoc: () => void
  readonly onCreateDoc: () => void
  /**
   * A prototype revision was started. Only the jobs panel needs to know: the
   * refreshed document list arrives when the job completes, via useProjectData,
   * whether or not this tab is still mounted.
   */
  readonly onJobStarted?: () => void
  readonly isDeleting: boolean
}

export default function DocumentsTab({
  project,
  documents,
  productDocs,
  selectedDoc,
  onSelectDoc,
  onDeleteDoc,
  onCreateDoc,
  onJobStarted,
  isDeleting,
}: DocumentsTabProps) {
  const { t } = useTranslation('projectDetail')
  // Viewers read and export documents; create / edit / delete / revise would only 403.
  const canEdit = canEditProject(project)
  // The page in focus view has the window: "New document" and the list step aside (null in place: no remount).
  const focusView = useFocusViewActive()

  return (
    <div className={focusView ? undefined : 'space-y-4'}>
      {canEdit && !focusView ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onCreateDoc}
            className="btn btn-primary"
          >
            <FileText size={16} aria-hidden />{t('documents.newDocument')}
          </button>
        </div>
      ) : null}
      {/* The list is a narrow column from xl, a strip above the page below it: the page needs the width for its
          outline, text and rail. */}
      <div className={focusView ? undefined : 'flex flex-col gap-4 xl:grid xl:grid-cols-[13rem_minmax(0,1fr)] xl:gap-6'}>
        {focusView ? null : <DocumentList documents={documents} selectedDoc={selectedDoc} onSelectDoc={onSelectDoc} />}
        {selectedDoc === null ? (
          <div data-testid="document-detail-pane" className={clsx(PANE, 'lg:min-h-[500px]')}>
            <div className="flex flex-col items-center justify-center gap-3 h-full min-h-[240px] text-sm text-muted text-center">
              <FileText size={20} aria-hidden />
              {t('documents.selectDocument')}
            </div>
          </div>
        ) : (
          <SelectedDocument project={project} document={selectedDoc} documents={documents} productDocs={productDocs}
            canEdit={canEdit} onSelectDoc={onSelectDoc} onDeleteDoc={onDeleteDoc} onJobStarted={onJobStarted}
            isDeleting={isDeleting} />
        )}
      </div>
    </div>
  )
}

/**
 * Which page a document opens on. Each save of a PRD / PR/FAQ is a new version with a new id, and it must not
 * remount the page (a half-written comment, the undo history, the rail's tab): its series names the page. Any
 * other document (or a series with no title to name it) is its own.
 */
function pageKey(document: ProjectDocument): string {
  if (!isVersionManagedDocument(document)) return `doc:${document.document_id}`
  const series = seriesKeyOf(document)
  return series === '' ? `doc:${document.document_id}` : `series:${document.document_type}:${series}`
}

/** A prototype in its preview pane; every other document on its page. */
function SelectedDocument(props: PrototypePaneProps) {
  const { document } = props
  if (document.document_type === 'prototype') return <PrototypePane {...props} />
  return (
    <Suspense fallback={<PageLoading />}>
      {/* Keyed: a page's draft, outline and comments belong to one document (a PRD / PR/FAQ: its series). */}
      <DocumentPage key={pageKey(document)} project={props.project} document={document} documents={props.documents}
        canEdit={props.canEdit} onSelectDoc={props.onSelectDoc} onDeleteDoc={props.onDeleteDoc} isDeleting={props.isDeleting} />
    </Suspense>
  )
}

function PageLoading() {
  const { t } = useTranslation('projectDetail')
  return (
    <div role="status" className={clsx(PANE, 'lg:min-h-[500px] flex items-center justify-center')}>
      <Loader2 size={24} className="animate-spin text-accent" aria-hidden />
      <span className="sr-only">{t('canvas.page.loading')}</span>
    </div>
  )
}

interface PrototypePaneProps {
  readonly project: Project
  readonly document: ProjectDocument
  readonly documents: ProjectDocument[]
  readonly productDocs?: ProductDoc[]
  readonly canEdit: boolean
  readonly onSelectDoc: (doc: ProjectDocument) => void
  readonly onDeleteDoc: () => void
  readonly onJobStarted?: () => void
  readonly isDeleting: boolean
}

/** A prototype: its preview, revised through the preview, never on the canvas. */
function PrototypePane({
  project, document, documents, productDocs, canEdit, onSelectDoc, onDeleteDoc, onJobStarted, isDeleting,
}: PrototypePaneProps) {
  return (
    <div
      data-testid="document-detail-pane"
      // A prototype is a whole generated application; a PRD is prose. They do
      // not want the same pane. The fixed 500px minimum meant the most
      // tangible artifact the product makes previewed in ~430px whether the
      // monitor was 900px or 1440px tall — #288 stopped the jobs panel pushing
      // it down the page, but a taller viewport still bought it nothing.
      // 70vh is deliberately short of the full viewport so the pane still fits
      // above the fold on a laptop rather than introducing a scroll.
      className={clsx(PANE, 'overflow-hidden lg:min-h-[70vh]')}
    >
      <div className="h-full flex flex-col">
        <div className="flex items-start justify-between mb-4 gap-2">
          <h2 className="text-lg sm:text-xl font-bold tracking-tight text-text-strong min-w-0 break-words">{document.title}</h2>
          {canEdit ? (
            <div className="flex flex-wrap items-start justify-end gap-2">
              <PrototypeBackButton projectId={project.project_id} document={document} documents={documents}
                onSelectDoc={onSelectDoc} />
              <DeleteDocumentButton isDeleting={isDeleting} onDeleteDoc={onDeleteDoc} />
            </div>
          ) : null}
        </div>
        {canEdit ? (
          <DocumentCoachingNotice documentType={document.document_type} title={document.title}
            hasContent={document.content.trim() !== ''} />
        ) : null}
        {/* A finished draft of this series (editors only) gets its banner, and the preview shows it until
            the editor switches back to this version. */}
        <PrototypeWithDraft projectId={project.project_id} document={document} documents={documents} canEdit={canEdit}
          onSelectDoc={onSelectDoc}>
          <PrototypeView
            projectId={project.project_id}
            documentId={document.document_id}
            html={document.content}
            url={document.prototype_url}
            title={document.title}
            prototypeFormat={document.prototype_format}
            // Blank when the inherited source no longer exists, because the
            // API rejects an id it cannot resolve — and a prototype whose PRD
            // has since been deleted would otherwise become permanently
            // unrevisable. Blank reads as "not aimed", so the revision falls
            // back to newest-of-type: not a silent substitution, since the
            // document it would have preserved is gone.
            sourcePrdId={stillPresent(document.source_prd_id, documents)}
            sourcePrfaqId={stillPresent(document.source_prfaq_id, documents)}
            sourcesDropped={hasDroppedSource(document, documents)}
            // The optional inputs the BASE was built with, not today's
            // defaults — see `inheritedExtraSources`.
            extraSources={inheritedExtraSources(document, documents, productDocs)}
            canEdit={canEdit}
            onJobStarted={onJobStarted}
          />
        </PrototypeWithDraft>
        {/* Prototypes keep their own revision lineage (the revision footer), no content versions. */}
        <DocumentProvenance document={document} documents={documents} onSelectDoc={onSelectDoc} />
        <FeedbackCorpus feedbackIds={document.input_feedback_ids}
          featureRequestIds={featureRequestIdsOf(document)}
          className="mt-2" />
        <ErasedEvidenceNote erasedEvidence={document.erased_evidence} className="mt-1" />
      </div>
    </div>
  )
}
