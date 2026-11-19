/**
 * @fileoverview Where GitHub sends an administrator once it created the deployment's GitHub App from its manifest
 * (`/agents/connections/github/created?code=…&state=…`, the manifest's `redirect_url`; 7.45.00). The page takes the
 * code and the state, removes them from the address at once and sends them once (`POST
 * /agents/engineering/github-apps/conversions`): the server exchanges the code with GitHub and stores the App's key
 * without ever answering it. Then the App's name and **Install on GitHub**, a plain link to its installation page
 * (whose own return is GitHubAppInstalled.tsx). Without a code or a state nothing is sent. A refusal is said in the
 * server's words: GitHub refusing the code (expired or used) means the App may exist on GitHub without its key here,
 * and the server's message says to delete it there and start again.
 *
 * @module pages/Agents/GitHubAppCreated
 */
import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { githubAppsApi, githubAppsKeys } from '../../api/githubAppsApi'
import { GitHubReturnFrame, ReturnProgress } from './GitHubReturnFrame'
import { leavingForGitHub } from './githubReturn'
import { useCodeExchange } from './githubCallback'
import type { CreatedApp } from '../../api/githubAppsApi'
import type { RequestOutcome } from './githubCallback'

/** The query GitHub sends back: the manifest's code (a bearer credential for an hour) and the page's state. */
const CREATED_QUERY = ['code', 'state'] as const

function Created({ outcome }: Readonly<{ outcome: RequestOutcome<CreatedApp> }>) {
  const { t } = useTranslation('agents')
  if (outcome.kind !== 'done') {
    return <ReturnProgress outcome={outcome} idle={t('connections.githubReturn.noCode')} pending={t('connections.githubReturn.creating')} />
  }
  return (
    <>
      <p role="status" className="text-sm text-text">{t('connections.githubReturn.createdBody', { slug: outcome.answer.app.slug })}</p>
      <a href={outcome.answer.installUrl} onClick={leavingForGitHub} className="btn btn-primary inline-flex items-center gap-1.5">
        <ExternalLink size={14} aria-hidden="true" /> {t('connections.githubReturn.installOnGitHub')}
      </a>
    </>
  )
}

export default function GitHubAppCreated() {
  const { t } = useTranslation('agents')
  const { outcome } = useCodeExchange(CREATED_QUERY, (code, state) => githubAppsApi.convert(code, state),
    [githubAppsKeys.list(), engineeringConnectionsKeys.list()])
  return (
    <GitHubReturnFrame title={t('connections.githubReturn.createdTitle')}>
      <Created outcome={outcome} />
    </GitHubReturnFrame>
  )
}
