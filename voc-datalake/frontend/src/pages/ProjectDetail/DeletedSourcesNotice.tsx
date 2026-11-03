/**
 * @fileoverview The short notice on a document written from something that was later deleted.
 *
 * A deleted persona, document or product doc stays in the document's lineage; this line says the
 * source is gone (`deleted_sources`, api/deletedSources.ts). Nothing renders when nothing was.
 * @module pages/ProjectDetail/DeletedSourcesNotice
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { summarizeDeletedSources } from '../../api/deletedSources'
import type { ProjectDocument } from '../../api/types'

export function DeletedSourcesNotice({ doc }: { readonly doc: ProjectDocument }) {
  const { t } = useTranslation('projectDetail')
  const summary = useMemo(() => summarizeDeletedSources(doc.deleted_sources ?? []), [doc.deleted_sources])
  if (summary === null) return null

  const lines = [
    ...summary.personaNames.map((name) => t('documents.deletedSources.personaNamed', { name })),
    summary.unnamedPersona ? t('documents.deletedSources.persona') : null,
    summary.document ? t('documents.deletedSources.document') : null,
    summary.productDoc ? t('documents.deletedSources.productDoc') : null,
  ].filter((line): line is string => line !== null)

  return (
    <section data-testid="document-deleted-sources" className="mt-4 pt-3 border-t text-xs text-muted">
      <ul className="space-y-1">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </section>
  )
}
