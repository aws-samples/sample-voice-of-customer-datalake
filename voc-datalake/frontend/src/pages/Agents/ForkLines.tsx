/**
 * @fileoverview A fork connection's lines under its repository (7.57.00): which upstream it is a fork of, who owns the
 * connection, the licence they acknowledged, and what a run's outcome is (a pull request on the upstream, one click away
 * once our gate passes: the person creates it on GitHub, and only the upstream's maintainers merge it).
 *
 * (7.58.00) **Acknowledge the current licence…**, the owner's alone: an upstream that changed its licence takes no
 * contribution acknowledged for the old one (the broker refuses the run's link, saying so). The upstream's licence is
 * read live (`GET /agents/engineering/public-repositories?q=<owner/name>`, GitHub's answer now; the stored facts are
 * the connect time's), then the owner ticks "I have read the ‹licence› licence and contribute under it" and
 * acknowledges it (`PUT /agents/engineering/connections/<id>/upstream` `{licence}`; the server reads the upstream again,
 * refuses a licence that is not its current one, and refreshes its default branch). Anyone else sees why they cannot.
 *
 * @module pages/Agents/ForkLines
 */
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { GitFork } from 'lucide-react'
import { IconBadge } from '../../components/IconBadge/IconBadge'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { publicRepositoriesApi, publicRepositoriesKeys } from '../../api/publicRepositoriesApi'
import { ConnectionChangeError } from './ConnectionChangeError'
import type { ConnectionList, EngineeringConnection, ForkFacts } from '../../api/engineeringConnectionsApi'

/** "Fork of owner/name", beside the repository's name. */
export function ForkBadge({ fork }: Readonly<{ fork: ForkFacts }>) {
  const { t } = useTranslation('agents')
  return <IconBadge toneClass="badge-muted" icon={GitFork}>{t('connections.fork.badge', { upstream: fork.upstream })}</IconBadge>
}

/** The upstream's licence as GitHub answers it now (its SPDX id; null for none), undefined while it is read. */
function useCurrentLicence(upstream: string): { licence: string | null | undefined; failed: boolean } {
  const found = useQuery({
    queryKey: publicRepositoriesKeys.search(upstream), queryFn: () => publicRepositoriesApi.search(upstream), retry: false,
  })
  if (found.isError) return { licence: undefined, failed: true }
  if (found.data === undefined) return { licence: undefined, failed: false }
  const match = found.data.repositories.find((repository) => repository.repository.toLowerCase() === upstream.toLowerCase())
  return { licence: match?.licence?.spdx ?? null, failed: false }
}

/** The owner's acknowledgement of the upstream's licence as it is now, once they asked for it. */
function AcknowledgeLicence({ connection, fork, onDone }: Readonly<{
  connection: EngineeringConnection; fork: ForkFacts; onDone: () => void
}>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const tickId = useId()
  const [ticked, setTicked] = useState(false)
  const { licence, failed } = useCurrentLicence(fork.upstream)
  const acknowledge = useMutation({
    mutationFn: (current: string) => engineeringConnectionsApi.acknowledgeLicence(connection.connection_id, { licence: current }),
    onSuccess: (saved) => {
      queryClient.setQueryData<ConnectionList>(engineeringConnectionsKeys.list(), (list) => (list === undefined ? list : {
        ...list, connections: list.connections.map((c) => (c.connection_id === saved.connection_id ? saved : c)),
      }))
      onDone()
    },
  })
  if (failed) return <p role="alert" className="text-[12px] text-danger">{t('connections.fork.licenceUnread')}</p>
  if (licence === undefined) return <p className="text-[12px] text-muted">{t('connections.fork.licenceReading')}</p>
  if (licence === null) return <p className="text-[12px] text-warn">{t('connections.fork.licenceNone', { upstream: fork.upstream })}</p>
  return (
    <div className="space-y-1 text-[12px]" data-testid={`fork-licence-${connection.connection_id}`}>
      <p className="text-text">
        {t('connections.fork.licenceNow', { upstream: fork.upstream, licence })}
        {licence === fork.licence && <> {t('connections.fork.licenceUnchanged')}</>}
      </p>
      <label htmlFor={tickId} className="flex items-start gap-2 text-text">
        <input id={tickId} type="checkbox" className="mt-0.5" checked={ticked} onChange={(event) => { setTicked(event.target.checked) }} />
        {t('connections.contribute.licence', { licence })}
      </label>
      <button type="button" className="btn btn-secondary btn-sm" disabled={!ticked || acknowledge.isPending}
        onClick={() => { acknowledge.mutate(licence) }}>
        {t('connections.fork.licenceConfirm', { licence })}
      </button>
      <ConnectionChangeError change={acknowledge} />
    </div>
  )
}

/** The fork's upstream, owner, licence and its runs' outcome; the owner's acknowledgement of a changed licence. */
export function ForkLines({ connection, fork }: Readonly<{ connection: EngineeringConnection; fork: ForkFacts }>) {
  const { t } = useTranslation('agents')
  const [asked, setAsked] = useState(false)
  const owner = fork.owner === '' ? t('connections.ci.unknownPerson') : fork.owner
  return (
    <div className="space-y-1 pt-1" data-testid={`fork-lines-${connection.connection_id}`}>
      <p className="text-[12px] text-muted">
        {t('connections.fork.owner', { owner })}
        {fork.licence !== null && <> · {t('connections.fork.licence', { licence: fork.licence })}</>}
      </p>
      <p className="text-[12px] text-text">{t('connections.fork.outcome', { upstream: fork.upstream, owner })}</p>
      {!fork.owned_by_me && <p className="text-[12px] text-muted">{t('connections.fork.ownerOnly', { owner })}</p>}
      {fork.owned_by_me && !asked && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAsked(true) }}>
          {t('connections.fork.acknowledge')}
        </button>
      )}
      {fork.owned_by_me && asked && <AcknowledgeLicence connection={connection} fork={fork} onDone={() => { setAsked(false) }} />}
    </div>
  )
}
