/**
 * @fileoverview Agent orchestration → Connections (administrators, while the engineering agents are on; 7.52.00,
 * ux-agents-redesign part 1 §2.6 and part 2 S4): the repository connections the engineering agents reach a repository
 * through (`GET /agents/engineering/connections`), under the deployment's GitHub Apps (`GET …/github-apps`) and the
 * GitHub Issues source that reads their issues (`GET …/issues-source`, 7.50.02).
 *
 * - **The header:** "Repository connections", one line on what they are, and **Check now** (secondary, once an App is
 *   installed: every installed App's check), then the status line (ConnectionsStatus.tsx: "Connected" or "Needs
 *   attention", how many repositories go through which App, how many need their CI attested, "Issues read
 *   automatically" while the source reads one).
 * - **Nothing connected** (no App, no connection): one card, Connect GitHub, whose Create the App on GitHub is the
 *   page's one primary button (GitHubAppPanel.tsx).
 * - **Connected:** one card per GitHub App (AppGroup.tsx), its repositories as rows (ConnectionRow.tsx); the
 *   connections outside every App (a pasted App key, a GitLab token, one whose App is no longer listed) under "Other
 *   connections" with the same rows. Each row has at most one action (connectionStatus.ts), its details (ⓘ) and its
 *   "⋯" (edit, the CI attestation's other move, remove).
 * - **Public repositories** (7.57.00, PublicRepositories.tsx), once an App is there to read with: the read-only
 *   connections to public repositories in a card of their own (each with its guided Contribute to ‹upstream›), and
 *   Add a public repository (search GitHub, Connect read-only).
 * - **More ways to connect**, folded (MoreWaysToConnect.tsx): another GitHub App, a connection made by hand, GitLab.
 *
 * One dialog at a time over the page: adding or editing a connection (ConnectionDialog.tsx: an empty key keeps the
 * stored credential), removing one after a confirmation that says live runs on it lose access within five minutes,
 * attesting or withdrawing its CI (CiAttestation.tsx). What a change did is said once in a polite status line.
 *
 * @module pages/Agents/EngineeringConnections
 */
import { useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw } from 'lucide-react'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { githubAppsApi, githubAppsKeys } from '../../api/githubAppsApi'
import { issuesSourceApi, issuesSourceKeys } from '../../api/issuesSourceApi'
import { useConfigStore } from '../../store/configStore'
import { todayUtc } from './connectionRules'
import { connectionsSummary, groupConnections } from './connectionStatus'
import { AttestDialog, WithdrawConfirm } from './CiAttestation'
import { ConnectionDialog } from './ConnectionDialog'
import { ConnectionChangeConfirm } from './ConnectionModals'
import { ConnectionsStatus } from './ConnectionsStatus'
import { RepositoryList } from './ConnectionRow'
import { AppGroup } from './AppGroup'
import { ConnectGitHubHero } from './GitHubAppPanel'
import { MoreWaysToConnect } from './MoreWaysToConnect'
import { PublicConnections, PublicRepositoryPicker } from './PublicRepositories'
import { useAppChecks } from './useAppChecks'
import type { UseQueryResult } from '@tanstack/react-query'
import type {
  ConnectionHost, ConnectionList, EngineeringConnection, SavedConnection,
} from '../../api/engineeringConnectionsApi'
import type { GitHubAppList } from '../../api/githubAppsApi'
import type { IssuesSourceView } from '../../api/issuesSourceApi'
import type { RowActions } from './ConnectionRow'
import type { ConnectionsSummary } from './connectionStatus'
import type { AppChecks } from './useAppChecks'

/** The dialog open: adding (on a host) or editing a connection, removing it, or attesting or withdrawing its CI. */
type Open =
  | { kind: 'add'; host: ConnectionHost }
  | { kind: 'edit' | 'remove' | 'attest' | 'withdraw'; connection: EngineeringConnection }
  | null

function RemoveConfirm({ connection, onDone, onCancel }: Readonly<{
  connection: EngineeringConnection; onDone: () => void; onCancel: () => void
}>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const { repository } = connection
  const without = (list: ConnectionList): ConnectionList =>
    ({ ...list, connections: list.connections.filter((c) => c.connection_id !== connection.connection_id) })
  // (its repository leaves the GitHub Issues source when its connection had added it: the view is read again)
  const removed = () => {
    void queryClient.invalidateQueries({ queryKey: issuesSourceKeys.view() })
    onDone()
  }
  return (
    <ConnectionChangeConfirm variant="danger" title={t('connections.confirm.title', { repository })}
      message={t('connections.confirm.message', { repository })} confirmLabel={t('connections.confirm.confirm')}
      change={() => engineeringConnectionsApi.remove(connection.connection_id)} update={without}
      onDone={removed} onCancel={onCancel} />
  )
}

