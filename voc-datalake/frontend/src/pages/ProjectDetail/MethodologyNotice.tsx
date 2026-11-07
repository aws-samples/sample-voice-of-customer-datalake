/**
 * @fileoverview What a document was made without, as the server recorded it on the document
 * (`methodology`, lambda/shared/methodology.py, docs/project-workspace.md → Methodology).
 *
 * Tenet 2: no step is skipped silently and every artefact says what evidence it cites. The lines come
 * from the stored block: a missing or unselected upstream step, "cites no customer evidence" (a
 * hand-written document's `evidence: 0` says so in its own words) and reference documents the generator's cap left out. A code
 * this client does not know shows the server's own sentence. Renders nothing for a document without
 * gaps (or made before the block existed).
 * @module pages/ProjectDetail/MethodologyNotice
 */
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { MethodologyWarning } from '../../api/methodologySchema'
import type { ProjectDocument } from '../../api/types'

function missingText(t: TFunction<'projectDetail'>, step: string | undefined): string | null {
  switch (step) {
    case 'personas': return t('documents.methodology.missingPersonas')
    case 'prfaq': return t('documents.methodology.missingPrfaq')
    case 'prd': return t('documents.methodology.missingPrd')
    default: return null
  }
}

function notSelectedText(t: TFunction<'projectDetail'>, step: string | undefined): string | null {
  switch (step) {
    case 'feedback': return t('documents.methodology.notSelectedFeedback')
    case 'personas': return t('documents.methodology.notSelectedPersonas')
    case 'prfaq': return t('documents.methodology.notSelectedPrfaq')
    default: return null
  }
}

/** The sentence for one warning (each key literal, so the extractor sees it), else the server's. */
function methodologyWarningText(t: TFunction<'projectDetail'>, warning: MethodologyWarning, handWritten: boolean): string {
  switch (warning.code) {
    case 'missing_upstream': return missingText(t, warning.step) ?? warning.message
    case 'upstream_not_selected': return notSelectedText(t, warning.step) ?? warning.message
    case 'no_evidence': return handWritten ? t('documents.methodology.handWritten') : t('documents.methodology.noEvidence')
    case 'reference_documents_skipped':
      return t('documents.methodology.documentsSkipped', {
        count: warning.document_ids?.length ?? 0, cap: warning.cap ?? 0,
      })
    default: return warning.message
  }
}

export function MethodologyNotice({ doc }: { readonly doc: ProjectDocument }) {
  const { t } = useTranslation('projectDetail')
  const warnings = doc.methodology?.warnings ?? []
  if (warnings.length === 0) return null
  return (
    <section data-testid="document-methodology" className="mt-4 pt-3 border-t text-xs text-muted">
      <p className="font-medium">{t('documents.methodology.title')}</p>
      <ul className="mt-1 space-y-1">
        {warnings.map((warning) => (
          <li key={`${warning.code}:${warning.step ?? ''}`}>{methodologyWarningText(t, warning, doc.origin === 'human')}</li>
        ))}
      </ul>
    </section>
  )
}
