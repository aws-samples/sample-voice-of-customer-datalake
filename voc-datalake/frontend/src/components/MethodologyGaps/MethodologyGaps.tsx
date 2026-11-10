/**
 * @fileoverview The warnings of one methodology block (lambda/shared/methodology.py) as a short list:
 * a missing or unselected upstream step, "cites no customer evidence" and reference documents the
 * generator's cap left out (TENETS.md tenet 2: no step is skipped silently). A code this client does not
 * know shows the server's own sentence. Renders nothing for a block without warnings.
 *
 * Used under a document (Documents tab), on an agent run's journal events and on a plan step.
 * @module components/MethodologyGaps
 */
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { MethodologyBlock, MethodologyWarning } from '../../api/methodologySchema'

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

interface MethodologyGapsProps {
  readonly block: MethodologyBlock | undefined
  /** A hand-written document says "no evidence" in its own words. */
  readonly handWritten?: boolean
  readonly testId?: string
  readonly className?: string
}

export default function MethodologyGaps({ block, handWritten = false, testId = 'methodology-gaps', className }: MethodologyGapsProps) {
  const { t } = useTranslation('projectDetail')
  const warnings = block?.warnings ?? []
  if (warnings.length === 0) return null
  return (
    <section data-testid={testId} className={clsx('text-xs text-muted', className)}>
      <p className="font-medium">{t('documents.methodology.title')}</p>
      <ul className="mt-1 space-y-1">
        {warnings.map((warning) => (
          <li key={`${warning.code}:${warning.step ?? ''}`}>{methodologyWarningText(t, warning, handWritten)}</li>
        ))}
      </ul>
    </section>
  )
}
