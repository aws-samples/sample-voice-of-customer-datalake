/**
 * @fileoverview **Talk** on a project persona (7.69.00, docs/voice-personas.md): with `features.voice` (the
 * deployment's `-c voicePersonas=true`) and edit access only, never on a company persona. It opens the consent dialog,
 * then, once the microphone and the session are both there, the live session.
 *
 * @module pages/ProjectDetail/voice/VoiceTalkButton
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mic } from 'lucide-react'
import { Tooltip } from '../../../components/Tooltip/Tooltip'
import VoiceConsentDialog from './VoiceConsentDialog'
import type { StartedVoice } from './VoiceConsentDialog'
import VoiceSessionModal from './VoiceSessionModal'

type Step = { readonly kind: 'idle' } | { readonly kind: 'consent' } | { readonly kind: 'session'; readonly voice: StartedVoice }

export default function VoiceTalkButton({ projectId, personaId, name }: Readonly<{
  projectId: string; personaId: string; name: string
}>) {
  const { t } = useTranslation('projectDetail')
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const idle = () => setStep({ kind: 'idle' })
  return (
    <>
      <Tooltip kind="label" content={t('voice.talkTo', { name })}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setStep({ kind: 'consent' })} aria-label={t('voice.talkTo', { name })}>
          <Mic size={14} aria-hidden />{t('voice.talk')}
        </button>
      </Tooltip>
      {step.kind === 'consent' ? (
        <VoiceConsentDialog projectId={projectId} personaId={personaId} name={name} onCancel={idle}
          onStarted={(voice) => setStep({ kind: 'session', voice })} />
      ) : null}
      {step.kind === 'session' ? (
        <VoiceSessionModal target={{ projectId, personaId, ...step.voice }} name={name} onClose={idle} />
      ) : null}
    </>
  )
}
