/**
 * @fileoverview Agents → Connections (administrators, while the engineering agents are on): the repository
 * connections the engineering agents reach a repository through (`GET /agents/engineering/connections`). Each shows
 * its repository, default branch, its GitHub App's ids and whether its credential is set (never the private key),
 * and who changed it last; an administrator adds one, edits one (an empty private key keeps the stored credential),
 * or removes one after a confirmation that says live runs on it lose access within five minutes.
 *
 * @module pages/Agents/EngineeringConnections
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { GitBranch, KeyRound, Plus } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { useConfigStore } from '../../store/configStore'
import { formatDateTime } from '../../utils/dateUtils'
import { ConnectionDialog } from './ConnectionDialog'
import { CredentialGuidance } from './ConnectionFields'
import { useConnectionError } from './connectionText'
import type { ConnectionList, EngineeringConnection, SavedConnection } from '../../api/engineeringConnectionsApi'

/** The dialog open: adding (null) or editing a connection. */
type Editing = { connection: EngineeringConnection | null } | null

function ConnectionRow({ connection, onEdit, onRemove }: Readonly<{
  connection: EngineeringConnection; onEdit: () => void; onRemove: () => void
}>) {
  const { t, i18n } = useTranslation('agents')
  const { repository, credential } = connection
  const when = formatDateTime(connection.updated_at, i18n.language, '')
  return (
    <li className="card p-4 flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-semibold text-text-strong font-mono break-words [overflow-wrap:anywhere]">{repository}</p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
          <span className="font-mono">{connection.connection_id}</span>
          <span className="inline-flex items-center gap-1">
            <GitBranch size={13} aria-hidden="true" />
            {t('connections.branch', { branch: connection.default_branch })}
          </span>
        </p>
        <p className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="badge badge-muted inline-flex items-center gap-1">
            <KeyRound size={12} aria-hidden="true" /> {t('connections.kind')}
          </span>
          {credential.app_id !== null && credential.installation_id !== null && (
            <span className="font-mono text-muted">
              {t('connections.appIds', { appId: credential.app_id, installationId: credential.installation_id })}
            </span>
          )}
          <span className={credential.set ? 'badge badge-ok' : 'badge badge-warn'}>
            {credential.set ? t('connections.set') : t('connections.notSet')}
          </span>
          {!credential.set && <span className="text-warn">{t('connections.notSetHint')}</span>}
        </p>
        {when !== '' && (
          <p className="text-[12px] text-muted">
            {t('connections.updated', { when, who: connection.updated_by ?? t('connections.unknownEditor') })}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" className="btn btn-secondary" onClick={onEdit}
          aria-label={t('connections.editLabel', { repository })}>{t('connections.edit')}</button>
        <button type="button" className="btn btn-secondary" onClick={onRemove}
          aria-label={t('connections.removeLabel', { repository })}>{t('connections.remove')}</button>
      </div>
    </li>
  )
}

function RemoveConfirm({ connection, onDone, onCancel }: Readonly<{
  connection: EngineeringConnection; onDone: () => void; onCancel: () => void
}>) {
  const { t } = useTranslation('agents')
  const errorText = useConnectionError()
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () => engineeringConnectionsApi.remove(connection.connection_id),
    onSuccess: () => {
      queryClient.setQueryData<ConnectionList>(engineeringConnectionsKeys.list(), (list) => (list === undefined ? list
        : { ...list, connections: list.connections.filter((c) => c.connection_id !== connection.connection_id) }))
      void queryClient.invalidateQueries({ queryKey: engineeringConnectionsKeys.list() })
      onDone()
    },
  })
  return (
    <ConfirmModal isOpen title={t('connections.confirm.title', { repository: connection.repository })}
      message={t('connections.confirm.message', { repository: connection.repository })}
      confirmLabel={t('connections.confirm.confirm')} cancelLabel={t('common.cancel')} isLoading={remove.isPending}
      onConfirm={() => { remove.mutate() }} onCancel={onCancel}>
      {remove.isError && <p role="alert" className="mt-3 text-[12px] text-danger">{errorText(remove.error)}</p>}
    </ConfirmModal>
  )
}

function ConnectionsBody({ list, onEdit, onRemove }: Readonly<{
  list: ConnectionList; onEdit: (c: EngineeringConnection) => void; onRemove: (c: EngineeringConnection) => void
}>) {
  const { t } = useTranslation('agents')
  if (list.connections.length === 0) {
    return (
      <div className="card text-center py-10">
        <KeyRound size={20} className="mx-auto text-muted" aria-hidden="true" />
        <p className="mt-2 text-sm font-semibold text-text-strong">{t('connections.emptyTitle')}</p>
        <p className="text-sm text-muted">{t('connections.emptyHint')}</p>
      </div>
    )
  }
  return (
    <ul className="space-y-2" aria-label={t('connections.title')}>
      {list.connections.map((connection) => (
        <ConnectionRow key={connection.connection_id} connection={connection}
          onEdit={() => onEdit(connection)} onRemove={() => onRemove(connection)} />
      ))}
    </ul>
  )
}

export function EngineeringConnections() {
  const { t } = useTranslation('agents')
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const read = useQuery({ queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list, enabled: configured })
  const [editing, setEditing] = useState<Editing>(null)
  const [removing, setRemoving] = useState<EngineeringConnection | null>(null)
  const [notice, setNotice] = useState('')
  const list = read.data
  const full = list !== undefined && list.connections.length >= list.limit
  const saved = ({ connection, created }: SavedConnection) => {
    setEditing(null)
    setNotice(t(created ? 'connections.created' : 'connections.saved', { repository: connection.repository }))
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto min-w-0 max-w-prose space-y-1">
          <h2 className="text-lg font-semibold text-text-strong">{t('connections.title')}</h2>
          <p className="text-sm text-muted">{t('connections.intro')}</p>
        </div>
        {list !== undefined && (
          <button type="button" className="btn btn-primary" disabled={full} onClick={() => { setNotice(''); setEditing({ connection: null }) }}>
            <Plus size={16} aria-hidden="true" /> {t('connections.add')}
          </button>
        )}
      </div>
      {full && <p className="text-[12px] text-muted">{t('connections.limitReached', { limit: list.limit })}</p>}
      <p role="status" className="text-[12px] text-ok">{notice}</p>
      {read.isPending && configured && <div className="skeleton h-24" />}
      {list === undefined && read.isError && (
        <LoadFailed message={t('connections.loadFailed')} onRetry={() => { void read.refetch() }} retrying={read.isFetching} />
      )}
      {list !== undefined && (
        <ConnectionsBody list={list} onEdit={(connection) => { setNotice(''); setEditing({ connection }) }}
          onRemove={(connection) => { setNotice(''); setRemoving(connection) }} />
      )}
      <CredentialGuidance />
      {editing !== null && <ConnectionDialog existing={editing.connection} onClose={() => setEditing(null)} onSaved={saved} />}
      {removing !== null && (
        <RemoveConfirm connection={removing} onCancel={() => setRemoving(null)} onDone={() => {
          setNotice(t('connections.removed', { repository: removing.repository }))
          setRemoving(null)
        }} />
      )}
    </div>
  )
}
