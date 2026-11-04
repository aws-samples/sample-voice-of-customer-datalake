/**
 * @fileoverview "N cited reviews were erased (legal basis recorded)": a persona or document whose cited
 * reviews `voc-retention` erased (`erased_evidence`, api/erasedEvidence.ts). Only the count: no erased
 * content, id or erasure detail is ever shown. Renders nothing for an artefact without the mark.
 * @module pages/ProjectDetail/ErasedEvidenceNote
 */
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { ErasedEvidence } from '../../api/erasedEvidence'

interface ErasedEvidenceNoteProps {
  readonly erasedEvidence: ErasedEvidence | undefined
  /** Extra classes for the line (its placement); the base look is the component's own. */
  readonly className?: string
}

export default function ErasedEvidenceNote({ erasedEvidence, className }: ErasedEvidenceNoteProps) {
  const { t } = useTranslation('projectDetail')
  if (erasedEvidence === undefined) return null
  return (
    <p data-testid="erased-evidence" className={clsx('text-xs text-muted', className)}>
      {t('corpus.erasedSummary', { count: erasedEvidence.count })}
    </p>
  )
}
