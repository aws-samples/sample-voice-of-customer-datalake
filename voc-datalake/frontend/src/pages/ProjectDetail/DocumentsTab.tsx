/**
 * DocumentsTab - Documents list and detail view
 */
import clsx from 'clsx'
import { format } from 'date-fns'
import {
  FileText, Pencil, Trash2, Loader2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import DocumentExportMenu from '../../components/DocumentExportMenu'
import type {
  ProjectDocument, Project,
} from '../../api/types'

interface DocumentsTabProps {
  readonly project: Project
  readonly documents: ProjectDocument[]
  readonly selectedDoc: ProjectDocument | null
  readonly onSelectDoc: (doc: ProjectDocument) => void
  readonly onEditDoc: () => void
  readonly onDeleteDoc: () => void
  readonly onCreateDoc: () => void
  readonly isDeleting: boolean
}

export default function DocumentsTab({
  project,
  documents,
  selectedDoc,
  onSelectDoc,
  onEditDoc,
  onDeleteDoc,
  onCreateDoc,
  isDeleting,
}: DocumentsTabProps) {
  const { t } = useTranslation('projectDetail')

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={onCreateDoc}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
        >
          <FileText size={16} />{t('documents.newDocument')}
        </button>
      </div>
      <div className="flex flex-col lg:grid lg:grid-cols-3 gap-4 lg:gap-6">
        {/* Document List */}
        <div className="flex lg:flex-col gap-3 overflow-x-auto lg:overflow-x-visible pb-2 lg:pb-0 -mx-4 px-4 lg:mx-0 lg:px-0">
          {documents.length === 0 ? (
            <div className="text-center py-8 bg-white rounded-xl border flex-shrink-0 w-full">
              <FileText size={32} className="mx-auto text-gray-300 mb-2" />
              <p className="text-gray-500">{t('documents.noDocuments')}</p>
            </div>
          ) : (
            documents.map((d) => (
              <button
                key={d.document_id}
                onClick={() => onSelectDoc(d)}
                className={clsx(
                  'flex-shrink-0 w-56 lg:w-full text-left p-3 lg:p-4 rounded-lg border',
                  selectedDoc?.document_id === d.document_id
                    ? 'bg-blue-50 border-blue-300'
                    : 'bg-white hover:border-blue-200',
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <DocumentTypeBadge type={d.document_type} />
                  <span className="text-xs text-gray-400">{format(new Date(d.created_at), 'MMM d')}</span>
                </div>
                <h4 className="font-medium line-clamp-2 text-sm lg:text-base">{d.title}</h4>
              </button>
            ))
          )}
        </div>

        {/* Document Detail */}
        <div className="lg:col-span-2 bg-white rounded-xl border p-4 sm:p-6 min-h-[400px] lg:min-h-[500px] overflow-hidden">
          {selectedDoc ? (
            <div className="h-full flex flex-col">
              <div className="flex items-start justify-between mb-4">
                <h2 className="text-xl font-bold">{selectedDoc.title}</h2>
                <div className="flex items-center gap-2">
                  <DocumentExportMenu document={selectedDoc} project={project} />
                  <button
                    onClick={onEditDoc}
                    className="p-2 text-blue-500 hover:bg-blue-50 rounded-lg"
                    title={t('documents.editDocument')}
                  >
                    <Pencil size={18} />
                  </button>
                  <button
                    onClick={onDeleteDoc}
                    disabled={isDeleting}
                    className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                    title={t('documents.deleteDocument')}
                  >
                    {isDeleting ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                  </button>
                </div>
              </div>
              <div className="prose prose-sm max-w-none overflow-y-auto flex-1" style={{
                overflowWrap: 'break-word',
                wordBreak: 'break-word',
              }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedDoc.content}</ReactMarkdown>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400">{t('documents.selectDocument')}</div>
          )}
        </div>
      </div>
    </div>
  )
}

function DocumentTypeBadge({ type }: { readonly type: string }) {
  const styles: Record<string, string> = {
    prd: 'bg-blue-100 text-blue-700',
    prfaq: 'bg-green-100 text-green-700',
    custom: 'bg-purple-100 text-purple-700',
  }
  const style = styles[type] ?? 'bg-amber-100 text-amber-700'

  return (
    <span className={clsx('text-xs font-medium px-2 py-0.5 rounded', style)}>
      {type.toUpperCase()}
    </span>
  )
}
