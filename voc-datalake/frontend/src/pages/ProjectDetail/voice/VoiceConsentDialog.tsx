/**
 * @fileoverview The consent asked before every voice session (docs/voice-personas.md): it says the three things the
 * person agrees to — the transcript is kept and the audio never is; the persona's voice is synthetic, an AI persona and
 * not a customer; how many of the month's voice minutes are left and what a minute costs — and the person ticks that
 * they agree before Start. Start asks for the microphone first (a refusal starts nothing and spends none of today's
 * sessions), then the session (`POST …/voice-sessions` with `consent: true`), and hands both to the session modal.
 *
 * @module pages/ProjectDetail/voice/VoiceConsentDialog
 */
import { useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Headphones, Loader2, Mic } from 'lucide-react'
import DialogClose from '../../../components/DialogClose/DialogClose'
import ModalShell from '../../../components/ModalShell/ModalShell'
import { apiErrorCode } from '../../../lib/errors'
import { voiceKeys, voiceSessionsApi } from '../../../api/voiceSessionsApi'
import type { StartedVoiceSession, VoiceOffer } from '../../../api/voiceSessionsApi'
import { openVoiceAudio } from './voiceAudio'
import type { VoiceAudio } from './voiceAudio'
import { formatCents, languageSupport, voiceLanguage } from './voiceFormat'

export interface StartedVoice {
  readonly started: StartedVoiceSession
  readonly audio: VoiceAudio
}

/** The projects API's refusal codes (lambda/shared/voice_session_routes.py), each with what the person reads. */
const START_ERRORS: Readonly<Record<string, string>> = {
  rate_limited: 'voice.consent.errors.rateLimited',
  daily_limit: 'voice.consent.errors.dailyLimit',
  busy: 'voice.consent.errors.busy',
  budget_exhausted: 'voice.consent.errors.budgetExhausted',
  voice_off: 'voice.consent.errors.voiceOff',
}

function startErrorKey(error: unknown): string {
  // The microphone or the audio could not be opened (NotAllowedError, NotFoundError, …).
  if (error instanceof DOMException) return 'voice.consent.errors.microphone'
  return START_ERRORS[apiErrorCode(error) ?? ''] ?? 'voice.consent.errors.generic'
}

async function startVoice(projectId: string, personaId: string, language: string): Promise<StartedVoice> {
  const audio = await openVoiceAudio()
  try {
    return { started: await voiceSessionsApi.start(projectId, personaId, language), audio }
  } catch (error) {
    await audio.close()
    throw error
  }
}

/** Why no session can start now, or null. */
function blockedKey(offer: VoiceOffer): string | null {
  if (!offer.enabled) return 'voice.consent.off'
  if (offer.minutes_left < 1) return 'voice.consent.noMinutes'
  return offer.sessions_left_today < 1 ? 'voice.consent.noSessions' : null
}

function ConsentStatements({ offer, name }: Readonly<{ offer: VoiceOffer; name: string }>) {
  const { t, i18n } = useTranslation('projectDetail')
  const language = languageSupport(i18n.language, offer.languages.supported)
  return (
    <>
      <ul className="list-disc space-y-2 pl-5 text-sm text-text">
        <li>{t('voice.consent.transcript')}</li>
        <li>{t('voice.consent.synthetic', { name })}</li>
        <li>{t('voice.consent.budget', {
          minutes: Math.floor(offer.minutes_left), session: offer.session_minutes,
          cost: formatCents(offer.estimated_cents_per_minute, i18n.language),
        })}</li>
      </ul>
      <p className="text-xs text-muted">{t('voice.consent.sessionsToday', { left: offer.sessions_left_today })}</p>
      {language.supported ? null : (
        <p role="note" className="badge badge-warn whitespace-normal text-left">{t('voice.consent.language', { supported: language.names })}</p>
      )}
      <p className="flex items-center gap-1.5 text-xs text-muted"><Headphones size={14} aria-hidden />{t('voice.consent.headphones')}</p>
    </>
  )
}

function ConsentBody({ offer, name, agreed, onAgree }: Readonly<{
  offer: VoiceOffer | undefined; name: string; agreed: boolean; onAgree: (value: boolean) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const agreeId = useId()
  if (offer === undefined) return <p role="status" className="text-sm text-muted">{t('voice.consent.loading')}</p>
  const blocked = blockedKey(offer)
  if (blocked !== null) return <p role="alert" className="text-sm text-text">{t(blocked)}</p>
  return (
    <div className="space-y-3">
      <ConsentStatements offer={offer} name={name} />
      <label htmlFor={agreeId} className="flex items-start gap-2 text-sm text-text-strong">
        <input id={agreeId} type="checkbox" className="mt-0.5" checked={agreed} onChange={(event) => onAgree(event.target.checked)} />
        {t('voice.consent.agree')}
      </label>
    </div>
  )
}

export default function VoiceConsentDialog({ projectId, personaId, name, onStarted, onCancel }: Readonly<{
  projectId: string
  personaId: string
  name: string
  onStarted: (session: StartedVoice) => void
  onCancel: () => void
}>) {
  const { t, i18n } = useTranslation('projectDetail')
  const titleId = useId()
  const [agreed, setAgreed] = useState(false)
  const offer = useQuery({ queryKey: voiceKeys.offer(projectId, personaId), queryFn: () => voiceSessionsApi.getOffer(projectId, personaId) })
  const start = useMutation({ mutationFn: () => startVoice(projectId, personaId, voiceLanguage(i18n.language)), onSuccess: onStarted })
  const canStart = agreed && offer.data !== undefined && blockedKey(offer.data) === null && !start.isPending
  return (
    <ModalShell isOpen onClose={onCancel} ariaLabelledBy={titleId} panelClassName="max-w-lg" dismissable={!start.isPending}>
      <div className="dialog-header justify-between">
        <h2 id={titleId} className="dialog-title">{t('voice.consent.title', { name })}</h2>
        <DialogClose onClick={onCancel} disabled={start.isPending} />
      </div>
      <div className="dialog-body space-y-3">
        {offer.isError
          ? <p role="alert" className="text-sm text-danger">{t('voice.consent.loadFailed')}</p>
          : <ConsentBody offer={offer.data} name={name} agreed={agreed} onAgree={setAgreed} />}
        {start.isError ? <p role="alert" className="text-sm text-danger">{t(startErrorKey(start.error))}</p> : null}
      </div>
      <div className="dialog-footer flex-col-reverse sm:flex-row">
        <button type="button" className="btn btn-secondary w-full sm:w-auto" onClick={onCancel} disabled={start.isPending}>
          {t('voice.consent.cancel')}
        </button>
        <button type="button" className="btn btn-primary w-full sm:w-auto" disabled={!canStart} onClick={() => start.mutate()}>
          {start.isPending ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Mic size={16} aria-hidden />}
          {start.isPending ? t('voice.consent.starting') : t('voice.consent.start')}
        </button>
      </div>
    </ModalShell>
  )
}
