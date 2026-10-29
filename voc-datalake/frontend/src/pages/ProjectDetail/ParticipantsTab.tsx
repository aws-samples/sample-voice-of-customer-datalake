/**
 * @fileoverview Project → Participants (docs/participants.md): the lists and people this
 * project can ask for feedback, how many distinct active people that reaches, adding and
 * removing them (edit access), "Ask for feedback" (the composer, prefilled with this
 * project and everyone linked), and this project's asks.
 * @module pages/ProjectDetail/ParticipantsTab
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Send, X } from 'lucide-react'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import type { ProjectParticipants } from '../../api/participantsSchema'
import AskComposer from '../Participants/AskComposer'
import AsksList from '../Participants/AsksList'
import { KindBadge } from '../Participants/ParticipantBadges'
import PersonRow from '../Participants/PersonRow'
import { participantErrorMessage } from '../Participants/participantErrors'
import { displayName } from '../Participants/personLabel'
import ParticipantsAdd from './ParticipantsAdd'

type Unlink = { readonly kind: 'list' | 'person'; readonly id: string }

function RemoveButton({ label, onClick, disabled }: Readonly<{ label: string; onClick: () => void; disabled: boolean }>) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} className="btn btn-ghost btn-sm">
      <X size={14} aria-hidden />
    </button>
  )
}

function Linked({ data, canEdit, onUnlink, unlinking }: Readonly<{
  data: ProjectParticipants; canEdit: boolean; onUnlink: (u: Unlink) => void; unlinking: boolean
}>) {
  const { t } = useTranslation('participants')
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="card space-y-2" aria-label={t('project.lists')}>
        <h3 className="text-sm font-semibold text-text-strong">{t('project.lists')}</h3>
        {data.lists.length === 0 ? <p className="text-sm text-muted">{t('project.noLists')}</p> : (
          <ul className="divide-y divide-border">
            {data.lists.map((list) => (
              <li key={list.list_id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1 text-sm text-text break-words">{list.name}</span>
                <KindBadge kind={list.kind} />
                <span className="text-xs text-muted">{t('lists.memberCount', { count: list.member_count })}</span>
                {canEdit ? <RemoveButton label={t('project.unlinkList', { name: list.name })} disabled={unlinking}
                  onClick={() => onUnlink({ kind: 'list', id: list.list_id })} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card space-y-2" aria-label={t('project.people')}>
        <h3 className="text-sm font-semibold text-text-strong">{t('project.people')}</h3>
        {data.people.length === 0 ? <p className="text-sm text-muted">{t('project.noPeople')}</p> : (
          <ul className="divide-y divide-border">
            {data.people.map((person) => (
              <PersonRow key={person.person_id} person={person} action={canEdit ? (
                <RemoveButton label={t('project.unlinkPerson', { name: displayName(person) })} disabled={unlinking}
                  onClick={() => onUnlink({ kind: 'person', id: person.person_id })} />
              ) : undefined} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function useUnlink(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ kind, id }: Unlink) => (kind === 'list'
      ? participantsApi.unlinkList(projectId, id)
      : participantsApi.unlinkPerson(projectId, id)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: participantsKeys.project(projectId) }),
  })
}

export default function ParticipantsTab({ projectId, canEdit }: Readonly<{ projectId: string; canEdit: boolean }>) {
  const { t } = useTranslation('participants')
  const [composing, setComposing] = useState(false)
  const linked = useQuery({ queryKey: participantsKeys.project(projectId), queryFn: () => participantsApi.getProject(projectId) })
  const unlink = useUnlink(projectId)

  if (linked.isPending) return <p role="status" className="text-sm text-muted">{t('loading')}</p>
  if (linked.isError) return <LoadFailed onRetry={() => void linked.refetch()} retrying={linked.isFetching} message={t('project.loadFailed')} />
  const data = linked.data

  return (
    <div className="space-y-4">
      <header className="card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold tracking-tight text-text-strong">{t('project.title')}</h2>
          <p className="text-sm text-muted">{t('project.reach', { count: data.reach })}</p>
        </div>
        {canEdit ? (
          <button type="button" onClick={() => setComposing(true)} className="btn btn-primary self-start" disabled={data.reach === 0}>
            <Send size={14} aria-hidden /> {t('project.ask')}
          </button>
        ) : null}
      </header>
      {unlink.isError ? <p role="alert" className="text-sm text-danger">{participantErrorMessage(unlink.error, t)}</p> : null}
      <Linked data={data} canEdit={canEdit} onUnlink={(u) => unlink.mutate(u)} unlinking={unlink.isPending} />
      {canEdit ? <ParticipantsAdd projectId={projectId} current={data} /> : null}
      <section className="space-y-2" aria-label={t('project.asks')}>
        <h3 className="text-sm font-semibold text-text-strong">{t('project.asks')}</h3>
        <AsksList projectId={projectId} />
      </section>
      {composing ? (
        <AskComposer projectId={projectId} initialListIds={data.lists.map((l) => l.list_id)}
          initialPersonIds={data.people.map((p) => p.person_id)} knownPeople={data.people} onClose={() => setComposing(false)} />
      ) : null}
    </div>
  )
}
