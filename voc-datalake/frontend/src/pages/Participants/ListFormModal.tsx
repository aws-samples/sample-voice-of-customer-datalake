/**
 * @fileoverview Create or edit a participant list: name, kind, description.
 * @module pages/Participants/ListFormModal
 */
import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Save } from 'lucide-react'
import ModalShell from '../../components/ModalShell/ModalShell'
import DialogClose from '../../components/DialogClose/DialogClose'
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import { isListKind, LIST_KINDS } from '../../api/participantsSchema'
import type { ListKind, ParticipantList } from '../../api/participantsSchema'
import { kindLabel } from './kindLabel'
import { participantErrorMessage } from './participantErrors'

const MAX_NAME_CHARS = 120

export default function ListFormModal({ list, onClose }: Readonly<{
  /** The list to edit, or null to create one. */
  list: ParticipantList | null
  onClose: () => void
}>) {
  const { t } = useTranslation('participants')
  const titleId = useId()
  const queryClient = useQueryClient()
  const [name, setName] = useState(list?.name ?? '')
  const [kind, setKind] = useState<ListKind>(list?.kind ?? 'custom')
  const [description, setDescription] = useState(list?.description ?? '')
  const save = useMutation({
    mutationFn: () => {
      const input = { name: name.trim(), kind, description: description.trim() }
      return list === null ? participantsApi.createList(input) : participantsApi.updateList(list.list_id, input)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: participantsKeys.all() })
      onClose()
    },
  })
  const ready = name.trim() !== '' && name.length <= MAX_NAME_CHARS && !save.isPending

  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-lg max-h-[90vh]" dismissable={!save.isPending}>
      <form className="contents" onSubmit={(e) => { e.preventDefault(); if (ready) save.mutate() }}>
        <div className="dialog-header justify-between">
          <h2 id={titleId} className="dialog-title">{list === null ? t('lists.createTitle') : t('lists.editTitle')}</h2>
          <DialogClose onClick={onClose} disabled={save.isPending} />
        </div>
        <div className="dialog-body space-y-3 overflow-y-auto">
          <label className="block">
            <span className="block text-sm font-medium text-text mb-1">{t('lists.name')}</span>
            <input value={name} maxLength={MAX_NAME_CHARS} autoFocus onChange={(e) => setName(e.target.value)} className="input w-full" />
          </label>
          <label className="block">
            <span className="block text-sm font-medium text-text mb-1">{t('lists.kind')}</span>
            <select value={kind} onChange={(e) => { if (isListKind(e.target.value)) setKind(e.target.value) }} className="select w-full">
              {LIST_KINDS.map((k) => <option key={k} value={k}>{kindLabel(k, t)}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="block text-sm font-medium text-text mb-1">{t('lists.description')}</span>
            <textarea value={description} rows={3} onChange={(e) => setDescription(e.target.value)} className="input" />
          </label>
          {save.isError ? <p role="alert" className="text-sm text-danger">{participantErrorMessage(save.error, t)}</p> : null}
        </div>
        <div className="dialog-footer">
          <button type="button" onClick={onClose} disabled={save.isPending} className="btn btn-secondary">{t('actions.cancel')}</button>
          <button type="submit" disabled={!ready} className="btn btn-primary">
            {save.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Save size={14} aria-hidden />}
            {t('actions.save')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
