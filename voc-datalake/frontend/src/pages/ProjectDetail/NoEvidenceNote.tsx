/**
 * @fileoverview "No customer evidence: imported" under a persona that is not based on customer
 * feedback (TENETS.md tenet 2): an imported persona, or a copy of one without reviews. The server
 * stores the marker (`evidence`, lambda/shared/persona_evidence_marker.py); this only reads it.
 * Renders nothing for a persona with reviews behind it.
 *
 * @module pages/ProjectDetail/NoEvidenceNote
 */
import clsx from 'clsx'
import { CircleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { noEvidenceKind } from '../../api/personaEvidenceMarker'
import type { NoEvidenceKind } from '../../api/personaEvidenceMarker'
import type { ProjectPersona } from '../../api/projectTypes'

/** Literal keys, so the i18n audit sees each one. */
const NOTE_KEY = {
  imported: 'personas.noEvidence.imported',
  copiedFromImport: 'personas.noEvidence.copiedFromImport',
  copied: 'personas.noEvidence.copied',
} as const satisfies Record<NoEvidenceKind, string>

interface NoEvidenceNoteProps {
  readonly persona: Pick<ProjectPersona, 'evidence' | 'imported_from'>
  readonly className?: string
}

export default function NoEvidenceNote({ persona, className }: NoEvidenceNoteProps) {
  const { t } = useTranslation('projectDetail')
  const kind = noEvidenceKind(persona.evidence, persona.imported_from)
  if (kind === null) return null
  return (
    <p data-testid="persona-no-evidence" className={clsx('text-[12px] text-muted inline-flex items-start gap-1', className)}>
      <CircleAlert size={12} className="mt-0.5 flex-shrink-0" aria-hidden />
      <span>{t(NOTE_KEY[kind])}</span>
    </p>
  )
}
