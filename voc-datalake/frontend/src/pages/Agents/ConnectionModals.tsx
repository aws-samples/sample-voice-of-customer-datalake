/**
 * @fileoverview The two dialog frames every change of a repository connection goes through (Agents → Connections): a
 * form dialog (its title and description, the form's body, the server's refusal said in its own words, Cancel and the
 * save button, not dismissable while the request runs), and a confirmation that makes one change and refreshes the
 * list. Adding or editing a connection and attesting its CI use the first; removing it and withdrawing its CI
 * attestation use the second.
 *
 * @module pages/Agents/ConnectionModals
 */
import { useId } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import ModalShell from '../../components/ModalShell/ModalShell'
import { engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { useConnectionError } from './connectionText'
import type { ConnectionList, EngineeringConnection } from '../../api/engineeringConnectionsApi'

export function ConnectionFormModal({ title, description, saveLabel, pending, error, onClose, onSubmit, children }: Readonly<{
  title: string
  description: string
  saveLabel: string
  /** The request is running: the dialog stays open and the form is not sent again. */
  pending: boolean
  /** The request's refusal, said under the form; null for none. */
  error: unknown
  onClose: () => void
  onSubmit: () => void
  children: ReactNode
}>) {
  const { t } = useTranslation('agents')
  const errorText = useConnectionError()
  const titleId = useId()
  const descriptionId = useId()
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-lg" dismissable={!pending}>
      <div className="dialog-header">
        <div>
          <h2 id={titleId} className="dialog-title whitespace-normal">{title}</h2>
          <p id={descriptionId} className="dialog-description">{description}</p>
        </div>
      </div>
      <form className="contents" noValidate aria-describedby={descriptionId} onSubmit={(event) => {
        event.preventDefault()
        if (!pending) onSubmit()
      }}>
        <div className="dialog-body space-y-3">
          {children}
          {error !== null && <p role="alert" className="text-[12px] text-danger">{errorText(error)}</p>}
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" aria-disabled={pending}>
            {pending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} {saveLabel}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

/** What a confirmation of one change to a connection takes: the connection, and what follows the change or a cancel. */
export type ConnectionConfirmProps = Readonly<{ connection: EngineeringConnection; onDone: () => void; onCancel: () => void }>

export function ConnectionChangeConfirm({
  title, message, confirmLabel, variant, change, update, onDone, onCancel, children,
}: Readonly<{
  title: string
  message: string
  confirmLabel: string
  variant: 'danger' | 'warning'
  /** The change, made once the person confirms. */
  change: () => Promise<void>
  /** The list as the change leaves it, shown until it is read again; the list as it was when not given. */
  update?: (list: ConnectionList) => ConnectionList
  onDone: () => void
  onCancel: () => void
  /** What the confirmation takes besides the yes (a note), under its message. */
  children?: ReactNode
}>) {
  const { t } = useTranslation('agents')
  const errorText = useConnectionError()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: change,
    onSuccess: () => {
      if (update !== undefined) {
        queryClient.setQueryData<ConnectionList>(engineeringConnectionsKeys.list(), (list) => (list === undefined ? list : update(list)))
      }
      void queryClient.invalidateQueries({ queryKey: engineeringConnectionsKeys.list() })
      onDone()
    },
  })
  return (
    <ConfirmModal isOpen variant={variant} title={title} message={message} confirmLabel={confirmLabel}
      cancelLabel={t('common.cancel')} isLoading={mutation.isPending} onConfirm={() => { mutation.mutate() }} onCancel={onCancel}>
      {children}
      {mutation.isError && <p role="alert" className="mt-3 text-[12px] text-danger">{errorText(mutation.error)}</p>}
    </ConfirmModal>
  )
}
