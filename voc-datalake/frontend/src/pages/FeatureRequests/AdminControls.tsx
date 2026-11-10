/**
 * @fileoverview Admin-only controls of a request: status, delete, and (app session) promote.
 * Rendered only for `viewer.is_admin`; the API refuses the same calls with 403 for anyone else.
 *
 * @module pages/FeatureRequests/AdminControls
 */
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import PromotePanel from './PromotePanel'
import StatusSelect from './StatusSelect'
import WriteError from './WriteError'
import { useCurrentBoard } from './boardContext'
import { boardStatusOf } from './boardStatuses'
import { useBoardWrite, useDeleteRequest } from './useBoardQueries'
import type { FeatureRequest } from '../../api/featureRequestsApi'

export default function AdminControls({ request, onDeleted }: Readonly<{ request: FeatureRequest; onDeleted: () => void }>) {
  const { t } = useTranslation('featureRequests')
  const board = useCurrentBoard()
  const [confirming, setConfirming] = useState(false)
  const status = useBoardWrite((api, next: string) => api.setStatus(request.request_id, next))
  const remove = useDeleteRequest(onDeleted)
  return (
    <section className="space-y-3 border-t border-border pt-3" aria-label={t('admin.title')}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <StatusSelect label={t('admin.status')} value={boardStatusOf(board, request.status).key}
          disabled={status.isPending} onChange={(next) => status.mutate(next)} />
        <button type="button" className="btn btn-ghost btn-sm text-danger" onClick={() => setConfirming(true)}>
          <Trash2 size={14} aria-hidden="true" />{t('admin.delete')}
        </button>
      </div>
      <WriteError error={status.error} />
      <PromotePanel request={request} />
      <ConfirmModal isOpen={confirming} title={t('admin.deleteTitle')} message={t('admin.deleteMessage', { title: request.title })}
        confirmLabel={t('actions.delete')} isLoading={remove.isPending}
        onConfirm={() => remove.mutate(request.request_id)} onCancel={() => setConfirming(false)}>
        <WriteError error={remove.error} />
      </ConfirmModal>
    </section>
  )
}
