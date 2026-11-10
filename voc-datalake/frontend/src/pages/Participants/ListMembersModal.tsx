/**
 * @fileoverview One participant list opened: its members, an "add one person" form, a
 * per-member remove, and "Add many with the AI assistant", which opens the assistant on a
 * new conversation with a draft naming the list (nothing is sent until the user does).
 *
 * @module pages/Participants/ListMembersModal
 */
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Sparkles, UserMinus } from 'lucide-react'
import ModalShell from '../../components/ModalShell/ModalShell'
import DialogClose from '../../components/DialogClose/DialogClose'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { openAssistant } from '../../assistant/store/openAssistant'
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import type { NewPersonInput } from '../../api/participantsApi'
import type { AddMembersResult, ParticipantList, Person } from '../../api/participantsSchema'
import AddPersonForm from './AddPersonForm'
import { KindBadge } from './ParticipantBadges'
import { participantErrorMessage } from './participantErrors'
import AddResultNotice from './AddResultNotice'
import { displayName } from './personLabel'
import PersonRow from './PersonRow'

function MemberRow({ person, onRemove, removing }: Readonly<{ person: Person; onRemove: () => void; removing: boolean }>) {
  const { t } = useTranslation('participants')
  return (
    <PersonRow person={person} action={(
      <button type="button" onClick={onRemove} disabled={removing} className="btn btn-ghost btn-sm"
        aria-label={t('lists.removeMember', { name: displayName(person) })}>
        <UserMinus size={14} aria-hidden />
      </button>
    )} />
  )
}

function MemberList({ list }: Readonly<{ list: ParticipantList }>) {
  const { t } = useTranslation('participants')
  const queryClient = useQueryClient()
  const detail = useQuery({ queryKey: participantsKeys.list(list.list_id), queryFn: () => participantsApi.getList(list.list_id) })
  const remove = useMutation({
    mutationFn: (personId: string) => participantsApi.removeMember(list.list_id, personId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: participantsKeys.all() }),
  })
  if (detail.isPending) return <p role="status" className="text-sm text-muted">{t('loading')}</p>
  if (detail.isError) return <LoadFailed onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
  const members = detail.data.members
  return (
    <div className="space-y-2">
      {remove.isError ? <p role="alert" className="text-sm text-danger">{participantErrorMessage(remove.error, t)}</p> : null}
      {members.length === 0 ? <p className="text-sm text-muted">{t('lists.noMembers')}</p> : (
        <ul className="divide-y divide-border" aria-label={t('lists.members')}>
          {members.map((person) => (
            <MemberRow key={person.person_id} person={person} removing={remove.isPending}
              onRemove={() => remove.mutate(person.person_id)} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** The live count: the opened list's own read once it lands (an add or remove moves it). */
function MemberCount({ list }: Readonly<{ list: ParticipantList }>) {
  const { t } = useTranslation('participants')
  const detail = useQuery({ queryKey: participantsKeys.list(list.list_id), queryFn: () => participantsApi.getList(list.list_id) })
  return <span>{t('lists.memberCount', { count: detail.data?.list.member_count ?? list.member_count })}</span>
}

export default function ListMembersModal({ list, onClose }: Readonly<{ list: ParticipantList; onClose: () => void }>) {
  const { t } = useTranslation('participants')
  const titleId = useId()
  const queryClient = useQueryClient()
  const [result, setResult] = useState<AddMembersResult | null>(null)
  const add = useMutation({
    mutationFn: (person: NewPersonInput) => participantsApi.addMembers(list.list_id, { people: [person] }),
    onSuccess: (answer) => setResult(answer),
    onSettled: () => queryClient.invalidateQueries({ queryKey: participantsKeys.all() }),
  })
  const addOne = async (person: NewPersonInput): Promise<boolean> => {
    try {
      const answer = await add.mutateAsync(person)
      return answer.rejected.length === 0
    } catch {
      return false
    }
  }
  const askAssistant = () => {
    onClose()
    openAssistant({ prompt: t('lists.assistantDraft', { name: list.name }) })
  }

  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-2xl max-h-[90vh]">
      <div className="dialog-header justify-between">
        <div className="min-w-0 space-y-1">
          <h2 id={titleId} className="dialog-title break-words">{list.name}</h2>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <KindBadge kind={list.kind} />
            <MemberCount list={list} />
          </p>
        </div>
        <DialogClose onClick={onClose} />
      </div>
      <div className="dialog-body space-y-4 overflow-y-auto">
        {list.description === '' ? null : <p className="text-sm text-text break-words">{list.description}</p>}
        <section className="space-y-2" aria-label={t('lists.addOne')}>
          <h3 className="text-sm font-medium text-text">{t('lists.addOne')}</h3>
          <AddPersonForm onAdd={addOne} isPending={add.isPending} submitLabel={t('lists.addMember')} />
          {add.isError ? <p role="alert" className="text-sm text-danger">{participantErrorMessage(add.error, t)}</p> : null}
          {result === null ? null : <AddResultNotice result={result} />}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" onClick={askAssistant} className="btn btn-secondary btn-sm">
              <Sparkles size={14} aria-hidden /> {t('lists.addManyAssistant')}
            </button>
            <span className="text-xs text-muted">{t('lists.addManyHint')}</span>
          </div>
        </section>
        <section className="space-y-2" aria-label={t('lists.members')}>
          <h3 className="text-sm font-medium text-text">{t('lists.members')}</h3>
          <MemberList list={list} />
        </section>
      </div>
    </ModalShell>
  )
}
