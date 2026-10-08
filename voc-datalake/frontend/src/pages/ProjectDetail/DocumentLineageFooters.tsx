/**
 * @fileoverview A document's lineage footers: what it was derived from, and what its revision inherited.
 * @module pages/ProjectDetail/DocumentLineageFooters
 */

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveDerivation, type DerivationRole, type DerivationSource } from '../../api/derivation'
import { resolveRevision } from '../../api/documentLineage'
import { isNonEmptyString } from '../../api/lenientFields'
import { DocumentTypeBadge } from './DocumentLabels'
import type { ProjectDocument } from '../../api/types'

/** Props the two lineage footers share: the selected document, its siblings, and navigation. */
interface LineageFooterProps {
  readonly doc: ProjectDocument
  readonly documents: readonly ProjectDocument[]
  readonly onSelectDoc: (doc: ProjectDocument) => void
}

/**
 * Navigation by id. The resolvers hand back ids, not documents, and `onSelectDoc`
 * needs the document — so the list is searched here, once, on click only.
 */
function useSelectDocumentById(
  documents: readonly ProjectDocument[],
  onSelectDoc: (doc: ProjectDocument) => void,
) {
  return useCallback((documentId: string) => {
    const target = documents.find((d) => d.document_id === documentId)
    if (target) onSelectDoc(target)
  }, [documents, onSelectDoc])
}

