/**
 * @fileoverview A live voice conversation with a project persona (docs/voice-personas.md): the "synthetic voice"
 * label always in view, the microphone's level, the captions of both sides as they are spoken (the persona's text
 * before it is spoken is shown muted, a turn the person spoke over is marked), the reviews the persona cited, the
 * clock against the session's limit, the cost so far and the month's minutes left, the relay's notices, and End.
 *
 * While the session runs the dialog closes only through End (Escape and the backdrop do nothing), so no session is
 * left running behind a closed dialog. After it, the transcript is filed as a `persona_interview` document: the dialog
 * says so, links it and offers Save to Library.
 *
 * The Product tab's interviewer (7.104.00) runs in the same dialog: an AI interviewer instead of a synthetic persona
 * (no citations), and at the end the person's answers are saved as one interview source of the project, which the
 * dialog says, and `onSourceSaved` lets the tab read its sources again.
 *
 * @module pages/ProjectDetail/voice/VoiceSessionModal
 */
import { useEffect, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { AudioLines, FileText, Library, Loader2, PhoneOff, RefreshCw } from 'lucide-react'
import DialogClose from '../../../components/DialogClose/DialogClose'
import ModalShell from '../../../components/ModalShell/ModalShell'
import { CitationChip } from '../../../assistant/components/focusGroupParts'
import type { VoiceSessionStatus } from '../../../api/voiceSessionsApi'
import { projectDocumentPath } from '../projectPaths'
import { formatCents, formatClock } from './voiceFormat'
import { useSaveInterviewToLibrary } from './useSaveInterviewToLibrary'
import { useVoiceSession } from './useVoiceSession'
import type { VoiceSessionTarget } from './useVoiceSession'
import type { VoiceCaption, VoiceState } from './voiceSessionState'

const PERCENT = 100

/** The relay's notices and end reasons, each with what the person reads. */
const NOTICE_KEYS = {
  time_almost_up: 'voice.session.notice.timeAlmostUp',
  budget_almost_up: 'voice.session.notice.budgetAlmostUp',
  wrapping_up: 'voice.session.notice.wrappingUp',
} as const
const ENDED_KEYS = {
  ended_by_person: 'voice.session.ended.byPerson',
  session_limit: 'voice.session.ended.sessionLimit',
  cost_limit: 'voice.session.ended.costLimit',
  budget: 'voice.session.ended.budget',
  busy: 'voice.session.ended.busy',
  error: 'voice.session.ended.error',
  disconnected: 'voice.session.ended.disconnected',
  refused: 'voice.session.ended.refused',
} as const
const PHASE_KEYS = {
  connecting: 'voice.session.connecting',
  live: 'voice.session.live',
  ending: 'voice.session.ending',
} as const

function MicMeter({ level }: Readonly<{ level: number }>) {
  const { t } = useTranslation('projectDetail')
  const percent = Math.round(Math.min(1, level * 4) * PERCENT)
  return (
    <div role="meter" aria-label={t('voice.session.micLevel')} aria-valuemin={0} aria-valuemax={PERCENT} aria-valuenow={percent}
      className="h-1.5 w-full overflow-hidden rounded-full bg-bg-accent">
      <div className="h-full bg-accent transition-[width] duration-100 motion-reduce:transition-none" style={{ width: `${String(percent)}%` }} />
    </div>
  )
}

function CaptionLine({ caption, name }: Readonly<{ caption: VoiceCaption; name: string }>) {
  const { t } = useTranslation('projectDetail')
  return (
    <li className={clsx('text-sm', caption.role === 'user' ? 'text-text' : 'text-text-strong')}>
      <span className="font-semibold">{caption.role === 'user' ? t('voice.session.you') : name}: </span>
      <span className={clsx(!caption.final && 'italic text-muted')}>{caption.text}</span>
      {caption.interrupted ? <span className="ml-1 text-xs text-muted">({t('voice.session.interrupted')})</span> : null}
      {caption.feedbackIds.map((id, index) => <CitationChip key={id} feedbackId={id} index={index + 1} citation={undefined} />)}
    </li>
  )
}

function Captions({ captions, name }: Readonly<{ captions: readonly VoiceCaption[]; name: string }>) {
  const { t } = useTranslation('projectDetail')
  return (
    <ol aria-live="polite" aria-label={t('voice.session.captions')} className="max-h-72 min-h-24 space-y-1.5 overflow-y-auto rounded-lg border border-border p-3">
      {captions.length === 0 ? <li className="text-sm text-muted">{t('voice.session.noCaptions')}</li> : null}
      {captions.map((caption) => <CaptionLine key={`${caption.role}-${String(caption.turn)}`} caption={caption} name={name} />)}
    </ol>
  )
}

function SessionLine({ state }: Readonly<{ state: VoiceState }>) {
  const { t } = useTranslation('projectDetail')
  const line = state.phase === 'ended' ? t(ENDED_KEYS[state.endReason ?? 'disconnected']) : t(PHASE_KEYS[state.phase])
  return (
    <div className="space-y-1">
      <p role="status" className="text-sm text-text">{line}</p>
      {state.notice !== null && state.phase !== 'ended'
        ? <p role="alert" className="badge badge-warn whitespace-normal">{t(NOTICE_KEYS[state.notice])}</p>
        : null}
    </div>
  )
}

function Meters({ state, elapsed }: Readonly<{ state: VoiceState; elapsed: number }>) {
  const { t, i18n } = useTranslation('projectDetail')
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <div><dt className="inline">{t('voice.session.time')} </dt>
        <dd className="inline font-mono">{formatClock(Math.max(elapsed, state.seconds))} / {formatClock(state.sessionSeconds)}</dd></div>
      <div><dt className="inline">{t('voice.session.cost')} </dt><dd className="inline font-mono">{formatCents(state.cents, i18n.language)}</dd></div>
      {state.minutesLeft === null ? null : (
        <div><dt className="inline">{t('voice.session.minutesLeft')} </dt><dd className="inline font-mono">{Math.floor(state.minutesLeft)}</dd></div>
      )}
    </dl>
  )
}

