/**
 * @fileoverview A fork connection's lines under its repository (7.57.00): which upstream it is a fork of, who owns the
 * connection (the person whose GitHub authorization opens the upstream pull request), the licence they acknowledged,
 * what a run's outcome is (a pull request on the upstream, opened as them once our gate passes, ready for review and
 * merged only by the upstream's maintainers), and the owner's switch "Open upstream pull requests for AI-assisted runs"
 * (`PUT /agents/engineering/connections/<id>/upstream`; an AI-driven run opens one anyway, a Human-driven one never).
 * Only the owner may turn the switch: anyone else sees it as it stands, disabled, and why.
 *
 * @module pages/Agents/ForkLines
 */
import { useId } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { GitFork } from 'lucide-react'
import clsx from 'clsx'
import { IconBadge } from '../../components/IconBadge/IconBadge'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { useConnectionError } from './connectionText'
import type { ConnectionList, EngineeringConnection, ForkFacts } from '../../api/engineeringConnectionsApi'

const TRACK = 'switch peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50'

/** "Fork of owner/name", beside the repository's name. */
export function ForkBadge({ fork }: Readonly<{ fork: ForkFacts }>) {
  const { t } = useTranslation('agents')
  return <IconBadge toneClass="badge-muted" icon={GitFork}>{t('connections.fork.badge', { upstream: fork.upstream })}</IconBadge>
}

/** The owner's switch: AI-assisted runs open the upstream pull request too. */
function AssistedSwitch({ connection, fork }: Readonly<{ connection: EngineeringConnection; fork: ForkFacts }>) {
  const { t } = useTranslation('agents')
  const errorText = useConnectionError()
  const queryClient = useQueryClient()
  const hintId = useId()
  const change = useMutation({
    mutationFn: (assisted: boolean) => engineeringConnectionsApi.setUpstream(connection.connection_id, { assisted }),
    onSuccess: (saved) => {
      queryClient.setQueryData<ConnectionList>(engineeringConnectionsKeys.list(), (list) => (list === undefined ? list : {
        ...list, connections: list.connections.map((c) => (c.connection_id === saved.connection_id ? saved : c)),
      }))
    },
  })
  const disabled = !fork.owned_by_me || change.isPending
  return (
    <div className="space-y-1">
      <label className="inline-flex items-center gap-2 text-[12px] text-text">
        <span className="relative inline-flex flex-shrink-0 items-center">
          <input type="checkbox" role="switch" className="peer sr-only" checked={fork.upstream_pr_assisted} disabled={disabled}
            aria-describedby={fork.owned_by_me ? undefined : hintId}
            onChange={(event) => { change.mutate(event.target.checked) }} />
          <span aria-hidden="true" className={clsx(TRACK, fork.upstream_pr_assisted && 'switch-on')}><span className="switch-knob" /></span>
        </span>
        <span>{t('connections.fork.assisted')}</span>
      </label>
      {!fork.owned_by_me && (
        <p id={hintId} className="text-[12px] text-muted">{t('connections.fork.ownerOnly', { owner: fork.owner })}</p>
      )}
      {change.isError && <p role="alert" className="text-[12px] text-danger">{errorText(change.error)}</p>}
    </div>
  )
}

/** The fork's upstream, owner, licence, its runs' outcome and the owner's switch. */
export function ForkLines({ connection, fork }: Readonly<{ connection: EngineeringConnection; fork: ForkFacts }>) {
  const { t } = useTranslation('agents')
  const owner = fork.owner === '' ? t('connections.ci.unknownPerson') : fork.owner
  return (
    <div className="space-y-1 pt-1" data-testid={`fork-lines-${connection.connection_id}`}>
      <p className="text-[12px] text-muted">
        {t('connections.fork.owner', { owner })}
        {fork.licence !== null && <> · {t('connections.fork.licence', { licence: fork.licence })}</>}
      </p>
      <p className="text-[12px] text-text">{t('connections.fork.outcome', { upstream: fork.upstream, owner })}</p>
      <AssistedSwitch connection={connection} fork={fork} />
    </div>
  )
}
