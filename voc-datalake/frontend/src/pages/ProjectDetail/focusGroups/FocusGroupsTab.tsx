/**
 * @fileoverview Project → Focus groups (docs/project-workspace.md → Persona focus groups): put 2 to 6 of the project's
 * personas in one panel, give them a topic, 1 to 3 rounds and the documents they read, see the cost, and start. The
 * group runs in the assistant (a new conversation, the panel opens): round 1 independent, then the moderator's
 * follow-up and the others' anonymised points, then a synthesis that the person can save as a `focus_group` document.
 * Every statement is synthetic; every citation is a real review the person may open. The saved ones are listed here.
 *
 * @module pages/ProjectDetail/focusGroups/FocusGroupsTab
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { MessagesSquare, Play } from 'lucide-react'
import { FOCUS_GROUP_LIMITS, MENTION_LIMITS } from '@stream/assistant/contract'
import { libraryApi, libraryKeys } from '../../../api/libraryApi'
import { LabeledField } from '../../../components/LabeledField/LabeledField'
import PressedChoices from '../../../components/PressedChoices/PressedChoices'
import StickyActionBar from '../../../components/StickyActionBar/StickyActionBar'
import { startFocusGroup } from '../../../assistant/runtime/runtime'
import { useRunEnvironment } from '../../../assistant/runtime/useAssistant'
import { formatDate } from '../../../utils/dateUtils'
import PersonaAvatar from '../PersonaAvatar'
import { focusGroupCost, readingChars } from './focusGroupCost'
import type { FocusGroup } from '@stream/assistant/contract'
import type { ProjectDocument } from '../../../api/types'
import type { ProjectPersona } from '../../../api/projectTypes'

const ROUND_CHOICES = ['1', '2', '3'] as const
type RoundChoice = (typeof ROUND_CHOICES)[number]
/** The library items the panel offers (the ready ones, newest first). */
const LIBRARY_OFFERED = 20

interface FocusGroupsTabProps {
  readonly personas: readonly ProjectPersona[]
  readonly documents: readonly ProjectDocument[]
  /** Opens a saved focus group on the Documents tab. */
  readonly onSelectDoc: (document: ProjectDocument) => void
}

/** Toggle `id` in `chosen`, never past `max`. */
function toggled(chosen: readonly string[], id: string, max: number): string[] {
  if (chosen.includes(id)) return chosen.filter((one) => one !== id)
  return chosen.length >= max ? [...chosen] : [...chosen, id]
}