export function DerivationFooter({ doc, documents, onSelectDoc }: LineageFooterProps) {
  const { t } = useTranslation('projectDetail')
  const derivation = useMemo(() => resolveDerivation(doc, documents), [doc, documents])
  const onSelectSource = useSelectDocumentById(documents, onSelectDoc)

  // 'none' is a legitimate answer — a hand-authored document, or an old record
  // with nothing to reconstruct — not a gap to advertise. Nothing renders: no
  // panel, no "unknown", no invented provenance to fill the space.
  if (derivation.origin === 'none') return null

  // Literal keys so the i18n extractor still sees them, in a record so that
  // adding a role to DERIVATION_ROLES is a compile error here rather than a
  // silently missing label.
  const roleLabels: Record<DerivationRole, string> = {
    reference: t('documents.derivation.roles.reference'),
    prototype_prd: t('documents.derivation.roles.prototypePrd'),
    prototype_prfaq: t('documents.derivation.roles.prototypePrfaq'),
    merge_input: t('documents.derivation.roles.mergeInput'),
  }

  // The non-document inputs. Most PRDs are generated from feedback alone, and
  // without these such a document would read as built from nothing.
  const inputs = [
    derivation.feedback_count > 0
      ? t('documents.derivation.feedbackUsed', { count: derivation.feedback_count })
      : null,
    derivation.persona_ids.length > 0
      ? t('documents.derivation.personasUsed', { count: derivation.persona_ids.length })
      : null,
    derivation.product_context_included ? t('documents.derivation.productContext') : null,
    // A COUNT on this line rather than rows in the sources list above, and that
    // follows from the data: these ids name product docs, which are not in the
    // project's document list, so `resolveDerivation` can never give them a title
    // or a type — every row would render a raw id beside "No longer available".
    // The count is the whole truthful answer. Nothing at all when there are none,
    // like the two inputs beside it.
    derivation.visual_document_ids.length > 0
      ? t('documents.derivation.visualsUsed', { count: derivation.visual_document_ids.length })
      : null,
  ].filter((label): label is string => label !== null)

  return (
    <section data-testid="document-derivation" className="mt-4 pt-3 border-t text-xs text-muted">
      <h3 className="font-medium text-text mb-1.5">{t('documents.derivation.builtFrom')}</h3>
      {derivation.sources.length > 0 ? (
        <ul className="space-y-1">
          {derivation.sources.map((source) => (
            // Role in the key too: the same document can contribute twice under
            // two roles, and neither entry should be dropped as a duplicate.
            <li key={`${source.role}:${source.document_id}`}>
              <DerivationSourceRow
                source={source}
                roleLabel={roleLabels[source.role]}
                unavailableLabel={t('documents.derivation.unavailable')}
                onSelect={onSelectSource}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {/* The generator feeds the model at most three of the reference documents
          selected, so a record can say five selected and three used. Said in the
          same neutral grey as the rest, with no icon and no warning colour: the
          cap is deliberate, and fixing it is a separate issue from showing it.
          Nothing is said at all when the two numbers agree. */}
      {derivation.selected_document_count > derivation.sources.length ? (
        <p className="mt-1.5">
          {t('documents.derivation.selectedUsed', {
            used: derivation.sources.length,
            selected: derivation.selected_document_count,
          })}
        </p>
      ) : null}
      {inputs.length > 0 ? <p className="mt-1.5">{inputs.join(' · ')}</p> : null}
    </section>
  )
}

/** One contributing document: navigable while it exists, plain text once it does not. */
function DerivationSourceRow({
  source, roleLabel, unavailableLabel, onSelect,
}: {
  readonly source: DerivationSource
  readonly roleLabel: string
  readonly unavailableLabel: string
  readonly onSelect: (documentId: string) => void
}) {
  const label = (
    <>
      {/* The same badge the list cards use, keyed on the document_type the
          resolver now returns alongside the title. */}
      {source.document_type ? <DocumentTypeBadge type={source.document_type} /> : null}
      <span className="truncate">{isNonEmptyString(source.title) ? source.title : source.document_id}</span>
    </>
  )
  const role = <span className="flex-shrink-0 text-muted">{roleLabel}</span>

  // A source whose document has been deleted stays visible — the relation
  // outlived its target — but must not be a control that leads nowhere.
  if (!source.resolved) {
    return (
      <span className="flex items-center gap-2 min-w-0">
        {label}
        <span className="flex-shrink-0">{unavailableLabel}</span>
        {role}
      </span>
    )
  }

  return (
    <span className="flex items-center gap-2 min-w-0">
      <button
        type="button"
        onClick={() => onSelect(source.document_id)}
        className="flex items-center gap-2 min-w-0 text-left link"
      >
        {label}
      </button>
      {role}
    </span>
  )
}

export function RevisionFooter({ doc, documents, onSelectDoc }: LineageFooterProps) {
  const { t } = useTranslation('projectDetail')
  const revision = useMemo(() => resolveRevision(doc, documents), [doc, documents])
  const onSelectBase = useSelectDocumentById(documents, onSelectDoc)

  // Not a revision. Most documents are not, so this renders nothing rather than
  // an empty heading.
  if (revision === null) return null

  return (
    <section data-testid="document-revision" className="mt-4 pt-3 border-t text-xs text-muted">
      <h3 className="font-medium text-text mb-1.5">{t('documents.revision.heading')}</h3>
      <p className="flex items-center gap-2 min-w-0">
        {revision.resolved ? (
          <button
            type="button"
            onClick={() => onSelectBase(revision.revisedFromId)}
            className="truncate text-left link"
          >
            {revision.title === null || revision.title === '' ? revision.revisedFromId : revision.title}
          </button>
        ) : (
          // The predecessor has been deleted. The relation still happened, so it
          // is still reported — just not as a control that leads nowhere. Same
          // rule the derivation footer follows for a deleted source.
          <>
            <span className="truncate">{revision.revisedFromId}</span>
            <span className="flex-shrink-0">{t('documents.derivation.unavailable')}</span>
          </>
        )}
      </p>
      {/* The feedback IS the reason this revision exists, so it is the one piece
          of stored text worth surfacing here. Capped by the backend at 2000
          chars; clamped rather than scrolled so a long note cannot push the
          preview off the pane. */}
      {revision.feedback === '' ? null : (
        <p className="mt-1.5 italic line-clamp-3">
          {t('documents.revision.feedback', { feedback: revision.feedback })}
        </p>
      )}
    </section>
  )
}
