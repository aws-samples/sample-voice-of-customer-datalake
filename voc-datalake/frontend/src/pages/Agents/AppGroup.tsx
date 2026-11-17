/**
 * @fileoverview One of the deployment's GitHub Apps on Agents → Connections (7.52.00, ux-agents-redesign part 1 §2.6):
 * a card whose header row is the App (its slug, its account, whether it sends issue events here, "Checked …" after a
 * check made in this session, and Installed · N repositories or Not installed), then its repositories as rows
 * (ConnectionRow.tsx). The connections an App's installation saved are the App's children; nothing else is nested.
 *
 * The header's one action (connectionStatus.ts `appPrimary`): **Install on GitHub** while it is installed nowhere;
 * **Reinstall on GitHub** in a warn banner when a check finds repositories it no longer covers; else **Add
 * repositories** (a new install link, opened in this tab). Its "⋯": Open <slug> on GitHub ↗ · Check installation
 * (installed only) · Remove App… (its key and webhook secret deleted here, refused while connections use it; the App
 * stays on GitHub). A check says what it found and what followed for the GitHub Issues source (ConnectionIssues.tsx
 * `IssuesFollowLines`).
 *
 * @module pages/Agents/AppGroup
 */
import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CircleCheck, ExternalLink, KeyRound, RefreshCw, Trash2, Webhook } from 'lucide-react'
import { IconBadge } from '../../components/IconBadge/IconBadge'
import Notice from '../../components/Notice/Notice'
import { RowActionsMenu } from '../../components/RowActionsMenu/RowActionsMenu'
import { githubAppsApi, githubAppsKeys } from '../../api/githubAppsApi'
import { formatRelativeDate } from '../../utils/dateUtils'
import { ConnectionChangeConfirm } from './ConnectionModals'
import { IssuesFollowLines } from './ConnectionIssues'
import { RepositoryList } from './ConnectionRow'
import { appPrimary } from './connectionStatus'
import { useConnectionError } from './connectionText'
import { leavingForGitHub } from './githubReturn'
import type { RowMenuEntry } from '../../components/RowActionsMenu/rowMenuEntries'
import type { GitHubApp, InstallationCheck } from '../../api/githubAppsApi'
import type { IssuesSourceView } from '../../api/issuesSourceApi'
import type { AppGroupOf, AppPrimary } from './connectionStatus'
import type { RowActions } from './ConnectionRow'
import type { AppCheckRecord } from './useAppChecks'

/** What a check found: every connection covered (a status line; repositories no longer covered are the banner's). */
function CheckResult({ app, check }: Readonly<{ app: GitHubApp; check: InstallationCheck }>) {
  const { t } = useTranslation('agents')
  return (
    <>
      {check.missing.length === 0 && (
        <p role="status" className="text-[12px] text-ok">
          {t('connections.githubApp.checkCovered', { slug: app.slug, repositories: check.repositories.length })}
        </p>
      )}
      <IssuesFollowLines follow={check.issues} />
    </>
  )
}

/** The App's account, whether it sends issue events here, and when it was checked in this session. */
function AppMeta({ app, checkedAt }: Readonly<{ app: GitHubApp; checkedAt: string | null }>) {
  const { t, i18n } = useTranslation('agents')
  const owner = app.owner_type === 'Organization'
    ? t('connections.githubApp.ownerOrganization', { owner: app.owner })
    : t('connections.githubApp.ownerUser', { owner: app.owner })
  const checked = checkedAt === null ? '' : formatRelativeDate(checkedAt, i18n.language)
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
      <span>{owner}</span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1">
        <Webhook size={12} aria-hidden="true" />
        {app.webhook ? t('connections.githubApp.webhookOn') : t('connections.githubApp.webhookOff')}
      </span>
      {checked !== '' && (
        <>
          <span aria-hidden="true">·</span>
          <span>{t('connections.githubApp.checked', { when: checked })}</span>
        </>
      )}
    </p>
  )
}

/** The App's "⋯": its page on GitHub, its check (installed only), and its removal last. */
function appMenu(app: GitHubApp, labels: Readonly<{ open: string; check: string; remove: string }>,
  on: Readonly<{ check: () => void; remove: () => void }>): RowMenuEntry[] {
  const entries: RowMenuEntry[] = []
  if (app.html_url !== '') {
    entries.push({ kind: 'action', id: 'open', icon: ExternalLink, label: labels.open,
      onSelect: () => { window.open(app.html_url, '_blank', 'noopener,noreferrer') } })
  }
  if (app.connections.length > 0) entries.push({ kind: 'action', id: 'check', icon: RefreshCw, label: labels.check, onSelect: on.check })
  entries.push({ kind: 'separator', id: 'remove-separator' },
    { kind: 'action', id: 'remove', icon: Trash2, danger: true, label: labels.remove, onSelect: on.remove })
  return entries
}

