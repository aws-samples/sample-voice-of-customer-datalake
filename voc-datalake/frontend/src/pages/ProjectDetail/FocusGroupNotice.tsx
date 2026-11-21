/**
 * @fileoverview Under a saved focus group (`document_type: 'focus_group'`, always `synthetic`): its statements are
 * the personas', hypotheses to test, never customer feedback or evidence; only the reviews it cites are real
 * (docs/project-workspace.md → Persona focus groups). A synthetic validation run (7.68.00) says the same of its personas.
 * Under a voice interview's transcript (`persona_interview`, 7.69.00, docs/voice-personas.md) the same, said of one
 * persona's spoken answers, and that the audio was never kept.
 * @module pages/ProjectDetail/FocusGroupNotice
 */
import { AudioLines, MessagesSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectDocument } from '../../api/types'

export function FocusGroupNotice({ doc }: { readonly doc: ProjectDocument }) {
  const { t } = useTranslation('projectDetail')
  if (doc.document_type !== 'focus_group' && doc.synthetic !== true) return null
  // A synthetic validation run (7.68.00): personas trying the prototype, never testers' answers or "met".
  const run = doc.document_type === 'validation_run'
  const interview = doc.document_type === 'persona_interview'
  const Icon = interview ? AudioLines : MessagesSquare
  const generic = run ? t('documents.syntheticRunNotice') : t('documents.syntheticNotice')
  return (
    <p role="note" data-testid="document-synthetic" className="mt-4 flex items-start gap-2 border-t pt-3 text-xs text-muted">
      <Icon size={14} className="mt-0.5 flex-shrink-0 text-aim" aria-hidden />
      <span>{interview ? t('documents.interviewSyntheticNotice') : generic}</span>
    </p>
  )
}
