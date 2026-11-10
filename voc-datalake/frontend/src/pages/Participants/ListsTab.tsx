/**
 * @fileoverview Participants → Lists: one card per list (name, kind, member count) with
 * open / edit / delete (admin), and "New list". Deleting a list keeps its people.
 * @module pages/Participants/ListsTab
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ListPlus, Pencil, Trash2, Users } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import type { ParticipantList } from '../../api/participantsSchema'
import { useIsAdmin } from '../../store/authStore'
import ListFormModal from './ListFormModal'
import ListMembersModal from './ListMembersModal'
import { KindBadge } from './ParticipantBadges'
import { participantErrorMessage } from './participantErrors'

type Dialog =
  | { readonly kind: 'none' }
  | { readonly kind: 'form'; readonly list: ParticipantList | null }
  | { readonly kind: 'open'; readonly list: ParticipantList }
  | { readonly kind: 'delete'; readonly list: ParticipantList }

function ListCard({ list, isAdmin, onOpen, onEdit, onDelete }: Readonly<{
  list: ParticipantList; isAdmin: boolean; onOpen: () => void; onEdit: () => void; onDelete: () => void
}>) {
  const { t } = useTranslation('participants')
  return (
    <li className="card flex flex-col gap-3">
      <div className="min-w-0 space-y-1">
        <h3 className="text-base font-semibold text-text-strong break-words">{list.name}</h3>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <KindBadge kind={list.kind} />
          <span>{t('lists.memberCount', { count: list.member_count })}</span>
        </p>
        {list.description === '' ? null : <p className="text-sm text-text break-words">{list.description}</p>}
      </div>
      <div className="mt-auto flex flex-wrap gap-2">
        <button type="button" onClick={onOpen} className="btn btn-primary btn-sm">
          <Users size={14} aria-hidden /> {t('lists.open')}
        </button>
        <button type="button" onClick={onEdit} className="btn btn-secondary btn-sm" aria-label={t('lists.editNamed', { name: list.name })}>
          <Pencil size={14} aria-hidden /> {t('actions.edit')}
        </button>
        {isAdmin ? (
          <button type="button" onClick={onDelete} className="btn btn-danger btn-sm" aria-label={t('lists.deleteNamed', { name: list.name })}>
            <Trash2 size={14} aria-hidden /> {t('actions.delete')}
          </button>
        ) : null}
      </div>
    </li>
  )
}

function EmptyLists({ onCreate }: Readonly<{ onCreate: () => void }>) {
  const { t } = useTranslation('participants')
  return (
    <section className="card space-y-2 text-center">
      <h2 className="text-base font-semibold text-text-strong">{t('lists.emptyTitle')}</h2>
      <p className="text-sm text-muted">{t('lists.emptyBody')}</p>
      <button type="button" onClick={onCreate} className="btn btn-primary btn-sm mx-auto">
        <ListPlus size={14} aria-hidden /> {t('lists.create')}
      </button>
    </section>
  )
}

function DeleteListConfirm({ list, onClose }: Readonly<{ list: ParticipantList; onClose: () => void }>) {
  const { t } = useTranslation('participants')
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () => participantsApi.deleteList(list.list_id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: participantsKeys.all() })
      onClose()
    },
  })
  return (
    <ConfirmModal isOpen title={t('lists.deleteTitle')} message={t('lists.deleteMessage', { name: list.name })}
      confirmLabel={t('actions.delete')} cancelLabel={t('actions.cancel')} isLoading={remove.isPending}
      onConfirm={() => remove.mutate()} onCancel={onClose}>
      {remove.isError ? <p role="alert" className="mt-2 text-sm text-danger">{participantErrorMessage(remove.error, t)}</p> : null}
    </ConfirmModal>
  )
}

function DialogView({ dialog, onClose }: Readonly<{ dialog: Dialog; onClose: () => void }>) {
  switch (dialog.kind) {
    case 'form': return <ListFormModal list={dialog.list} onClose={onClose} />
    case 'open': return <ListMembersModal list={dialog.list} onClose={onClose} />
    case 'delete': return <DeleteListConfirm list={dialog.list} onClose={onClose} />
    case 'none': return null
  }
}

export default function ListsTab() {
  const { t } = useTranslation('participants')
  const isAdmin = useIsAdmin()
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const lists = useQuery({ queryKey: participantsKeys.lists(), queryFn: participantsApi.getLists })
  const create = () => setDialog({ kind: 'form', list: null })

  const body = () => {
    if (lists.isPending) return <p role="status" className="text-sm text-muted">{t('loading')}</p>
    if (lists.isError) return <LoadFailed onRetry={() => void lists.refetch()} retrying={lists.isFetching} message={t('lists.loadFailed')} />
    if (lists.data.length === 0) return <EmptyLists onCreate={create} />
    return (
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={t('tabs.lists')}>
        {lists.data.map((list) => (
          <ListCard key={list.list_id} list={list} isAdmin={isAdmin}
            onOpen={() => setDialog({ kind: 'open', list })}
            onEdit={() => setDialog({ kind: 'form', list })}
            onDelete={() => setDialog({ kind: 'delete', list })} />
        ))}
      </ul>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted max-w-prose">{t('lists.intro')}</p>
        <button type="button" onClick={create} className="btn btn-secondary btn-sm">
          <ListPlus size={14} aria-hidden /> {t('lists.create')}
        </button>
      </div>
      {body()}
      <DialogView dialog={dialog} onClose={() => setDialog({ kind: 'none' })} />
    </div>
  )
}
