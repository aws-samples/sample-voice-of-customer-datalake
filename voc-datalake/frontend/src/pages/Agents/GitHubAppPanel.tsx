/**
 * @fileoverview Agents → Connections, "Connect GitHub" (7.45.00): a private GitHub App made from a manifest in two
 * clicks, without copying a key. The administrator picks the account (theirs, or an organization by its login) and
 * **Create the App on GitHub**: the server answers the form github.com's "Create GitHub App" page takes (its address
 * with a single-use state, and the manifest the server wrote), which the page posts as is (the CSP's `form-action`
 * admits github.com for it). GitHub sends them back to GitHubAppCreated.tsx, then, once installed, to
 * GitHubAppInstalled.tsx.
 *
 * Since 7.52.00 (ux-agents-redesign part 1 §2.6) the form is in one of two places: the page's hero while nothing is
 * connected ({@link ConnectGitHubHero}, its button the page's one `btn-primary`), else folded under More ways to connect
 * → Add another GitHub App (MoreWaysToConnect.tsx, a secondary button). Each App with its repositories is AppGroup.tsx.
 *
 * @module pages/Agents/GitHubAppPanel
 */
import { useEffect, useId, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { KeyRound, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import { ORGANIZATION_LOGIN, githubAppsApi } from '../../api/githubAppsApi'
import { useConnectionError } from './connectionText'
import { leavingForGitHub } from './githubReturn'
import { PAGE_WORKSPACE } from '../../workspace/workspacePath'
import { AccountRadios, OrganizationField } from './AccountRadios'
import type { ManifestForm, ManifestRequest } from '../../api/githubAppsApi'

type Account = ManifestRequest['account']

/** The server's form, posted to github.com once it is on the page (never twice: StrictMode runs effects twice). */
function ManifestPost({ form }: Readonly<{ form: ManifestForm }>) {
  const ref = useRef<HTMLFormElement>(null)
  const posted = useRef(false)
  useEffect(() => {
    if (posted.current || ref.current === null) return
    posted.current = true
    leavingForGitHub()
    ref.current.submit()
  }, [form])
  return (
    <form ref={ref} method="post" action={form.actionUrl} hidden data-testid="github-manifest-form">
      <input type="hidden" name="manifest" value={JSON.stringify(form.manifest)} />
    </form>
  )
}

/**
 * The account choice and Create the App on GitHub; `full`: the deployment holds its most Apps (the button waits);
 * `emphasis`: the hero's primary, or a secondary button where another way is the area's main one.
 */
export function CreateApp({ full, emphasis }: Readonly<{ full: boolean; emphasis: 'primary' | 'secondary' }>) {
  const { t } = useTranslation('agents')
  const errorText = useConnectionError()
  const radiosId = useId()
  const [account, setAccount] = useState<Account>('user')
  const [org, setOrg] = useState('')
  const [orgInvalid, setOrgInvalid] = useState(false)
  const manifest = useMutation({ mutationFn: githubAppsApi.manifest })
  const create = () => {
    if (account === 'organization' && !ORGANIZATION_LOGIN.test(org.trim())) {
      setOrgInvalid(true)
      return
    }
    setOrgInvalid(false)
    const workspace = PAGE_WORKSPACE.kind === 'slug' ? { workspace: PAGE_WORKSPACE.slug } : {}
    manifest.mutate(account === 'user' ? { account, ...workspace } : { account, org: org.trim(), ...workspace })
  }
  const busy = manifest.isPending || manifest.isSuccess
  return (
    <>
      <form className="space-y-3" noValidate onSubmit={(event) => { event.preventDefault(); if (!busy) create() }}>
      <AccountRadios legend={t('connections.githubApp.accountLegend')} name={`github-app-account-${radiosId}`}
        labels={{ user: t('connections.githubApp.accountUser'), organization: t('connections.githubApp.accountOrganization') }}
        account={account} onAccount={setAccount} />
      {account === 'organization' && (
        <OrganizationField org={org} invalid={orgInvalid} hint={t('connections.githubApp.orgHint')} onOrg={setOrg} />
      )}
      <button type="submit" className={clsx('btn', emphasis === 'primary' ? 'btn-primary' : 'btn-secondary btn-sm')}
        disabled={full} aria-disabled={busy}>
        {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} {t('connections.githubApp.create')}
      </button>
      {manifest.isError && <p role="alert" className="text-[12px] text-danger">{errorText(manifest.error)}</p>}
      </form>
      {/* (beside the form, never in it: a form inside a form is not HTML) */}
      {manifest.data !== undefined && <ManifestPost form={manifest.data} />}
    </>
  )
}

/** Nothing connected yet (no App, no connection): the page's one card, whose Create the App on GitHub is its primary. */
export function ConnectGitHubHero({ full }: Readonly<{ full: boolean }>) {
  const { t } = useTranslation('agents')
  const titleId = useId()
  return (
    <section className="card p-4 space-y-3" aria-labelledby={titleId} data-testid="connect-github">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-hover text-muted">
          <KeyRound size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0 max-w-prose space-y-1">
          <h3 id={titleId} className="text-base font-semibold text-text-strong">{t('connections.githubApp.title')}</h3>
          <p className="text-sm text-muted">{t('connections.githubApp.intro')}</p>
        </div>
      </div>
      <CreateApp full={full} emphasis="primary" />
    </section>
  )
}