export function AppGroup({ group, view, record, checking, actions, onCheck, onNotice }: Readonly<{
  group: AppGroupOf
  /** The deployment's GitHub Issues source's view, once read. */
  view: IssuesSourceView | undefined
  /** The App's last check of this session, if any. */
  record: AppCheckRecord | undefined
  /** Its check is on its way. */
  checking: boolean
  actions: RowActions
  onCheck: () => void
  onNotice: (text: string) => void
}>) {
  const { t } = useTranslation('agents')
  const titleId = useId()
  const [removing, setRemoving] = useState(false)
  const { app, connections } = group
  const install = useMutation({
    mutationFn: () => githubAppsApi.install(app.app_id),
    onSuccess: ({ installUrl }) => { leavingForGitHub(); window.location.assign(installUrl) },
  })
  const startInstall = () => { if (!install.isPending) install.mutate() }
  const result = record?.result ?? null
  const menu = appMenu(app, {
    open: t('connections.githubApp.openOnGitHub', { slug: app.slug }), check: t('connections.githubApp.check'),
    remove: t('connections.githubApp.removeApp'),
  }, { check: onCheck, remove: () => { setRemoving(true) } })
  return (
    <section className="card p-0 overflow-hidden" aria-labelledby={titleId} data-testid={`app-group-${app.app_id}`}>
      <AppHeader app={app} titleId={titleId} checkedAt={record?.at ?? null} primary={appPrimary(app, result)}
        installing={install.isPending} onInstall={startInstall} menu={menu} />
      <AppCheckLines app={app} result={result} checking={checking} installing={install.isPending} onInstall={startInstall}
        failed={install.isError ? install.error : record?.error ?? null} />
      {connections.length > 0 && (
        <RepositoryList label={t('connections.githubApp.repositoriesLabel', { slug: app.slug })} connections={connections}
          view={view} actions={actions} labelBusy={() => checking} />
      )}
      {removing && <RemoveApp app={app} onClose={() => { setRemoving(false) }} onNotice={onNotice} />}
    </section>
  )
}

/** The App's header row: its tile, slug, account and state, its one button and its "⋯". */
function AppHeader({ app, titleId, checkedAt, primary, installing, onInstall, menu }: Readonly<{
  app: GitHubApp; titleId: string; checkedAt: string | null; primary: AppPrimary; installing: boolean
  onInstall: () => void; menu: readonly RowMenuEntry[]
}>) {
  const { t } = useTranslation('agents')
  const installed = app.connections.length > 0
  const verb = primary === 'install' ? t('connections.githubApp.installOnGitHub') : t('connections.githubApp.addRepositories')
  return (
    <div className="flex flex-wrap items-start gap-3 px-4 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-hover text-muted">
        <KeyRound size={16} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <h3 id={titleId} className="text-sm font-semibold text-text-strong break-words [overflow-wrap:anywhere]">{app.slug}</h3>
        <AppMeta app={app} checkedAt={checkedAt} />
        <p className="tabular-nums">
          {installed
            ? <IconBadge toneClass="badge-ok" icon={CircleCheck}>{t('connections.githubApp.installed', { count: app.connections.length })}</IconBadge>
            : <IconBadge toneClass="badge-warn" icon={AlertTriangle}>{t('connections.githubApp.notInstalled')}</IconBadge>}
        </p>
      </div>
      <div className="flex w-full items-center gap-1 sm:w-auto">
        {/* Install on GitHub while installed nowhere, else Add repositories: the same new install link. */}
        <button type="button" className="btn btn-secondary btn-sm min-h-9 flex-1 justify-center sm:min-h-0 sm:flex-none"
          aria-label={`${verb} ${app.slug}`} aria-disabled={installing || undefined} onClick={onInstall}>
          {verb}
        </button>
        <RowActionsMenu label={t('connections.githubApp.menuLabel', { slug: app.slug })} entries={menu} />
      </div>
    </div>
  )
}

/** Under the header: a check on its way, what the last one found (Reinstall on GitHub when it found gaps), a refusal. */
function AppCheckLines({ app, result, checking, installing, onInstall, failed }: Readonly<{
  app: GitHubApp; result: InstallationCheck | null; checking: boolean; installing: boolean; onInstall: () => void
  /** The install link's or the last check's refusal; null for none. */
  failed: unknown
}>) {
  const { t } = useTranslation('agents')
  const errorText = useConnectionError()
  const reinstall = appPrimary(app, result) === 'reinstall'
  if (!checking && result === null && failed === null) return null
  return (
    <div className="space-y-2 px-4 pb-3">
      {checking && <p role="status" className="text-[12px] text-muted">{t('connections.githubApp.checking')}</p>}
      {reinstall && result !== null && (
        <Notice variant="banner" tone="warn" icon={AlertTriangle} role="status"
          text={t('connections.githubApp.checkMissing', { connections: result.missing.join(', ') })}
          action={{ label: t('connections.githubApp.reinstall'), onClick: onInstall, busy: installing }} />
      )}
      {result !== null && <CheckResult app={app} check={result} />}
      {failed !== null && <p role="alert" className="text-[12px] text-danger">{errorText(failed)}</p>}
    </div>
  )
}

/** Remove App…: its key and webhook secret deleted here after a confirmation (the server refuses while it is used). */
function RemoveApp({ app, onClose, onNotice }: Readonly<{ app: GitHubApp; onClose: () => void; onNotice: (text: string) => void }>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  return (
    <ConnectionChangeConfirm variant="danger" title={t('connections.githubApp.removeTitle', { slug: app.slug })}
      message={t('connections.githubApp.removeMessage')} confirmLabel={t('connections.githubApp.removeConfirm')}
      change={() => githubAppsApi.remove(app.app_id)} onCancel={onClose}
      onDone={() => {
        onClose()
        void queryClient.invalidateQueries({ queryKey: githubAppsKeys.list() })
        onNotice(t('connections.githubApp.removed', { slug: app.slug }))
      }} />
  )
}
