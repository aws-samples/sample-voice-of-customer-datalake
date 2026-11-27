/**
 * @fileoverview **Talk** on a project persona (7.69.00, docs/voice-personas.md): with `features.voice` (the
 * deployment's `-c voicePersonas=true`) and edit access only, never on a company persona. It opens the consent dialog,
 * then, once the microphone and the session are both there, the live session (VoiceSessionFlow.tsx).
 *
 * @module pages/ProjectDetail/voice/VoiceTalkButton
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mic } from 'lucide-react'
import { Tooltip } from '../../../components/Tooltip/Tooltip'
import VoiceSessionFlow from './VoiceSessionFlow'
import type { VoiceSubject } from '../../../api/voiceSessionsApi'

export default function VoiceTalkButton({ projectId, personaId, name }: Readonly<{
  projectId: string; personaId: string; name: string
}>) {
  const { t } = useTranslation('projectDetail')
  const [open, setOpen] = useState(false)
  const subject = useMemo<VoiceSubject>(() => ({ kind: 'persona', personaId }), [personaId])
  return (
    <>
      <Tooltip kind="label" content={t('voice.talkTo', { name })}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)} aria-label={t('voice.talkTo', { name })}>
          <Mic size={14} aria-hidden />{t('voice.talk')}
        </button>
      </Tooltip>
      {open ? <VoiceSessionFlow projectId={projectId} subject={subject} name={name} onClose={() => setOpen(false)} /> : null}
    </>
  )
}
