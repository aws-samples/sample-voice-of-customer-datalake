/**
 * @fileoverview One person: edit (name, company, title, notes, tags; the email is fixed),
 * the lists they are on, the asks they were sent, and — for admins — erasure behind a
 * ConfirmModal that says what is deleted.
 * @module pages/Participants/PersonModal
 */
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Save, Trash2 } from 'lucide-react'
import ModalShell from '../../components/ModalShell/ModalShell'
import DialogClose from '../../components/DialogClose/DialogClose'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import type { Person, PersonDetail } from '../../api/participantsSchema'
import { useIsAdmin } from '../../store/authStore'
import { formatDateTime } from '../../utils/dateUtils'
import { KindBadge, PersonStatusBadge, RecipientStatusBadge } from './ParticipantBadges'
import { participantErrorMessage } from './participantErrors'
import { displayName } from './personLabel'
import { parseTags } from './participantInput'

function TextField({ label, value, onChange, multiline = false }: Readonly<{
  label: string; value: string; onChange: (v: string) => void; multiline?: boolean
}>) {
  return (
    <label className="block">
      <span className="block text-xs text-muted mb-1">{label}</span>
      {multiline
        ? <textarea value={value} rows={3} onChange={(e) => onChange(e.target.value)} className="input" />
        : <input value={value} onChange={(e) => onChange(e.target.value)} className="input w-full" />}
    </label>
  )
}

function EditForm({ person }: Readonly<{ person: Person }>) {
  const { t } = useTranslation('participants')
  const queryClient = useQueryClient()
  const [name, setName] = useState(person.name)
  const [company, setCompany] = useState(person.company)
  const [title, setTitle] = useState(person.title)
  const [notes, setNotes] = useState(person.notes)
  const [tags, setTags] = useState(person.tags.join(', '))
  const save = useMutation({
    mutationFn: () => participantsApi.updatePerson(person.person_id, {
      name: name.trim(), company: company.trim(), title: title.trim(), notes: notes.trim(), tags: parseTags(tags),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: participantsKeys.all() }),
  })
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('person.name')} value={name} onChange={setName} />
        <TextField label={t('person.company')} value={company} onChange={setCompany} />
        <TextField label={t('person.title')} value={title} onChange={setTitle} />
        <TextField label={t('person.tags')} value={tags} onChange={setTags} />
      </div>
      <TextField label={t('person.notes')} value={notes} onChange={setNotes} multiline />
      {save.isError ? <p role="alert" className="text-sm text-danger">{participantErrorMessage(save.error, t)}</p> : null}
      {save.isSuccess ? <p role="status" className="text-sm text-ok">{t('person.saved')}</p> : null}
      <button type="submit" disabled={save.isPending} className="btn btn-primary btn-sm">
        {save.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Save size={14} aria-hidden />}
        {t('actions.save')}
      </button>
    </form>
  )
}

function PersonHistory({ detail }: Readonly<{ detail: PersonDetail }>) {
  const { t, i18n } = useTranslation('participants')
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <section className="space-y-2" aria-label={t('person.lists')}>
        <h3 className="text-sm font-medium text-text">{t('person.lists')}</h3>
        {detail.lists.length === 0 ? <p className="text-sm text-muted">{t('person.noLists')}</p> : (
          <ul className="space-y-1">
            {detail.lists.map((list) => (
              <li key={list.list_id} className="flex flex-wrap items-center gap-2 text-sm text-text">
                <span className="break-words">{list.name}</span> <KindBadge kind={list.kind} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-2" aria-label={t('person.asks')}>
        <h3 className="text-sm font-medium text-text">{t('person.asks')}</h3>
        {detail.asks.length === 0 ? <p className="text-sm text-muted">{t('person.noAsks')}</p> : (
          <ul className="space-y-2">
            {detail.asks.map((ask) => (
              <li key={ask.ask_id} className="text-sm text-text space-y-0.5">
                <p className="break-words">{ask.subject}</p>
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <RecipientStatusBadge status={ask.status} />
                  {formatDateTime(ask.responded_at ?? ask.sent_at, i18n.language)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function ErasePerson({ person, onErased }: Readonly<{ person: Person; onErased: () => void }>) {
  const { t } = useTranslation('participants')
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const erase = useMutation({
    mutationFn: () => participantsApi.deletePerson(person.person_id),
    // Close first and drop the erased person's detail, or the refetch asks for it again (404).
    onSuccess: async () => {
      onErased()
      queryClient.removeQueries({ queryKey: participantsKeys.person(person.person_id), exact: true })
      await queryClient.invalidateQueries({ queryKey: participantsKeys.all() })
    },
  })
  return (
    <>
      <button type="button" onClick={() => setConfirming(true)} className="btn btn-danger btn-sm">
        <Trash2 size={14} aria-hidden /> {t('person.erase')}
      </button>
      <ConfirmModal isOpen={confirming} title={t('person.eraseTitle')}
        message={t('person.eraseMessage', { name: displayName(person) })}
        confirmLabel={t('person.eraseConfirm')} cancelLabel={t('actions.cancel')} isLoading={erase.isPending}
        onConfirm={() => erase.mutate()} onCancel={() => setConfirming(false)}>
        {erase.isError ? <p role="alert" className="mt-2 text-sm text-danger">{participantErrorMessage(erase.error, t)}</p> : null}
      </ConfirmModal>
    </>
  )
}

export default function PersonModal({ personId, onClose }: Readonly<{ personId: string; onClose: () => void }>) {
  const { t } = useTranslation('participants')
  const titleId = useId()
  const isAdmin = useIsAdmin()
  const detail = useQuery({ queryKey: participantsKeys.person(personId), queryFn: () => participantsApi.getPerson(personId) })
  const person = detail.data?.person

  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-2xl max-h-[90vh]">
      <div className="dialog-header justify-between">
        <div className="min-w-0 space-y-1">
          <h2 id={titleId} className="dialog-title break-words">{person === undefined ? t('person.heading') : displayName(person)}</h2>
          {person === undefined ? null : (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="break-all">{person.email}</span> <PersonStatusBadge status={person.status} />
            </p>
          )}
        </div>
        <DialogClose onClick={onClose} />
      </div>
      <div className="dialog-body space-y-5 overflow-y-auto">
        {detail.isPending ? <p role="status" className="text-sm text-muted">{t('loading')}</p> : null}
        {detail.isError ? <LoadFailed onRetry={() => void detail.refetch()} retrying={detail.isFetching} /> : null}
        {detail.data === undefined ? null : (
          <>
            <EditForm key={detail.data.person.updated_at} person={detail.data.person} />
            <PersonHistory detail={detail.data} />
            {isAdmin ? <ErasePerson person={detail.data.person} onErased={onClose} /> : null}
          </>
        )}
      </div>
    </ModalShell>
  )
}