/** The one dialog open over the page, with the connection it is for. */
function OpenDialog({ open, onClose, onNotice }: Readonly<{
  open: Exclude<Open, null>; onClose: () => void; onNotice: (text: string) => void
}>) {
  const { t } = useTranslation('agents')
  const done = (key: string, repository: string) => {
    onNotice(t(key, { repository }))
    onClose()
  }
  const saved = ({ connection, created }: SavedConnection) => {
    done(created ? 'connections.created' : 'connections.saved', connection.repository)
  }
  if (open.kind === 'add') return <ConnectionDialog existing={null} presetHost={open.host} onClose={onClose} onSaved={saved} />
  const { connection } = open
  const { repository } = connection
  if (open.kind === 'edit') return <ConnectionDialog existing={connection} onClose={onClose} onSaved={saved} />
  if (open.kind === 'remove') {
    return <RemoveConfirm connection={connection} onCancel={onClose} onDone={() => done('connections.removed', repository)} />
  }
  if (open.kind === 'attest') {
    return <AttestDialog connection={connection} onClose={onClose} onRecorded={() => done('connections.ci.recorded', repository)} />
  }
  return <WithdrawConfirm connection={connection} onCancel={onClose} onDone={() => done('connections.ci.withdrawn', repository)} />
}

/** The page's three reads: the connections, the deployment's Apps and the GitHub Issues source's view. */
function useConnectionReads() {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const connections = useQuery({ queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list, enabled: configured })
  const apps = useQuery({ queryKey: githubAppsKeys.list(), queryFn: githubAppsApi.list, enabled: configured })
  // (the deployment's: sent without a workspace header; a failed read shows no issues column, never a made-up one)
  const issues = useQuery({ queryKey: issuesSourceKeys.view(), queryFn: issuesSourceApi.get, enabled: configured, retry: false })
  return { configured, connections, apps, issues: issues.data }
}

/** Connections outside every listed App: a pasted key's, a GitLab token's, or one whose App is gone. */
function OtherConnections({ connections, view, actions }: Readonly<{
  connections: readonly EngineeringConnection[]; view: IssuesSourceView | undefined; actions: RowActions
}>) {
  const { t } = useTranslation('agents')
  const titleId = useId()
  return (
    <section className="card p-0 overflow-hidden" aria-labelledby={titleId}>
      <div className="px-4 py-3">
        <h3 id={titleId} className="text-sm font-semibold text-text-strong">{t('connections.others.title')}</h3>
        <p className="text-[12px] text-muted">{t('connections.others.hint')}</p>
      </div>
      <RepositoryList label={t('connections.others.title')} connections={connections} view={view} actions={actions}
        labelBusy={() => false} />
    </section>
  )
}

/** The Apps, each with its repositories, then the other connections; or the Apps' failed read. */
function ConnectedBody({ list, apps, view, checks, actions, onNotice }: Readonly<{
  list: ConnectionList
  apps: UseQueryResult<GitHubAppList>
  view: IssuesSourceView | undefined
  checks: AppChecks
  actions: RowActions
  onNotice: (text: string) => void
}>) {
  const { t } = useTranslation('agents')
  // (while the Apps are read, nothing is grouped: a connection made through one would show among the others)
  if (apps.isPending) return <div className="skeleton h-16" />
  const groups = groupConnections(list.connections, apps.data?.apps ?? [])
  return (
    <>
      {apps.data === undefined && (
        <LoadFailed message={t('connections.githubApp.loadFailed')} onRetry={() => { void apps.refetch() }} retrying={apps.isFetching} />
      )}
      {groups.apps.length > 0 && (
        <ul className="space-y-4" aria-label={t('connections.githubApp.listLabel')}>
          {groups.apps.map((group) => (
            <li key={group.app.app_id}>
              <AppGroup group={group} view={view} record={checks.records.get(group.app.app_id)}
                checking={checks.running.has(group.app.app_id)} actions={actions} onNotice={onNotice}
                onCheck={() => { void checks.check(group.app.app_id) }} />
            </li>
          ))}
        </ul>
      )}
      {groups.others.length > 0 && <OtherConnections connections={groups.others} view={view} actions={actions} />}
      {groups.publicRead.length > 0 && (
        <PublicConnections connections={groups.publicRead} all={list.connections} apps={apps.data?.apps ?? []} view={view}
          onRemove={actions.onRemove} />
      )}
    </>
  )
}

