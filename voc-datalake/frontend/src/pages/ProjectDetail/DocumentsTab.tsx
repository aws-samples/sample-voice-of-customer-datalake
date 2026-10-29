/**
 * DocumentsTab - Documents list and detail view, plus the prototype builder.
 */

import clsx from 'clsx'
import { FileText, Pencil, Trash2, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import DocumentList from './DocumentList'
import DocumentVersions from './DocumentVersions'
import { canEditProject } from './projectAccess'
import DocumentExportMenu from '../../components/DocumentExportMenu/DocumentExportMenu'
import { useLabelKnownIds } from '../../hooks/useLabelKnownIds'
import type { ProjectDocument } from '../../api/types'
import type { Project, ProductDoc } from '../../api/projectTypes'
import { DerivationFooter, RevisionFooter } from './DocumentLineageFooters'
import { stillPresent, hasDroppedSource, inheritedExtraSources } from './documentLineage'
import { PrototypeView } from './DocumentPrototypeView'
import { DocumentCoachingNotice } from '../../components/AiCoach/HumanDrivenNotice'
import DocumentReviewView from './DocumentReviewView'

/** Document types with no generic content editor and no content version history. */
const NO_CONTENT_EDITOR: ReadonlySet<string> = new Set(['prototype', 'decision'])
/** Document types shown with margin comments, persona review and a review link (docs/document-review.md). */
const COMMENTABLE_TYPES: ReadonlySet<string> = new Set(['prfaq', 'prd'])

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
  readonly onEditDoc: () => void
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
  onEditDoc,
  onDeleteDoc,
  onCreateDoc,
  onJobStarted,
  isDeleting,
}: DocumentsTabProps) {
  const { t } = useTranslation('projectDetail')
  // Stored ids inside generated text (`technical_support`, `proj_…`) read as their names.
  const labelIds = useLabelKnownIds()
  // Viewers read and export documents; create / edit / delete / revise would only 403.
  const canEdit = canEditProject(project)

  return (
    <div className="space-y-4">
      {canEdit ? (
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
      <div className="flex flex-col lg:grid lg:grid-cols-3 gap-4 lg:gap-6">
        <DocumentList documents={documents} selectedDoc={selectedDoc} onSelectDoc={onSelectDoc} />

        {/* Document Detail */}
        <div
          data-testid="document-detail-pane"
          className={clsx(
            'lg:col-span-2 bg-card rounded-xl border p-4 sm:p-6 min-h-[400px] overflow-hidden',
            // A prototype is a whole generated application; a PRD is prose. They do
            // not want the same pane. The fixed 500px minimum meant the most
            // tangible artifact the product makes previewed in ~430px whether the
            // monitor was 900px or 1440px tall — #288 stopped the jobs panel pushing
            // it down the page, but a taller viewport still bought it nothing.
            // 70vh is deliberately short of the full viewport so the pane still fits
            // above the fold on a laptop rather than introducing a scroll.
            selectedDoc?.document_type === 'prototype' ? 'lg:min-h-[70vh]' : 'lg:min-h-[500px]',
          )}
        >
          {selectedDoc ? (
            <div className="h-full flex flex-col">
              <div className="flex items-start justify-between mb-4 gap-2">
                <h2 className="text-lg sm:text-xl font-bold tracking-tight text-text-strong min-w-0 break-words">{selectedDoc.title}</h2>
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  {selectedDoc.document_type === 'prototype' ? null : (
                    <DocumentExportMenu document={selectedDoc} project={project} />
                  )}
                  {canEdit ? (
                    <DocumentWriteActions
                      // A prototype is revised through its preview, a decision through the
                      // Decisions tab: neither has the generic content editor.
                      canEditContent={!NO_CONTENT_EDITOR.has(selectedDoc.document_type)}
                      isDeleting={isDeleting}
                      onEditDoc={onEditDoc}
                      onDeleteDoc={onDeleteDoc}
                    />
                  ) : null}
                </div>
              </div>
              {canEdit ? (
                <DocumentCoachingNotice documentType={selectedDoc.document_type} title={selectedDoc.title}
                  hasContent={selectedDoc.content.trim() !== ''} />
              ) : null}
              {selectedDoc.document_type === 'prototype' ? (
                <PrototypeView
                  projectId={project.project_id}
                  documentId={selectedDoc.document_id}
                  html={selectedDoc.content}
                  url={selectedDoc.prototype_url}
                  title={selectedDoc.title}
                  prototypeFormat={selectedDoc.prototype_format}
                  // Blank when the inherited source no longer exists, because the
                  // API rejects an id it cannot resolve — and a prototype whose PRD
                  // has since been deleted would otherwise become permanently
                  // unrevisable. Blank reads as "not aimed", so the revision falls
                  // back to newest-of-type: not a silent substitution, since the
                  // document it would have preserved is gone.
                  sourcePrdId={stillPresent(selectedDoc.source_prd_id, documents)}
                  sourcePrfaqId={stillPresent(selectedDoc.source_prfaq_id, documents)}
                  sourcesDropped={hasDroppedSource(selectedDoc, documents)}
                  // The optional inputs the BASE was built with, not today's
                  // defaults — see `inheritedExtraSources`.
                  extraSources={inheritedExtraSources(selectedDoc, documents, productDocs)}
                  canEdit={canEdit}
                  onJobStarted={onJobStarted}
                />
              ) : (
                <ProseDocument project={project} document={selectedDoc} markdown={labelIds(selectedDoc.content)} />
              )}
              {/* Below the content, not above it: provenance is what the document
                  was made from, not what it says. Both branches above own the
                  pane's flexible height, so a footer here stays visible without
                  pushing the preview down the page. */}
              <RevisionFooter doc={selectedDoc} documents={documents} onSelectDoc={onSelectDoc} />
              <DerivationFooter doc={selectedDoc} documents={documents} onSelectDoc={onSelectDoc} />
              {/* Prototypes keep their own revision lineage (the footer above). */}
              {NO_CONTENT_EDITOR.has(selectedDoc.document_type) ? null : (
                <DocumentVersions key={selectedDoc.document_id} projectId={project.project_id}
                  document={selectedDoc} canEdit={canEdit} onSelectDoc={onSelectDoc} />
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 h-full min-h-[240px] text-sm text-muted text-center">
              <FileText size={20} aria-hidden />
              {t('documents.selectDocument')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * A prose document: a PR/FAQ or PRD with margin comments, persona review and a review link
 * (DocumentReviewView, keyed so a new version starts with a fresh selection), any other type as
 * plain markdown.
 */
function ProseDocument({ project, document, markdown }: Readonly<{ project: Project; document: ProjectDocument; markdown: string }>) {
  if (COMMENTABLE_TYPES.has(document.document_type)) {
    return (
      <div className="overflow-y-auto flex-1">
        <DocumentReviewView key={document.document_id} projectId={project.project_id} document={document}
          markdown={markdown} hasPersonas={project.persona_count > 0} />
      </div>
    )
  }
  return (
    <div className="md-content overflow-y-auto flex-1">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  )
}

/**
 * Edit and Delete for the selected document. Rendered only for callers who may
 * edit; a prototype or a decision has no Edit here (revised through the preview /
 * edited in the Decisions tab).
 */
function DocumentWriteActions({
  canEditContent, isDeleting, onEditDoc, onDeleteDoc,
}: {
  readonly canEditContent: boolean
  readonly isDeleting: boolean
  readonly onEditDoc: () => void
  readonly onDeleteDoc: () => void
}) {
  const { t } = useTranslation('projectDetail')
  return (
    <>
      {canEditContent ? (
        <button
          type="button"
          onClick={onEditDoc}
          className="icon-btn p-2"
          title={t('documents.editDocument')}
          aria-label={t('documents.editDocument')}
        >
          <Pencil size={16} aria-hidden />
        </button>
      ) : null}
      <button
        type="button"
        onClick={onDeleteDoc}
        disabled={isDeleting}
        className="icon-btn p-2 hover:text-danger"
        title={t('documents.deleteDocument')}
        aria-label={t('documents.deleteDocument')}
      >
        {isDeleting ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Trash2 size={16} aria-hidden />}
      </button>
    </>
  )
}
