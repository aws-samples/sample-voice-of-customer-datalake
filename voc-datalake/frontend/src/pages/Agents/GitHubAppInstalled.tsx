/**
 * @fileoverview Where GitHub sends an administrator once they installed the deployment's GitHub App
 * (`/agents/connections/github/installed?installation_id=…&setup_action=…&state=…`, the manifest's `setup_url`;
 * 7.45.00). The page takes the query, removes it from the address at once and, for an installation started from Agents
 * → Connections (its state), sends it once (`POST /agents/engineering/github-apps/installations`): the server saves a
 * connection for every repository the installation covers, up to the connection limit, and says which it skipped.
 * Since 7.50.02 their issues follow: the page says what the deployment's GitHub Issues source reads now and each
 * repository's `voc-agent` label (ConnectionIssues.tsx `IssuesFollowLines`). Since 7.57.00 an installation started from
 * "Contribute to ‹upstream›" (ContributeCard.tsx) saves the person's fork alone, and the page says which upstream it
 * is a fork of.
 *
 * Nothing is sent when GitHub says an owner must approve the installation first (`setup_action=request`: the state
 * stays good until it expires), nor for a return without the page's state (an installation changed in GitHub's own
 * settings): the page then points to **Check installation** on the App.
 *
 * @module pages/Agents/GitHubAppInstalled
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { githubAppsApi, githubAppsKeys } from '../../api/githubAppsApi'
import { issuesSourceKeys } from '../../api/issuesSourceApi'
import { IssuesFollowLines } from './ConnectionIssues'
import { useConnectionError } from './connectionText'
import { GitHubReturnFrame } from './GitHubReturnFrame'
import { useSingleRequest, useTakenQuery } from './githubCallback'
import type { Installation, InstallationReturn, SkipReason } from '../../api/githubAppsApi'
import type { RequestOutcome } from './githubCallback'

const INSTALLED_QUERY = ['installation_id', 'setup_action', 'state'] as const
const INSTALLATION_ID = /^[1-9]\d{0,19}$/

/** Why nothing is sent: an owner must approve the installation, or the return carries no state of this page. */
type Held = 'approval' | 'noState'

/** What the return asks for: the installation to save, or why nothing is sent. */
type Asked = { held: Held } | { held: null; installation: InstallationReturn }

function readReturn(query: URLSearchParams): Asked {
  const action = query.get('setup_action') ?? ''
  if (action === 'request') return { held: 'approval' }
  const id = query.get('installation_id') ?? ''
  const state = query.get('state') ?? ''
  if (state === '' || !INSTALLATION_ID.test(id) || (action !== 'install' && action !== 'update')) return { held: 'noState' }
  return { held: null, installation: { installationId: Number(id), setupAction: action, state } }
}

function SkipLine({ repository, reason }: Readonly<{ repository: string; reason: SkipReason }>) {
  const { t } = useTranslation('agents')
  const texts: Record<SkipReason, string> = {
    archived: t('connections.githubReturn.skipped.archived', { repository }),
    already_connected: t('connections.githubReturn.skipped.already_connected', { repository }),
    limit: t('connections.githubReturn.skipped.limit', { repository }),
    not_saved: t('connections.githubReturn.skipped.not_saved', { repository }),
  }
  return <li>{texts[reason]}</li>
}

function Saved({ installation }: Readonly<{ installation: Installation }>) {
  const { t } = useTranslation('agents')
  const { app, account, connections, skipped } = installation
  return (
    <>
      <p role="status" className="text-sm font-semibold text-text-strong">
        {t('connections.githubReturn.installedBody', { count: connections.length, slug: app.slug })}
      </p>
      {account.login !== '' && <p className="text-sm text-muted">{t('connections.githubReturn.account', { account: account.login })}</p>}
      {installation.fork !== null && (
        <p className="text-sm text-text">{t('connections.githubReturn.forkConnected', installation.fork)}</p>
      )}
      {connections.length > 0 && (
        <ul className="list-disc list-inside text-sm text-text font-mono" aria-label={t('connections.githubReturn.connectedList')}>
          {connections.map(({ connection }) => <li key={connection.connection_id}>{connection.repository}</li>)}
        </ul>
      )}
      <IssuesFollowLines follow={installation.issues} />
      <p className="text-sm text-text">{t('connections.githubReturn.ciNext')}</p>
      {skipped.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm font-medium text-text-strong">{t('connections.githubReturn.skippedTitle')}</p>
          <ul className="list-disc list-inside text-sm text-muted">
            {skipped.map((skip) => <SkipLine key={skip.repository} repository={skip.repository} reason={skip.reason} />)}
          </ul>
        </div>
      )}
    </>
  )
}

function Outcome({ held, outcome }: Readonly<{ held: Held | null; outcome: RequestOutcome<Installation> }>) {
  const { t } = useTranslation('agents')
  const errorText = useConnectionError()
  if (held === 'approval') return <p role="status" className="text-sm text-text">{t('connections.githubReturn.approval')}</p>
  switch (outcome.kind) {
    case 'idle':
      return <p className="text-sm text-text">{t('connections.githubReturn.noState')}</p>
    case 'pending':
      return (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> {t('connections.githubReturn.installing')}
        </p>
      )
    case 'failed':
      return <p role="alert" className="text-sm text-danger">{errorText(outcome.error)}</p>
    case 'done':
      return <Saved installation={outcome.answer} />
  }
}

export default function GitHubAppInstalled() {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const taken = useTakenQuery(INSTALLED_QUERY)
  const [asked] = useState(() => readReturn(taken))
  const [request] = useState(() => {
    if (asked.held !== null) return null
    const { installation: returned } = asked
    return async () => {
      const installation = await githubAppsApi.installed(returned)
      void queryClient.invalidateQueries({ queryKey: githubAppsKeys.list() })
      void queryClient.invalidateQueries({ queryKey: engineeringConnectionsKeys.list() })
      void queryClient.invalidateQueries({ queryKey: issuesSourceKeys.view() })
      return installation
    }
  })
  const outcome = useSingleRequest(request)
  return (
    <GitHubReturnFrame title={t('connections.githubReturn.installedTitle')}>
      <Outcome held={asked.held} outcome={outcome} />
    </GitHubReturnFrame>
  )
}