/** Check now: every installed App's check, at once (secondary: the page's primary is none once connected). */
function CheckNow({ appIds, checks }: Readonly<{ appIds: readonly string[]; checks: AppChecks }>) {
  const { t } = useTranslation('agents')
  const busy = appIds.some((appId) => checks.running.has(appId))
  return (
    <button type="button" className="btn btn-secondary btn-sm" aria-disabled={busy || undefined}
      onClick={() => { if (!busy) void checks.checkAll(appIds) }}>
      {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
      {t('connections.checkNow')}
    </button>
  )
}

/** What the rows' actions open; Create label runs the check of the App the connection goes through. */
function rowActions(checks: AppChecks, open: (next: Exclude<Open, null>) => void): RowActions {
  const opener = (kind: 'edit' | 'remove' | 'attest' | 'withdraw') => (connection: EngineeringConnection) => {
    open({ kind, connection })
  }
  return {
    onEdit: opener('edit'), onRemove: opener('remove'), onAttest: opener('attest'), onWithdraw: opener('withdraw'),
    onCreateLabel: (connection) => {
      const appId = connection.credential.app_id
      if (appId !== null) void checks.check(appId)
    },
  }
}

/** The status line's facts once the connections and the Apps are read; null before. */
function summaryOf(list: ConnectionList | undefined, apps: GitHubAppList | undefined, issues: IssuesSourceView | undefined,
  checks: AppChecks): ConnectionsSummary | null {
  if (list === undefined || apps === undefined) return null
  return connectionsSummary({ connections: list.connections, apps: apps.apps, issues, checks: checks.results, today: todayUtc() })
}

/** "Repository connections", what they are, and Check now once an App is installed. */
function PageHeader({ apps, checks }: Readonly<{ apps: GitHubAppList | undefined; checks: AppChecks }>) {
  const { t } = useTranslation('agents')
  const installed = (apps?.apps ?? []).filter((app) => app.connections.length > 0).map((app) => app.app_id)
  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="mr-auto min-w-0 max-w-prose space-y-1">
        <h2 className="text-lg font-semibold text-text-strong">{t('connections.title')}</h2>
        <p className="text-sm text-muted">{t('connections.intro')}</p>
      </div>
      {installed.length > 0 && <CheckNow appIds={installed} checks={checks} />}
    </div>
  )
}

/** The connections' read while it loads, or its failure with Try again. */
function ListState({ read, configured }: Readonly<{ read: UseQueryResult<ConnectionList>; configured: boolean }>) {
  const { t } = useTranslation('agents')
  if (read.isPending && configured) return <div className="skeleton h-24" />
  if (read.data !== undefined || !read.isError) return null
  return <LoadFailed message={t('connections.loadFailed')} onRetry={() => { void read.refetch() }} retrying={read.isFetching} />
}

/** Nothing connected: the hero; else the Apps and the other connections. More ways to connect under either. */
function PageBody({ list, summary, apps, view, checks, actions, onNotice, onAdd }: Readonly<{
  list: ConnectionList
  summary: ConnectionsSummary | null
  apps: UseQueryResult<GitHubAppList>
  view: IssuesSourceView | undefined
  checks: AppChecks
  actions: RowActions
  onNotice: (text: string) => void
  onAdd: (host: ConnectionHost) => void
}>) {
  const appList = apps.data
  const appsFull = appList === undefined || appList.apps.length >= appList.limit
  const empty = summary?.empty === true
  const connectionsFull = list.connections.length >= list.limit
  return (
    <>
      {empty
        ? <ConnectGitHubHero full={appsFull} />
        : <ConnectedBody list={list} apps={apps} view={view} checks={checks} actions={actions} onNotice={onNotice} />}
      {/* (7.57.00: any public repository, read with the deployment's App, so once there is one) */}
      {(appList?.apps.length ?? 0) > 0 && <PublicRepositoryPicker full={connectionsFull} onNotice={onNotice} />}
      <MoreWaysToConnect anotherApp={!empty} appsFull={appsFull} appLimit={appList?.limit ?? null}
        connectionsFull={connectionsFull} connectionLimit={list.limit} onAdd={onAdd} />
    </>
  )
}

export function EngineeringConnections() {
  const reads = useConnectionReads()
  const checks = useAppChecks()
  const [open, setOpen] = useState<Open>(null)
  const [notice, setNotice] = useState('')
  const show = (next: Exclude<Open, null>) => {
    setNotice('')
    setOpen(next)
  }
  const list = reads.connections.data
  const summary = summaryOf(list, reads.apps.data, reads.issues, checks)
  return (
    <div className="space-y-4">
      <PageHeader apps={reads.apps.data} checks={checks} />
      {summary !== null && <ConnectionsStatus summary={summary} />}
      <p role="status" className="text-[12px] text-ok">{notice}</p>
      <ListState read={reads.connections} configured={reads.configured} />
      {list !== undefined && (
        <PageBody list={list} summary={summary} apps={reads.apps} view={reads.issues} checks={checks}
          actions={rowActions(checks, show)} onNotice={setNotice} onAdd={(host) => { show({ kind: 'add', host }) }} />
      )}
      {open !== null && <OpenDialog open={open} onClose={() => setOpen(null)} onNotice={setNotice} />}
    </div>
  )
}
