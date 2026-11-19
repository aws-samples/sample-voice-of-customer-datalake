/**
 * @fileoverview Step 2 of contributing to a public repository (ContributeCard.tsx, 7.57.00): where the fork goes and the
 * licence, then the App's install page.
 *
 * - **Where the fork goes and the licence.** The person's own account (the default), or an organization they
 *   administer (its login); the deployment's GitHub App the fork is installed with, when there are several; and the
 *   upstream's licence, acknowledged by its SPDX id ("I have read the MIT licence and contribute under it": required).
 *   A repository with no licence, or an archived one, is not offered. **Continue** asks the server (`POST
 *   /agents/engineering/connections/<id>/fork`), which reads the upstream again and refuses (409, said in its words)
 *   an archived one, one that opts out of bot pull requests, one with no licence or another licence than the one
 *   acknowledged.
 * - **The App on the fork.** Its answer's install link opens in this tab (the workspace remembered, as every install
 *   link), where the person chooses only their fork; GitHub sends them back to Agents → Connections, which detects the
 *   fork and saves its connection (GitHubAppInstalled.tsx).
 *
 * The upstream is its owner's; the fork and the pull requests are the person's: each run ends with its pull request on
 * the upstream one click away (the person clicks Create on GitHub), or opened for them once they authorized the app.
 *
 * @module pages/Agents/ContributeDialog
 */
import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { engineeringConnectionsApi } from '../../api/engineeringConnectionsApi'
import { ORGANIZATION_LOGIN } from '../../api/githubAppsApi'
import { PAGE_WORKSPACE } from '../../workspace/workspacePath'
import { ConnectionFormModal } from './ConnectionModals'
import { useContributionHeld } from './connectionText'
import { leavingForGitHub } from './githubReturn'
import { AccountRadios } from './AccountRadios'
import type { EngineeringConnection, ForkRequest } from '../../api/engineeringConnectionsApi'
import type { GitHubApp } from '../../api/githubAppsApi'

type Account = ForkRequest['account']

/** The App a fork is installed with by default: the one the public connection reads through, else the first. */
function defaultApp(connection: EngineeringConnection, apps: readonly GitHubApp[]): string {
  const reading = connection.credential.app_id
  return apps.find((app) => app.app_id === reading)?.app_id ?? apps[0]?.app_id ?? ''
}

/** The fork's account: the person's own, or an organization's login. */
function DestinationFields({ account, org, orgInvalid, onAccount, onOrg }: Readonly<{
  account: Account; org: string; orgInvalid: boolean; onAccount: (account: Account) => void; onOrg: (org: string) => void
}>) {
  const { t } = useTranslation('agents')
  const orgId = useId()
  const name = useId()
  return (
    <>
      <AccountRadios legend={t('connections.contribute.destination')} name={name} account={account} onAccount={onAccount}
        labels={{ user: t('connections.contribute.myAccount'), organization: t('connections.contribute.organization') }} />
      {account === 'organization' && (
        <div className="space-y-1">
          <label htmlFor={orgId} className="block text-sm font-medium text-text">{t('connections.githubApp.orgLabel')}</label>
          <input id={orgId} className="input font-mono" value={org} autoComplete="off" spellCheck={false} aria-invalid={orgInvalid}
            onChange={(event) => { onOrg(event.target.value) }} />
          <p className={orgInvalid ? 'text-[12px] text-danger' : 'text-[12px] text-muted'}>
            {orgInvalid ? t('connections.githubApp.orgInvalid') : t('connections.contribute.orgHint')}
          </p>
        </div>
      )}
    </>
  )
}

/** The App choice, only when the deployment has more than one. */
function AppChoice({ apps, appId, onApp }: Readonly<{ apps: readonly GitHubApp[]; appId: string; onApp: (appId: string) => void }>) {
  const { t } = useTranslation('agents')
  const id = useId()
  if (apps.length < 2) return null
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-text">{t('connections.contribute.app')}</label>
      <select id={id} className="input" value={appId} onChange={(event) => { onApp(event.target.value) }}>
        {apps.map((app) => <option key={app.app_id} value={app.app_id}>{app.slug}</option>)}
      </select>
    </div>
  )
}

export function ContributeDialog({ connection, apps, onClose }: Readonly<{
  connection: EngineeringConnection; apps: readonly GitHubApp[]; onClose: () => void
}>) {
  const { t } = useTranslation('agents')
  const licenceId = useId()
  const [account, setAccount] = useState<Account>('user')
  const [org, setOrg] = useState('')
  const [orgInvalid, setOrgInvalid] = useState(false)
  const [appId, setAppId] = useState(() => defaultApp(connection, apps))
  const [acknowledged, setAcknowledged] = useState(false)
  const [unticked, setUnticked] = useState(false)
  const notOffered = useContributionHeld(connection)
  const licence = connection.public?.licence ?? ''
  const fork = useMutation({
    mutationFn: (request: ForkRequest) => engineeringConnectionsApi.fork(connection.connection_id, request),
    // (step 2 of the card: the App's install page, in this tab; GitHub sends the person back to the installed page)
    onSuccess: ({ installUrl }) => { leavingForGitHub(); window.location.assign(installUrl) },
  })
  const submit = () => {
    const badOrg = account === 'organization' && !ORGANIZATION_LOGIN.test(org.trim())
    setOrgInvalid(badOrg)
    setUnticked(!acknowledged)
    if (badOrg || !acknowledged || notOffered !== null) return
    const workspace = PAGE_WORKSPACE.kind === 'slug' ? { workspace: PAGE_WORKSPACE.slug } : {}
    const destination = account === 'user' ? { account } : { account, org: org.trim() }
    fork.mutate({ ...destination, licence, ...(appId === '' ? {} : { app_id: appId }), ...workspace })
  }
  return (
    <ConnectionFormModal title={t('connections.contribute.title', { repository: connection.repository })}
      description={t('connections.contribute.description')} saveLabel={t('connections.contribute.continue')}
      pending={fork.isPending} error={fork.isError ? fork.error : null} onClose={onClose} onSubmit={submit}>
      {notOffered === null ? (
        <>
          <DestinationFields account={account} org={org} orgInvalid={orgInvalid} onAccount={setAccount} onOrg={setOrg} />
          <AppChoice apps={apps} appId={appId} onApp={setAppId} />
          <div className="space-y-1">
            <label className="flex items-start gap-2 text-sm text-text">
              <input type="checkbox" className="mt-1" checked={acknowledged} aria-invalid={unticked} aria-describedby={licenceId}
                onChange={(event) => { setAcknowledged(event.target.checked); setUnticked(false) }} />
              {t('connections.contribute.licence', { licence })}
            </label>
            <p id={licenceId} className={unticked ? 'text-[12px] text-danger' : 'text-[12px] text-muted'}>
              {unticked ? t('connections.contribute.licenceRequired') : t('connections.contribute.licenceHint')}
            </p>
          </div>
        </>
      ) : <p role="status" className="text-sm text-warn">{notOffered}</p>}
    </ConnectionFormModal>
  )
}
