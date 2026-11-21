/**
 * @fileoverview A persona focus group in the thread (docs/project-workspace.md → Persona focus groups): an answer's
 * `[fb:<id>]` citations as chips that open the review, each persona's colour, and the synthesis card with Save.
 *
 * The stream has already removed every citation outside the speaker's evidence pack, so every chip names a review
 * the person may open (the review modal reads it with their own access). Save files the turn as a `focus_group`
 * document: the transcript, the synthesis and the reviews cited, always synthetic (the server sets it).
 *
 * @module assistant/components/focusGroupParts
 */
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { FilePlus2, Loader2, MessageSquareQuote, MessagesSquare } from 'lucide-react'
import { personaGroundingApi } from '../../api/personaGroundingApi'
import { projectKey } from '../../api/projectQueryKeys'
import { useReviewModal } from '../../hooks/useReviewModal'
import { Tooltip } from '../../components/Tooltip/Tooltip'
import { formatDate } from '../../utils/dateUtils'
import { citationsOf, citedParts, transcriptMarkdown, turnOf, type TurnRound } from './focusGroupModel'
import type { PersonaCitation } from './messageHelpers'
import type { FocusGroupEvent } from '@stream/assistant/contract'
import type { ThreadState } from '../thread/types'

const MAX_TITLE_TOPIC_CHARS = 80

export function CitationChip({ feedbackId, index, citation }: Readonly<{
  feedbackId: string; index: number; citation: PersonaCitation | undefined
}>) {
  const { t } = useTranslation('assistant')
  const { openReview } = useReviewModal()
  const label = t('focusGroup.citation', { index })
  return (
    <Tooltip kind="label" content={citation?.text === undefined || citation.text === '' ? label : citation.text}>
      <button
        type="button"
        onClick={() => openReview(feedbackId)}
        aria-label={t('focusGroup.openCitation', { index })}
        className="mx-0.5 inline-flex items-center gap-0.5 rounded-full border border-border bg-card px-1.5 align-baseline text-[12px] font-medium text-text hover:border-border-strong hover:bg-bg-hover"
      >
        <MessageSquareQuote size={10} aria-hidden />
        {index}
      </button>
    </Tooltip>
  )
}

/** `text` with each `[fb:<id>]` as a numbered chip (numbered by first citation, `citations` for the tooltips). */
export function CitedText({ text, citations }: Readonly<{ text: string; citations: ReadonlyMap<string, PersonaCitation> }>) {
  return (
    <>
      {citedParts(text).map((part, position) => (part.kind === 'text'
        ? <Fragment key={`t${String(position)}`}>{part.value}</Fragment>
        : <CitationChip key={`c${String(position)}`} feedbackId={part.id} index={part.index} citation={citations.get(part.id)} />))}
    </>
  )
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

function useSaveFocusGroup(projectId: string | undefined, event: FocusGroupEvent, turn: { topic: string; rounds: TurnRound[] }) {
  const { t, i18n } = useTranslation('assistant')
  const queryClient = useQueryClient()
  const [state, setState] = useState<SaveState>('idle')
  const save = async () => {
    if (projectId === undefined) return
    setState('saving')
    const topic = turn.topic.length > MAX_TITLE_TOPIC_CHARS ? `${turn.topic.slice(0, MAX_TITLE_TOPIC_CHARS - 1)}…` : turn.topic
    try {
      await personaGroundingApi.saveFocusGroup(projectId, {
        title: t('focusGroup.document.title', { topic, date: formatDate(new Date(), i18n.language) }),
        content: transcriptMarkdown(t, event, turn),
        derivation: {
          persona_ids: event.config.persona_ids,
          feedback_ids: event.cited_feedback_ids,
          document_ids: event.config.documents?.map((document) => document.document_id) ?? [],
          library_item_ids: event.config.library?.map((item) => item.item_id) ?? [],
          rounds: Math.max(1, event.rounds_completed),
        },
      })
      await queryClient.invalidateQueries({ queryKey: projectKey(projectId) })
      setState('saved')
    } catch {
      setState('error')
    }
  }
  return { state, save }
}

function SynthesisList({ title, items, citations }: Readonly<{
  title: string; items: readonly string[]; citations: ReadonlyMap<string, PersonaCitation>
}>) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="text-[12px] font-semibold text-text-strong">{title}</p>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-sm text-text">
        {items.map((item) => <li key={item}><CitedText text={item} citations={citations} /></li>)}
      </ul>
    </div>
  )
}

/** The synthesis card that ends a focus group: its three lists, the synthetic label and Save. */
export function FocusGroupCard({ event, thread, messageId, projectId }: Readonly<{
  event: FocusGroupEvent; thread: ThreadState; messageId: string; projectId: string | undefined
}>) {
  const { t } = useTranslation('assistant')
  const turn = turnOf(thread, messageId)
  const citations = citationsOf(turn.rounds.flatMap((round) => round.responses))
  const { state, save } = useSaveFocusGroup(projectId, event, turn)
  const synthesis = event.synthesis
  return (
    <section className="card mt-2 space-y-2 p-3" aria-label={t('focusGroup.synthesis.title')}>
      <header className="flex flex-wrap items-center gap-2">
        <MessagesSquare size={14} className="text-aim" aria-hidden />
        <h3 className="text-sm font-semibold text-text-strong">{t('focusGroup.synthesis.title')}</h3>
        <span className="badge badge-aim">{t('focusGroup.synthetic')}</span>
      </header>
      {event.status === 'stopped' && <p className="text-[12px] text-muted">{t('focusGroup.stoppedNote')}</p>}
      {event.missing_persona_ids.length > 0 && (
        <p className="text-[12px] text-muted">{t('focusGroup.missingPersonas', { count: event.missing_persona_ids.length })}</p>
      )}
      {synthesis === undefined
        ? event.status === 'finished' && <p className="text-[12px] text-muted">{t('focusGroup.synthesis.unavailable')}</p>
        : (
          <>
            <SynthesisList title={t('focusGroup.synthesis.agreements')} items={synthesis.agreements} citations={citations} />
            <SynthesisList title={t('focusGroup.synthesis.disagreements')} items={synthesis.disagreements} citations={citations} />
            <SynthesisList title={t('focusGroup.synthesis.openQuestions')} items={synthesis.open_questions} citations={citations} />
          </>
        )}
      <p className="text-[12px] text-muted">{t('focusGroup.referenceOnly')}</p>
      {projectId !== undefined && turn.rounds.length > 0 && (
        <button type="button" disabled={state === 'saving' || state === 'saved'} onClick={() => { void save() }}
          className="btn btn-secondary btn-sm">
          {state === 'saving' ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <FilePlus2 size={12} aria-hidden />}
          {t(`focusGroup.save.${state}`)}
        </button>
      )}
    </section>
  )
}
