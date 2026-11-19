/**
 * @fileoverview Where GitHub sends a person back once they authorized one of the deployment's GitHub Apps as
 * themselves (`/agents/connections/github/authorized?code=…&state=…`, the App's callback URL; 7.57.00). The page takes
 * the code and the state, removes them from the address at once (a replace: the code is a bearer credential until it
 * is exchanged) and sends them once (`POST /agents/engineering/github-apps/authorizations`): the server exchanges the
 * code with GitHub and stores the token encrypted where only the broker reads it, never answering it. Then: "Authorized
 * as @login". Without a code or a state nothing is sent; a person who declined on GitHub comes back with an `error`
 * instead, said as such. A refusal is said in the server's words.
 *
 * The broker uses the authorization for one thing: the pull request a run on a fork connection this person owns opens
 * on the upstream, once our gate passed.
 *
 * @module pages/Agents/GitHubAppAuthorized
 */
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { githubAppsApi, githubAppsKeys } from '../../api/githubAppsApi'
import { useConnectionError } from './connectionText'
import { GitHubReturnFrame } from './GitHubReturnFrame'
import { useCodeExchange } from './githubCallback'
import type { GitHubAuthorization } from '../../api/githubAppsApi'
import type { RequestOutcome } from './githubCallback'

/** The query GitHub sends back: the authorization's code, the page's state, or why it was not given. */
const AUTHORIZED_QUERY = ['code', 'state', 'error', 'error_description', 'error_uri'] as const

function Authorized({ declined, outcome }: Readonly<{ declined: boolean; outcome: RequestOutcome<GitHubAuthorization> }>) {
  const { t } = useTranslation('agents')
  const errorText = useConnectionError()
  if (declined) return <p role="status" className="text-sm text-text">{t('connections.githubReturn.authorizeDeclined')}</p>
  switch (outcome.kind) {
    case 'idle':
      return <p className="text-sm text-text">{t('connections.githubReturn.noAuthorizeCode')}</p>
    case 'pending':
      return (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> {t('connections.githubReturn.authorizing')}
        </p>
      )
    case 'failed':
      return <p role="alert" className="text-sm text-danger">{errorText(outcome.error)}</p>
    case 'done':
      return (
        <>
          <p role="status" className="text-sm font-semibold text-text-strong">
            {t('connections.githubReturn.authorizedBody', { login: outcome.answer.login })}
          </p>
          <p className="text-sm text-text">{t('connections.githubReturn.authorizedUse')}</p>
        </>
      )
  }
}

/** The code's exchange (the server keeps the token), and the query it makes stale: the caller's authorizations. */
const authorize = (code: string, state: string) => githubAppsApi.authorized(code, state)
const STALE = [githubAppsKeys.authorizations()]

export default function GitHubAppAuthorized() {
  const { t } = useTranslation('agents')
  const { outcome, declined } = useCodeExchange(AUTHORIZED_QUERY, authorize, STALE, 'error')
  return (
    <GitHubReturnFrame title={t('connections.githubReturn.authorizedTitle')}>
      <Authorized declined={declined} outcome={outcome} />
    </GitHubReturnFrame>
  )
}
