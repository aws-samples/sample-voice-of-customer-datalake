/**
 * @fileoverview The scope an engineering view is read for (Skills, the Registry): the shared skills every connection
 * falls back to, or one stored repository connection, named by its repository (`owner/name`, its id after it), and a
 * connection the address names kept even when it is not stored (part 2 S10).
 *
 * @module pages/Agents/ScopePicker
 */
import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { useConfigStore } from '../../store/configStore'

export function ScopePicker({ connection, onChange, label, sharedLabel }: Readonly<{
  connection: string; onChange: (connection: string) => void
  /** The select's visible label ("Skills of", "Cards for"). */
  label: string
  /** The shared scope's option ("Shared skills"). */
  sharedLabel: string
}>) {
  const { t } = useTranslation('agents')
  const id = useId()
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const { data, isError } = useQuery({
    queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list, enabled: configured,
  })
  const stored = data?.connections ?? []
  const repositories = new Map(stored.map((entry) => [entry.connection_id, entry.repository]))
  const ids = stored.map((entry) => entry.connection_id)
  const offered = connection === '' || ids.includes(connection) ? ids : [connection, ...ids]
  const nameOf = (name: string) => {
    const repository = repositories.get(name)
    return repository === undefined ? t('skills.connection', { name }) : t('skills.connectionRepository', { repository, name })
  }
  return (
    <div>
      <label htmlFor={id} className="block text-[12px] font-semibold text-muted">{label}</label>
      <select id={id} className="select w-auto max-w-full" value={connection} onChange={(e) => onChange(e.target.value)}>
        <option value="">{sharedLabel}</option>
        {offered.map((name) => <option key={name} value={name}>{nameOf(name)}</option>)}
      </select>
      {isError && <p className="text-[12px] text-warn">{t('skills.connectionsFailed')}</p>}
    </div>
  )
}
