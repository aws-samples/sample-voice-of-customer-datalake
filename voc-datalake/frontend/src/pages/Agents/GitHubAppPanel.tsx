/**
 * @fileoverview Agents → Connections, "Connect GitHub" (7.45.00): a private GitHub App made from a manifest in two
 * clicks, without copying a key. The administrator picks the account (theirs, or an organization by its login) and
 * **Create the App on GitHub**: the server answers the form github.com's "Create GitHub App" page takes (its address
 * with a single-use state, and the manifest the server wrote), which the page posts as is (the CSP's `form-action`
 * admits github.com for it). GitHub sends them back to GitHubAppCreated.tsx, then, once installed, to
 * GitHubAppInstalled.tsx.
 *
 * Each of the deployment's Apps is listed with its account, whether it delivers issue events, and how many
 * connections use it ("Not installed" for none), with **Install** / **Install more** (a new install link, opened in
 * this tab), **Check installation** (which connections the installation no longer covers) and **Remove** (its key
 * and webhook secret deleted here; refused while connections use it; the App itself stays on GitHub). Since 7.50.02 a
 * check says what followed for the deployment's GitHub Issues source too (ConnectionIssues.tsx `IssuesFollowLines`).
 *
 * @module pages/Agents/GitHubAppPanel
 */
import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Loader2, Webhook } from 'lucide-react'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { ORGANIZATION_LOGIN, githubAppsApi, githubAppsKeys } from '../../api/githubAppsApi'
import { issuesSourceKeys } from '../../api/issuesSourceApi'
import { formatDateTime } from '../../utils/dateUtils'
import { ConnectionChangeConfirm } from './ConnectionModals'
import { IssuesFollowLines } from './ConnectionIssues'
import { useConnectionError } from './connectionText'
import { leavingForGitHub } from './githubReturn'
import { PAGE_WORKSPACE } from '../../workspace/workspacePath'
import type { UseQueryResult } from '@tanstack/react-query'
import type { GitHubApp, GitHubAppList, InstallationCheck, ManifestForm, ManifestRequest } from '../../api/githubAppsApi'

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

function CreateApp({ full }: Readonly<{ full: boolean }>) {
  const { t } = useTranslation('agents')
  const errorText = useConnectionError()
  const orgId = useId()
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
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium text-text-strong">{t('connections.githubApp.accountLegend')}</legend>
        {(['user', 'organization'] as const).map((choice) => (
          <label key={choice} className="flex items-center gap-2 text-sm text-text">
            <input type="radio" name="github-app-account" value={choice} checked={account === choice}
              onChange={() => { setAccount(choice) }} />
            {choice === 'user' ? t('connections.githubApp.accountUser') : t('connections.githubApp.accountOrganization')}
          </label>
        ))}
      </fieldset>
      {account === 'organization' && (
        <div className="space-y-1">
          <label htmlFor={orgId} className="block text-sm font-medium text-text">{t('connections.githubApp.orgLabel')}</label>
          <input id={orgId} className="input font-mono" value={org} autoComplete="off" spellCheck={false}
            aria-invalid={orgInvalid} onChange={(event) => { setOrg(event.target.value) }} />
          <p className={orgInvalid ? 'text-[12px] text-danger' : 'text-[12px] text-muted'}>
            {orgInvalid ? t('connections.githubApp.orgInvalid') : t('connections.githubApp.orgHint')}
          </p>
        </div>
      )}
      <button type="submit" className="btn btn-primary" disabled={full} aria-disabled={busy}>
        {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} {t('connections.githubApp.create')}
      </button>
      {manifest.isError && <p role="alert" className="text-[12px] text-danger">{errorText(manifest.error)}</p>}
      </form>
      {/* (beside the panel's own form, never in it: a form inside a form is not HTML) */}
      {manifest.data !== undefined && <ManifestPost form={manifest.data} />}
    </>
  )
}

function CheckResult({ app, check }: Readonly<{ app: GitHubApp; check: InstallationCheck }>) {
  const { t } = useTranslation('agents')
  const { repositories, missing } = check
  return (
    <>
      {missing.length === 0
        ? (
            <p role="status" className="text-[12px] text-ok">
              {t('connections.githubApp.checkCovered', { slug: app.slug, repositories: repositories.length })}
            </p>
          )
        : (
            <p role="status" className="text-[12px] text-warn">
              {t('connections.githubApp.checkMissing', { connections: missing.join(', ') })}
            </p>
          )}
      <IssuesFollowLines follow={check.issues} />
    </>
  )
}