function EndFailed({ onRetryEnd }: Readonly<{ onRetryEnd: () => void }>) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="flex flex-wrap items-center gap-2" role="alert">
      <p className="text-sm text-danger">{t('voice.session.endFailed')}</p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onRetryEnd}>
        <RefreshCw size={14} aria-hidden />{t('loadFailed.retry', { ns: 'common' })}
      </button>
    </div>
  )
}

/** What a finalized product interview says: nothing said, saved, or saved past the project's cap of sources. */
function savedKey(status: VoiceSessionStatus): string {
  if (status.source_doc_id === null) return 'voice.product.session.nothingSaved'
  return status.over_source_cap ? 'voice.product.session.savedOverCap' : 'voice.product.session.saved'
}

/** A product interview's end: the answers saved as a source (or nothing to save: nobody spoke). */
function SourceOutcome({ status, endFailed, onRetryEnd, onSourceSaved }: Readonly<{
  status: VoiceSessionStatus | undefined; endFailed: boolean; onRetryEnd: () => void; onSourceSaved?: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  const finalized = status?.status === 'finalized'
  useEffect(() => {
    if (finalized) onSourceSaved?.()
  }, [finalized, onSourceSaved])
  if (endFailed) return <EndFailed onRetryEnd={onRetryEnd} />
  if (status?.status === 'failed') return <p role="alert" className="text-sm text-danger">{t('voice.product.session.savedFailed')}</p>
  if (!finalized) {
    return <p role="status" className="flex items-center gap-1.5 text-sm text-muted"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />{t('voice.product.session.saving')}</p>
  }
  return <p role="status" className="text-sm text-text">{t(savedKey(status))}</p>
}

function TranscriptOutcome({ projectId, status, endFailed, onRetryEnd }: Readonly<{
  projectId: string; status: VoiceSessionStatus | undefined; endFailed: boolean; onRetryEnd: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  const documentId = status?.transcript_document_id ?? null
  const library = useSaveInterviewToLibrary(projectId, documentId)
  if (endFailed) return <EndFailed onRetryEnd={onRetryEnd} />
  if (status?.status === 'failed') {
    return <p role="alert" className="text-sm text-danger">{t('voice.session.filedFailed')}</p>
  }
  if (documentId === null) {
    return <p role="status" className="flex items-center gap-1.5 text-sm text-muted"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />{t('voice.session.filing')}</p>
  }
  return (
    <div className="space-y-2" role="status">
      <p className="text-sm text-text">{t('voice.session.filed')}</p>
      <div className="flex flex-wrap gap-2">
        <Link to={projectDocumentPath(projectId, documentId)} className="btn btn-secondary btn-sm"><FileText size={14} aria-hidden />{t('voice.session.openTranscript')}</Link>
        <button type="button" className="btn btn-ghost btn-sm" disabled={library.isPending || library.isSuccess} onClick={() => library.mutate()}>
          <Library size={14} aria-hidden />{t(library.isPending ? 'voice.session.savingToLibrary' : 'voice.session.saveToLibrary')}
        </button>
      </div>
      {library.isSuccess ? <p className="text-xs text-muted">{t('voice.session.savedToLibrary')}</p> : null}
      {library.isError ? <p role="alert" className="text-xs text-danger">{t('voice.session.libraryFailed')}</p> : null}
    </div>
  )
}

/** The header's label and note, and what the other side is called in the captions. */
function useSideCopy(target: VoiceSessionTarget, name: string) {
  const { t } = useTranslation('projectDetail')
  return target.subject.kind === 'product'
    ? { title: t('voice.product.session.title'), badge: t('voice.product.session.badge'), note: t('voice.product.session.note'), speaker: t('voice.product.session.interviewer') }
    : { title: t('voice.session.title', { name }), badge: t('voice.session.synthetic'), note: t('voice.session.syntheticNote'), speaker: name }
}

export default function VoiceSessionModal({ target, name, onClose, onSourceSaved }: Readonly<{
  target: VoiceSessionTarget
  name: string
  onClose: () => void
  /** A product interview's answers were saved as a source (7.104.00). */
  onSourceSaved?: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  const titleId = useId()
  const session = useVoiceSession(target)
  const copy = useSideCopy(target, name)
  const { state } = session
  const over = state.phase === 'ended'
  const outcome = target.subject.kind === 'product'
    ? <SourceOutcome status={session.status} endFailed={session.endFailed} onRetryEnd={session.retryEnd} onSourceSaved={onSourceSaved} />
    : <TranscriptOutcome projectId={target.projectId} status={session.status} endFailed={session.endFailed} onRetryEnd={session.retryEnd} />
  return (
    <ModalShell isOpen onClose={over ? onClose : session.end} ariaLabelledBy={titleId} panelClassName="max-w-2xl" dismissable={over}>
      <div className="dialog-header justify-between">
        <div className="min-w-0">
          <h2 id={titleId} className="dialog-title">{copy.title}</h2>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
            <span className="badge badge-aim"><AudioLines size={12} aria-hidden />{copy.badge}</span>
            {copy.note}
          </p>
        </div>
        {over ? <DialogClose onClick={onClose} /> : null}
      </div>
      <div className="dialog-body space-y-3">
        <SessionLine state={state} />
        {over ? null : <MicMeter level={session.level} />}
        <Captions captions={state.captions} name={copy.speaker} />
        <Meters state={state} elapsed={session.elapsed} />
        {over ? outcome : null}
      </div>
      <div className="dialog-footer">
        {over ? (
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('voice.session.close')}</button>
        ) : (
          <button type="button" className="btn btn-danger" onClick={session.end} disabled={state.phase === 'ending'}>
            <PhoneOff size={16} aria-hidden />{t('voice.session.end')}
          </button>
        )}
      </div>
    </ModalShell>
  )
}