function PersonaPicker({ personas, chosen, onToggle }: Readonly<{
  personas: readonly ProjectPersona[]; chosen: readonly string[]; onToggle: (id: string) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const full = chosen.length >= FOCUS_GROUP_LIMITS.maxPersonas
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-[12px] font-medium text-muted">
        {t('focusGroups.personas', { count: chosen.length, max: FOCUS_GROUP_LIMITS.maxPersonas })}
      </legend>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {personas.map((persona) => {
          const checked = chosen.includes(persona.persona_id)
          return (
            <li key={persona.persona_id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border p-2 text-sm hover:bg-bg-hover">
                <input type="checkbox" checked={checked} disabled={!checked && full}
                  onChange={() => onToggle(persona.persona_id)} />
                {/* The name follows: the avatar (an image, or the name's initial) adds nothing to the label. */}
                <span aria-hidden><PersonaAvatar persona={persona} size="sm" /></span>
                <span className="min-w-0 truncate text-text">{persona.name}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}

function CheckList({ legend, items, chosen, max, onToggle }: Readonly<{
  legend: string; items: ReadonlyArray<{ id: string; label: string }>; chosen: readonly string[]; max: number
  onToggle: (id: string) => void
}>) {
  if (items.length === 0) return null
  return (
    <fieldset className="space-y-1">
      <legend className="text-[12px] font-medium text-muted">{legend}</legend>
      <ul className="space-y-0.5">
        {items.map((item) => {
          const checked = chosen.includes(item.id)
          return (
            <li key={item.id}>
              <label className="flex items-center gap-2 text-sm text-text">
                <input type="checkbox" checked={checked} disabled={!checked && chosen.length >= max} onChange={() => onToggle(item.id)} />
                <span className="min-w-0 truncate">{item.label}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}

/** A choice and the characters of text it holds (its share of every persona's reading: `readingChars`). */
interface ReadingChoice { id: string; label: string; chars: number }

/** The project documents a group can read: everything but prototypes and saved focus groups. */
function readableDocuments(documents: readonly ProjectDocument[]): ReadingChoice[] {
  return documents.filter((document) => document.document_type !== 'prototype' && document.document_type !== 'focus_group')
    .map((document) => ({
      id: document.document_id, label: document.title || document.document_type,
      chars: typeof document.content === 'string' ? document.content.length : 0,
    }))
}

function useLibraryChoices(): ReadingChoice[] {
  const query = useQuery({ queryKey: libraryKeys.list({ sort: 'newest' }), queryFn: () => libraryApi.list({ sort: 'newest' }) })
  return (query.data?.items ?? []).filter((item) => item.status === 'ready').slice(0, LIBRARY_OFFERED)
    .map((item) => ({ id: item.item_id, label: `#${item.slug} · ${item.title}`, chars: item.extracted_chars }))
}

/** The chosen choices' sizes, in the order chosen. */
function charsOf(choices: readonly ReadingChoice[], chosen: readonly string[]): number[] {
  const byId = new Map(choices.map((choice) => [choice.id, choice.chars]))
  return chosen.map((id) => byId.get(id) ?? 0)
}

function CostLine({ personas, rounds, reading }: Readonly<{ personas: number; rounds: number; reading: number }>) {
  const { t } = useTranslation('projectDetail')
  const cost = focusGroupCost(Math.max(personas, FOCUS_GROUP_LIMITS.minPersonas), rounds, reading)
  return (
    <p className="text-[12px] text-muted" data-testid="focus-group-cost">
      {t('focusGroups.cost', { calls: cost.calls, input: cost.inputTokens, output: cost.outputTokens })}
    </p>
  )
}

function FocusGroupPanel({ personas, documents }: Readonly<Pick<FocusGroupsTabProps, 'personas' | 'documents'>>) {
  const { t } = useTranslation('projectDetail')
  const env = useRunEnvironment()
  const [chosen, setChosen] = useState<string[]>([])
  const [topic, setTopic] = useState('')
  const [rounds, setRounds] = useState<RoundChoice>('2')
  const [documentIds, setDocumentIds] = useState<string[]>([])
  const [libraryIds, setLibraryIds] = useState<string[]>([])
  const library = useLibraryChoices()
  const documentChoices = useMemo(() => readableDocuments(documents), [documents])
  const ready = chosen.length >= FOCUS_GROUP_LIMITS.minPersonas && topic.trim() !== ''
  const start = () => {
    const group: FocusGroup = {
      persona_ids: chosen, rounds: Number(rounds),
      ...(documentIds.length > 0 ? { documents: documentIds.map((id) => ({ document_id: id })) } : {}),
      ...(libraryIds.length > 0 ? { library: libraryIds.map((id) => ({ item_id: id })) } : {}),
    }
    void startFocusGroup(topic.trim(), group, env)
  }
  return (
    <section className="card space-y-4 p-4" aria-label={t('focusGroups.newGroup')}>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-strong">
        <MessagesSquare size={16} aria-hidden />
        {t('focusGroups.newGroup')}
      </h3>
      <PersonaPicker personas={personas} chosen={chosen}
        onToggle={(id) => setChosen((current) => toggled(current, id, FOCUS_GROUP_LIMITS.maxPersonas))} />
      <LabeledField label={t('focusGroups.topic')} hint={t('focusGroups.topicHint')}>
        {(id) => (
          <textarea id={id} value={topic} maxLength={FOCUS_GROUP_LIMITS.maxTopicChars} rows={3}
            onChange={(event) => setTopic(event.target.value)} className="input w-full" aria-describedby={`${id}-hint`} />
        )}
      </LabeledField>
      <div className="space-y-1">
        <p className="text-[12px] font-medium text-muted">{t('focusGroups.rounds')}</p>
        <PressedChoices label={t('focusGroups.rounds')} choices={ROUND_CHOICES} value={rounds} onChange={setRounds}
          display={(choice) => t('focusGroups.roundCount', { count: Number(choice) })}
          className="flex flex-wrap gap-1.5" pressedClassName="btn btn-primary btn-sm" idleClassName="btn btn-secondary btn-sm" />
        <p className="text-[12px] text-muted">{t('focusGroups.roundsHint')}</p>
      </div>
      <CheckList legend={t('focusGroups.documents', { max: MENTION_LIMITS.maxDocuments })} items={documentChoices}
        chosen={documentIds} max={MENTION_LIMITS.maxDocuments}
        onToggle={(id) => setDocumentIds((current) => toggled(current, id, MENTION_LIMITS.maxDocuments))} />
      <CheckList legend={t('focusGroups.library', { max: MENTION_LIMITS.maxLibraryItems })} items={library}
        chosen={libraryIds} max={MENTION_LIMITS.maxLibraryItems}
        onToggle={(id) => setLibraryIds((current) => toggled(current, id, MENTION_LIMITS.maxLibraryItems))} />
      <CostLine personas={chosen.length} rounds={Number(rounds)}
        reading={readingChars(charsOf(documentChoices, documentIds), charsOf(library, libraryIds))} />
      <p className="text-[12px] text-muted">{t('focusGroups.synthetic')}</p>
      <StickyActionBar variant="footer">
        <button type="button" disabled={!ready} onClick={start} className="btn btn-primary">
          <Play size={14} aria-hidden />
          {t('focusGroups.start')}
        </button>
      </StickyActionBar>
    </section>
  )
}

function SavedGroups({ documents, onSelectDoc }: Readonly<Pick<FocusGroupsTabProps, 'documents' | 'onSelectDoc'>>) {
  const { t, i18n } = useTranslation('projectDetail')
  const saved = documents.filter((document) => document.document_type === 'focus_group')
  return (
    <section className="card space-y-2 p-4" aria-label={t('focusGroups.saved')}>
      <h3 className="text-sm font-semibold text-text-strong">{t('focusGroups.saved')}</h3>
      {saved.length === 0 ? <p className="text-sm text-muted">{t('focusGroups.noneSaved')}</p> : (
        <ul className="divide-y divide-border">
          {saved.map((document) => (
            <li key={document.document_id} className="flex flex-wrap items-center gap-2 py-2">
              <button type="button" className="link min-w-0 flex-1 truncate text-left text-sm" onClick={() => onSelectDoc(document)}>
                {document.title}
              </button>
              <span className="text-xs text-muted">{formatDate(document.created_at, i18n.language)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function FocusGroupsTab({ personas, documents, onSelectDoc }: FocusGroupsTabProps) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="space-y-4 p-4 sm:p-6">
      <p className="max-w-3xl text-sm text-text">{t('focusGroups.intro')}</p>
      {personas.length < FOCUS_GROUP_LIMITS.minPersonas
        ? <p className="card p-4 text-sm text-muted">{t('focusGroups.needPersonas', { count: FOCUS_GROUP_LIMITS.minPersonas })}</p>
        : <FocusGroupPanel personas={personas} documents={documents} />}
      <SavedGroups documents={documents} onSelectDoc={onSelectDoc} />
    </div>
  )
}
