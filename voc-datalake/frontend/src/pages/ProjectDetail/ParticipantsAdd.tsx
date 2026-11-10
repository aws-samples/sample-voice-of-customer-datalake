/**
 * @fileoverview Bring people into a project: link a whole list, link an existing person,
 * or invite a new one (created and linked in one call). Edit access only; the route
 * re-checks it.
 * @module pages/ProjectDetail/ParticipantsAdd
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ListPlus } from 'lucide-react'
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import type { NewPersonInput, ProjectLinkInput } from '../../api/participantsApi'
import type { ProjectParticipants } from '../../api/participantsSchema'
import AddPersonForm from '../Participants/AddPersonForm'
import { rejectReason } from '../Participants/rejectReason'
import PersonSearch from '../Participants/PersonSearch'
import { participantErrorMessage } from '../Participants/participantErrors'

function useLinkMutation(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ProjectLinkInput) => participantsApi.linkToProject(projectId, input),
    onSuccess: (answer) => {
      queryClient.setQueryData(participantsKeys.project(projectId), answer)
      void queryClient.invalidateQueries({ queryKey: participantsKeys.lists() })
    },
  })
}

function AddList({ linked, onAdd, isPending }: Readonly<{ linked: readonly string[]; onAdd: (listId: string) => void; isPending: boolean }>) {
  const { t } = useTranslation('participants')
  const [listId, setListId] = useState('')
  const lists = useQuery({ queryKey: participantsKeys.lists(), queryFn: participantsApi.getLists })
  const available = (lists.data ?? []).filter((list) => !linked.includes(list.list_id))
  return (
    <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); if (listId !== '') { onAdd(listId); setListId('') } }}>
      <label className="block flex-1">
        <span className="block text-sm font-medium text-text mb-1">{t('project.addList')}</span>
        <select value={listId} onChange={(e) => setListId(e.target.value)} className="select w-full" disabled={available.length === 0}>
          <option value="">{available.length === 0 ? t('project.noMoreLists') : t('project.chooseList')}</option>
          {available.map((list) => <option key={list.list_id} value={list.list_id}>{list.name}</option>)}
        </select>
      </label>
      <button type="submit" disabled={listId === '' || isPending} className="btn btn-secondary btn-sm">
        <ListPlus size={14} aria-hidden /> {t('project.linkList')}
      </button>
    </form>
  )
}

export default function ParticipantsAdd({ projectId, current }: Readonly<{ projectId: string; current: ProjectParticipants }>) {
  const { t } = useTranslation('participants')
  const link = useLinkMutation(projectId)
  // The API answers 200 even when it refuses a new address (invalid, or external when that is off): it lists it in `rejected`.
  const [refused, setRefused] = useState<string | null>(null)
  const invite = async (person: NewPersonInput): Promise<boolean> => {
    setRefused(null)
    try {
      const answer = await link.mutateAsync({ people: [person] })
      const [rejected] = answer.rejected
      if (rejected === undefined) return true
      setRefused(`${rejected.email}: ${rejectReason(rejected.reason, t)}`)
      return false
    } catch {
      return false
    }
  }
  return (
    <section className="card space-y-4" aria-label={t('project.addHeading')}>
      <h3 className="text-sm font-semibold text-text-strong">{t('project.addHeading')}</h3>
      <AddList linked={current.lists.map((list) => list.list_id)} isPending={link.isPending}
        onAdd={(listId) => link.mutate({ list_ids: [listId] })} />
      <PersonSearch label={t('project.addPerson')} excludeIds={current.people.map((p) => p.person_id)}
        onPick={(person) => link.mutate({ person_ids: [person.person_id] })} />
      <div className="space-y-1">
        <p className="text-sm font-medium text-text">{t('project.invite')}</p>
        <AddPersonForm onAdd={invite} isPending={link.isPending} submitLabel={t('project.inviteSubmit')} />
      </div>
      {refused === null ? null : <p role="alert" className="text-sm text-danger break-all">{refused}</p>}
      {link.isError ? <p role="alert" className="text-sm text-danger">{participantErrorMessage(link.error, t)}</p> : null}
    </section>
  )
}
