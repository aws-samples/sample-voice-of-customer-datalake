/**
 * @fileoverview A voice session from its consent to its end (docs/voice-personas.md): the consent dialog, then, once
 * the microphone and the session are both there, the live session. Shared by a persona's Talk and the Product tab's
 * "Talk it through" (7.104.00), which differ only in their subject and their button.
 *
 * @module pages/ProjectDetail/voice/VoiceSessionFlow
 */
import { useState } from 'react'
import VoiceConsentDialog from './VoiceConsentDialog'
import type { StartedVoice } from './VoiceConsentDialog'
import VoiceSessionModal from './VoiceSessionModal'
import type { VoiceSubject } from '../../../api/voiceSessionsApi'

export default function VoiceSessionFlow({ projectId, subject, name, onClose, onSourceSaved }: Readonly<{
  projectId: string
  subject: VoiceSubject
  name: string
  /** The consent was cancelled, or the ended session's dialog closed. */
  onClose: () => void
  onSourceSaved?: () => void
}>) {
  const [voice, setVoice] = useState<StartedVoice | null>(null)
  if (voice === null) {
    return <VoiceConsentDialog projectId={projectId} subject={subject} name={name} onCancel={onClose} onStarted={setVoice} />
  }
  return <VoiceSessionModal target={{ projectId, subject, ...voice }} name={name} onClose={onClose} onSourceSaved={onSourceSaved} />
}