function AppFacts({ app }: Readonly<{ app: GitHubApp }>) {
  const { t, i18n } = useTranslation('agents')
  const when = formatDateTime(app.created_at, i18n.language, '')
  const owner = app.owner_type === 'Organization'
    ? t('connections.githubApp.ownerOrganization', { owner: app.owner })
    : t('connections.githubApp.ownerUser', { owner: app.owner })
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <p className="text-sm font-semibold text-text-strong font-mono break-words [overflow-wrap:anywhere]">{app.slug}</p>
      <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
        <span>{owner}</span>
        <span className="inline-flex items-center gap-1">
          <Webhook size={12} aria-hidden="true" />
          {app.webhook ? t('connections.githubApp.webhookOn') : t('connections.githubApp.webhookOff')}
        </span>
        {app.connections.length === 0
          ? <span className="badge badge-warn">{t('connections.githubApp.notInstalled')}</span>
          : <span className="badge badge-muted">{t('connections.githubApp.connections', { count: app.connections.length })}</span>}
        {app.html_url !== '' && (
          <a href={app.html_url} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1">
            <ExternalLink size={12} aria-hidden="true" /> {t('connections.githubApp.openOnGitHub', { slug: app.slug })}
          </a>
        )}
      </p>
      {when !== '' && (
        <p className="text-[12px] text-muted">
          {t('connections.githubApp.created', { when, who: app.created_by ?? t('connections.unknownEditor') })}
        </p>
      )}
    </div>
  )
}

function AppRow({ app, onNotice }: Readonly<{ app: GitHubApp; onNotice: (text: string) => void }>) {
  const { t } = useTranslation('agents')
  const errorText = useConnectionError()
  const queryClient = useQueryClient()
  const [removing, setRemoving] = useState(false)
  const install = useMutation({
    mutationFn: () => githubAppsApi.install(app.app_id),
    onSuccess: ({ installUrl }) => { leavingForGitHub(); window.location.assign(installUrl) },
  })
  // A check records the slug GitHub reports (a rename on GitHub, github_apps.py `check`): the row reads it again; and
  // it brings the App's repositories into the GitHub Issues source (7.50.02): its view is read again too.
  const check = useMutation({
    mutationFn: () => githubAppsApi.check(app.app_id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: githubAppsKeys.list() })
      void queryClient.invalidateQueries({ queryKey: issuesSourceKeys.view() })
    },
  })
  const installed = app.connections.length > 0
  const failed = install.isError ? install.error : check.error
  return (
    <li className="card p-4 space-y-2">
      <div className="flex flex-wrap items-start gap-3">
        <AppFacts app={app} />
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" className="btn btn-secondary" aria-disabled={install.isPending}
            aria-label={t('connections.githubApp.installLabel', { slug: app.slug })}
            onClick={() => { if (!install.isPending) install.mutate() }}>
            {installed ? t('connections.githubApp.installMore') : t('connections.githubApp.install')}
          </button>
          {installed && (
            <button type="button" className="btn btn-secondary" aria-disabled={check.isPending}
              aria-label={t('connections.githubApp.checkLabel', { slug: app.slug })}
              onClick={() => { if (!check.isPending) check.mutate() }}>
              {t('connections.githubApp.check')}
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={() => { setRemoving(true) }}
            aria-label={t('connections.githubApp.removeLabel', { slug: app.slug })}>{t('connections.githubApp.remove')}</button>
        </div>
      </div>
      {check.data !== undefined && <CheckResult app={app} check={check.data} />}
      {failed !== null && <p role="alert" className="text-[12px] text-danger">{errorText(failed)}</p>}
      {removing && (
        <ConnectionChangeConfirm variant="danger" title={t('connections.githubApp.removeTitle', { slug: app.slug })}
          message={t('connections.githubApp.removeMessage')} confirmLabel={t('connections.githubApp.removeConfirm')}
          change={() => githubAppsApi.remove(app.app_id)} onCancel={() => { setRemoving(false) }}
          onDone={() => {
            setRemoving(false)
            void queryClient.invalidateQueries({ queryKey: githubAppsKeys.list() })
            onNotice(t('connections.githubApp.removed', { slug: app.slug }))
          }} />
      )}
    </li>
  )
}

/** The "Connect GitHub" panel, over the deployment's Apps as `read` holds them (the page's one read of the list). */
export function GitHubAppPanel({ read, onNotice }: Readonly<{
  read: UseQueryResult<GitHubAppList>; onNotice: (text: string) => void
}>) {
  const { t } = useTranslation('agents')
  const titleId = useId()
  const list = read.data
  const full = list === undefined || list.apps.length >= list.limit
  return (
    <section className="card p-4 space-y-3" aria-labelledby={titleId}>
      <div className="max-w-prose space-y-1">
        <h3 id={titleId} className="text-base font-semibold text-text-strong">{t('connections.githubApp.title')}</h3>
        <p className="text-sm text-muted">{t('connections.githubApp.intro')}</p>
      </div>
      <CreateApp full={full} />
      {list !== undefined && list.apps.length >= list.limit && (
        <p className="text-[12px] text-muted">{t('connections.githubApp.limitReached', { limit: list.limit })}</p>
      )}
      {read.isPending && <div className="skeleton h-16" />}
      {list === undefined && read.isError && (
        <LoadFailed message={t('connections.githubApp.loadFailed')} onRetry={() => { void read.refetch() }} retrying={read.isFetching} />
      )}
      {list !== undefined && list.apps.length > 0 && (
        <ul className="space-y-2" aria-label={t('connections.githubApp.listLabel')}>
          {list.apps.map((app) => <AppRow key={app.app_id} app={app} onNotice={onNotice} />)}
        </ul>
      )}
    </section>
  )
}
