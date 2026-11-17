/**
 * @fileoverview How the deployment's GitHub Issues card signs in (7.45.00; App-first since 7.50.02, githubSignIn.ts):
 *
 * - with an App (the default once the deployment has one): in plain words what that means, the App it signs in with
 *   (its name, or a choice among several), and a small "Use a fine-grained token instead";
 * - with the token: what the token needs, and "Sign in with your GitHub App instead"; or, while the deployment has no
 *   App at all, "Connect GitHub" (Agents → Connections, where the App is made in two clicks), which configures this
 *   source by itself.
 *
 * @module pages/Settings/GitHubSignInChoice
 */
import { useId } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { agentsPath } from '../Agents/agentsPaths'
import type { GitHubApp } from '../../api/githubAppsApi'
import type { GitHubSignIn } from './githubSignIn'

const CONNECTIONS_PATH = agentsPath({ view: 'connections' })
const SWITCH = 'link text-xs sm:text-sm self-start'

const appName = (app: GitHubApp): string => `${app.slug} (${app.owner})`

/** The App the card signs in with: its name when it is the only one, a choice among several. */
function AppChoice({ apps, appId, onChoose }: Readonly<{ apps: GitHubApp[]; appId: string; onChoose: (appId: string) => void }>) {
  const { t } = useTranslation('settings')
  const id = useId()
  const [only] = apps
  if (apps.length === 1 && only !== undefined) {
    return <p className="text-xs sm:text-sm text-text">{t('sourceCard.githubSignIn.oneApp', { app: appName(only) })}</p>
  }
  return (
    <div>
      <label htmlFor={id} className="block text-xs sm:text-sm font-medium text-text mb-1">
        {t('sourceCard.githubSignIn.appLabel')}<span className="text-danger ml-1">*</span>
      </label>
      <select id={id} className="select text-xs sm:text-sm" value={appId} onChange={(event) => { onChoose(event.target.value) }}>
        <option value="">{t('sourceCard.githubSignIn.chooseApp')}</option>
        {apps.map((app) => <option key={app.app_id} value={app.app_id}>{appName(app)}</option>)}
      </select>
    </div>
  )
}

function AppSignIn({ signIn }: Readonly<{ signIn: GitHubSignIn }>) {
  const { t } = useTranslation('settings')
  return (
    <div className="flex flex-col gap-2" data-testid="github-sign-in">
      <p className="text-xs sm:text-sm text-text">{t('sourceCard.githubSignIn.appIntro')}</p>
      {signIn.apps !== undefined && signIn.apps.length > 0 && (
        <AppChoice apps={signIn.apps} appId={signIn.appId} onChoose={signIn.chooseApp} />
      )}
      <p className="text-xs text-muted">{t('sourceCard.githubSignIn.appHint')}</p>
      <button type="button" className={SWITCH} onClick={() => { signIn.choose('token') }}>
        {t('sourceCard.githubSignIn.useToken')}
      </button>
    </div>
  )
}

function TokenSignIn({ signIn }: Readonly<{ signIn: GitHubSignIn }>) {
  const { t } = useTranslation('settings')
  // (no App at all, as the list answered: the App is made under Agents → Connections, never here)
  const noApp = signIn.apps?.length === 0
  return (
    <div className="flex flex-col gap-2" data-testid="github-sign-in">
      <p className="text-xs text-muted">{t('sourceCard.githubSignIn.tokenHint')}</p>
      {noApp ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs sm:text-sm text-text">{t('sourceCard.githubSignIn.connectHint')}</p>
          <Link to={CONNECTIONS_PATH} className="btn btn-secondary text-xs sm:text-sm self-start">
            {t('sourceCard.githubSignIn.connect')}
          </Link>
        </div>
      ) : (
        <button type="button" className={SWITCH} onClick={() => { signIn.choose('app') }}>
          {t('sourceCard.githubSignIn.useApp')}
        </button>
      )}
    </div>
  )
}

export function GitHubSignInChoice({ signIn }: Readonly<{ signIn: GitHubSignIn }>) {
  return signIn.method === 'app' ? <AppSignIn signIn={signIn} /> : <TokenSignIn signIn={signIn} />
}

/** Above the card's fields while its connections manage the source (githubSignIn.ts `managed`). */
export function ManagedByConnection({ count }: Readonly<{ count: number }>) {
  const { t } = useTranslation('settings')
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-bg-accent p-3" data-testid="github-issues-managed">
      <p className="text-sm text-text">{t('sourceCard.githubSignIn.managed', { count })}</p>
      <p className="text-xs text-muted">{t('sourceCard.githubSignIn.managedHint')}</p>
      <Link to={CONNECTIONS_PATH} className="link text-xs sm:text-sm self-start">{t('sourceCard.githubSignIn.openConnections')}</Link>
    </div>
  )
}
