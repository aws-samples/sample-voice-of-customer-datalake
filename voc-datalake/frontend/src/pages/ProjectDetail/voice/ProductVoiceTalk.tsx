/**
 * @fileoverview "Talk it through" in the Product tab's gaps panel (7.104.00, docs/voice-personas.md → The product
 * interviewer): an AI interviewer asks the panel's questions out loud and the person answers for their product. Only
 * with `features.voice` (the deployment's `-c voicePersonas=true`) and edit access; the consent comes first, the
 * limits and the budget are the persona sessions' own, and at the end the answers become one interview source.
 *
 * @module pages/ProjectDetail/voice/ProductVoiceTalk
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mic } from 'lucide-react'
import VoiceSessionFlow from './VoiceSessionFlow'
import type { VoiceQuestion, VoiceSubject } from '../../../api/voiceSessionsApi'

export default function ProductVoiceTalk({ projectId, projectName, questions, onSourceSaved }: Readonly<{
  projectId: string
  projectName: string
  questions: readonly VoiceQuestion[]
  onSourceSaved: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  const [open, setOpen] = useState(false)
  const subject = useMemo<VoiceSubject>(() => ({ kind: 'product', questions }), [questions])
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        <Mic size={14} aria-hidden />{t('product.gaps.talk')}
      </button>
      {open ? (
        <VoiceSessionFlow projectId={projectId} subject={subject} name={projectName} onClose={() => setOpen(false)}
          onSourceSaved={onSourceSaved} />
      ) : null}
    </>
  )
}
