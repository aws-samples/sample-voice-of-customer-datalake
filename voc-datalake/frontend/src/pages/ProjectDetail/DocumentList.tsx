/**
 * DocumentList - the selectable document rail of the Documents tab.
 *
 * A horizontal scroller on narrow screens, a column on `lg`. Rows are buttons
 * with `aria-current` on the selected one; titles are plain text rather than
 * headings, because a heading inside a button is flattened into the button's
 * name anyway and a list of them broke the page outline (h1 → h4).
 */
import clsx from 'clsx'
import { format } from 'date-fns'
import { FileText } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { isVersionManagedDocument, ordinalByType } from '../../api/documentLineage'
import { DocumentOrdinalLabel, DocumentTypeBadge } from './DocumentLabels'
import type { ProjectDocument } from '../../api/types'

interface DocumentListProps {
  readonly documents: ProjectDocument[]
  readonly selectedDoc: ProjectDocument | null
  readonly onSelectDoc: (doc: ProjectDocument) => void
}

export default function DocumentList({
  documents, selectedDoc, onSelectDoc,
}: DocumentListProps) {
  const { t } = useTranslation('projectDetail')
  // One pass for the whole list rather than one per row, and memoised because the
  // list re-renders on every selection change while the documents themselves do not.
  const ordinals = useMemo(() => ordinalByType(documents), [documents])

  return (
    <div className="flex lg:flex-col gap-3 overflow-x-auto lg:overflow-x-visible pb-2 lg:pb-0 -mx-4 px-4 lg:mx-0 lg:px-0">
      {documents.length === 0 ? (
        <div className="card text-center py-8 flex-shrink-0 w-full">
          <div className="w-10 h-10 mx-auto mb-3 rounded-lg bg-info-subtle flex items-center justify-center">
            <FileText size={18} className="text-info" aria-hidden />
          </div>
          <p className="text-sm text-muted">{t('documents.noDocuments')}</p>
        </div>
      ) : (
        documents.map((d) => {
          const selected = selectedDoc?.document_id === d.document_id
          return (
            <button
              key={d.document_id}
              type="button"
              onClick={() => onSelectDoc(d)}
              aria-current={selected ? 'true' : undefined}
              className={clsx(
                'flex-shrink-0 w-56 lg:w-full text-left p-3 lg:p-4 rounded-lg border transition-colors focus-ring',
                selected
                  ? 'bg-accent-subtle border-accent/40 [&_.text-muted]:text-text'
                  : 'bg-card border-border hover:border-border-strong hover:bg-bg-hover',
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <DocumentTypeBadge type={d.document_type} />
                {/* Canonical managed-document titles already carry their persisted
                    backend version. Only unmanaged types use a contextual ordinal. */}
                <DocumentOrdinalLabel
                  ordinal={isVersionManagedDocument(d) ? undefined : ordinals.get(d.document_id)}
                  t={t}
                />
                <span className="text-xs text-muted">{format(new Date(d.created_at), 'MMM d')}</span>
              </div>
              <p className="font-medium line-clamp-2 text-sm lg:text-base text-text-strong">{d.title}</p>
            </button>
          )
        })
      )}
    </div>
  )
}
