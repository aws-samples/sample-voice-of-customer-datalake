/**
 * @fileoverview Agents → Connections (administrators, while the engineering agents are on): the repository
 * connections the engineering agents reach a repository through (`GET /agents/engineering/connections`). Each shows
 * its repository, default branch, its GitHub App's ids and whether its credential is set (never the private key),
 * and who changed it last; an administrator adds one, edits one (an empty private key keeps the stored credential),
 * or removes one after a confirmation that says live runs on it lose access within five minutes. Each shows its CI
 * attestation too (CiAttestation.tsx): an administrator attests that the repository's CI meets the setup guide, which
 * the agents' pushes and pull requests wait for, or withdraws it.
 *
 * @module pages/Agents/EngineeringConnections
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { GitBranch, KeyRound, Plus } from 'lucide-react'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { engineeringConnectionsApi, engineeringConnectionsKeys, isCiAttested } from '../../api/engineeringConnectionsApi'
import { useConfigStore } from '../../store/configStore'
import { formatDateTime } from '../../utils/dateUtils'
import { AttestDialog, CiAttestationLine, WithdrawConfirm } from './CiAttestation'
import { ConnectionDialog } from './ConnectionDialog'
import { CredentialGuidance } from './ConnectionFields'
import { ConnectionChangeConfirm } from './ConnectionModals'
import type { ConnectionList, EngineeringConnection, SavedConnection } from '../../api/engineeringConnectionsApi'

/** The dialog open: adding (null) or editing a connection, removing it, or attesting or withdrawing its CI. */
type Open =
  | { kind: 'edit'; connection: EngineeringConnection | null }
  | { kind: 'remove' | 'attest' | 'withdraw'; connection: EngineeringConnection }
  | null

/** What a row's buttons open. */
interface RowActions {
  onEdit: (c: EngineeringConnection) => void
  onRemove: (c: EngineeringConnection) => void
  onAttest: (c: EngineeringConnection) => void
  onWithdraw: (c: EngineeringConnection) => void
}

function ConnectionRow({ connection, actions }: Readonly<{ connection: EngineeringConnection; actions: RowActions }>) {
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
        <CiAttestationLine connection={connection} />
        {when !== '' && (
          <p className="text-[12px] text-muted">
            {t('connections.updated', { when, who: connection.updated_by ?? t('connections.unknownEditor') })}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {isCiAttested(connection)
          ? (
              <button type="button" className="btn btn-secondary" onClick={() => actions.onWithdraw(connection)}
                aria-label={t('connections.ci.withdrawLabel', { repository })}>{t('connections.ci.withdrawAction')}</button>
            )
          : (
              <button type="button" className="btn btn-secondary" onClick={() => actions.onAttest(connection)}
                aria-label={t('connections.ci.attestLabel', { repository })}>{t('connections.ci.attest')}</button>
            )}
        <button type="button" className="btn btn-secondary" onClick={() => actions.onEdit(connection)}
          aria-label={t('connections.editLabel', { repository })}>{t('connections.edit')}</button>
        <button type="button" className="btn btn-secondary" onClick={() => actions.onRemove(connection)}
          aria-label={t('connections.removeLabel', { repository })}>{t('connections.remove')}</button>
      </div>
    </li>
  )
}

function RemoveConfirm({ connection, onDone, onCancel }: Readonly<{
  connection: EngineeringConnection; onDone: () => void; onCancel: () => void
}>) {
  const { t } = useTranslation('agents')
  const { repository } = connection
  const without = (list: ConnectionList): ConnectionList =>
    ({ ...list, connections: list.connections.filter((c) => c.connection_id !== connection.connection_id) })
  return (
    <ConnectionChangeConfirm variant="danger" title={t('connections.confirm.title', { repository })}
      message={t('connections.confirm.message', { repository })} confirmLabel={t('connections.confirm.confirm')}
      change={() => engineeringConnectionsApi.remove(connection.connection_id)} update={without}
      onDone={onDone} onCancel={onCancel} />
  )
}

function ConnectionsBody({ list, actions }: Readonly<{ list: ConnectionList; actions: RowActions }>) {
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
        <ConnectionRow key={connection.connection_id} connection={connection} actions={actions} />
      ))}
    </ul>
  )
}

/** The one dialog open over the list, with the connection it is for. */
function OpenDialog({ open, onClose, onNotice }: Readonly<{
  open: Exclude<Open, null>; onClose: () => void; onNotice: (text: string) => void
}>) {
  const { t } = useTranslation('agents')
  const done = (key: string, repository: string) => {
    onNotice(t(key, { repository }))
    onClose()
  }
  if (open.kind === 'edit') {
    const saved = ({ connection, created }: SavedConnection) => {
      done(created ? 'connections.created' : 'connections.saved', connection.repository)
    }
    return <ConnectionDialog existing={open.connection} onClose={onClose} onSaved={saved} />
  }
  const { connection } = open
  const { repository } = connection
  if (open.kind === 'remove') {
    return <RemoveConfirm connection={connection} onCancel={onClose} onDone={() => done('connections.removed', repository)} />
  }
  if (open.kind === 'attest') {
    return <AttestDialog connection={connection} onClose={onClose} onRecorded={() => done('connections.ci.recorded', repository)} />
  }
  return <WithdrawConfirm connection={connection} onCancel={onClose} onDone={() => done('connections.ci.withdrawn', repository)} />
}

export function EngineeringConnections() {
  const { t } = useTranslation('agents')
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const read = useQuery({ queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list, enabled: configured })
  const [open, setOpen] = useState<Open>(null)
  const [notice, setNotice] = useState('')
  const list = read.data
  const full = list !== undefined && list.connections.length >= list.limit
  const opener = (kind: 'edit' | 'remove' | 'attest' | 'withdraw') => (connection: EngineeringConnection) => {
    setNotice('')
    setOpen({ kind, connection })
  }
  const actions: RowActions = {
    onEdit: opener('edit'), onRemove: opener('remove'), onAttest: opener('attest'), onWithdraw: opener('withdraw'),
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto min-w-0 max-w-prose space-y-1">
          <h2 className="text-lg font-semibold text-text-strong">{t('connections.title')}</h2>
          <p className="text-sm text-muted">{t('connections.intro')}</p>
        </div>
        {list !== undefined && (
          <button type="button" className="btn btn-primary" disabled={full} onClick={() => { setNotice(''); setOpen({ kind: 'edit', connection: null }) }}>
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
        <ConnectionsBody list={list} actions={actions} />
      )}
      <CredentialGuidance />
      {open !== null && <OpenDialog open={open} onClose={() => setOpen(null)} onNotice={setNotice} />}
    </div>
  )
}
