/**
 * @fileoverview The persona's voice in its edit dialog (7.69.00, with `features.voice`): Default (the deterministic
 * pick of the two voices that speak every supported language, lambda/shared/voice_sessions.py) or one of the model's
 * 16 voices. Never chosen from the persona's name or background; the choice is saved as the persona's `voice_id`
 * (`null` goes back to the default).
 *
 * @module pages/ProjectDetail/voice/PersonaVoiceField
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { VOICES } from '@stream/voice/protocol'
import type { VoiceId, VoiceSpec } from '@stream/voice/protocol'
import type { ProjectPersona } from '../../../api/projectTypes'

const DEFAULT_VALUE = ''

const voiceName = (id: VoiceId): string => `${id.charAt(0).toUpperCase()}${id.slice(1)}`

export default function PersonaVoiceField({ persona, onChange }: Readonly<{
  persona: ProjectPersona; onChange: (persona: ProjectPersona) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const id = useId()
  const helpId = useId()
  const label = (voice: VoiceSpec) => t('personaEdit.voiceOption', {
    name: voiceName(voice.id),
    gender: t(voice.gender === 'feminine' ? 'personaEdit.voiceFeminine' : 'personaEdit.voiceMasculine'),
    speaks: voice.polyglot ? t('personaEdit.voiceEveryLanguage') : voice.locale,
  })
  const select = (value: string) => {
    const voice = VOICES.find((one) => one.id === value)
    onChange({ ...persona, voice_id: voice === undefined ? null : voice.id })
  }
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-text mb-1">{t('personaEdit.voice')}</label>
      <select id={id} className="input" aria-describedby={helpId} value={persona.voice_id ?? DEFAULT_VALUE}
        onChange={(event) => select(event.target.value)}>
        <option value={DEFAULT_VALUE}>{t('personaEdit.voiceDefault')}</option>
        {VOICES.map((voice) => <option key={voice.id} value={voice.id}>{label(voice)}</option>)}
      </select>
      <p id={helpId} className="mt-1 text-xs text-muted">{t('personaEdit.voiceHelp')}</p>
    </div>
  )
}
