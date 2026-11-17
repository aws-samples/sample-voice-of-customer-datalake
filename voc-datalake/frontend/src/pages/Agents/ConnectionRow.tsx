/**
 * @fileoverview One repository on Agents → Connections (7.52.00, ux-agents-redesign part 1 §2.6 and part 2 S4): a row
 * with the repository and its default branch, its CI chip, its issues switch, its `voc-agent` label, at most one action
 * (connectionStatus.ts `rowPrimary`: Store the key, Replace token, Attest CI or Create label), its details (ⓘ: the ids
 * and the rest, ConnectionDetails.tsx) and its "⋯" menu: Change default branch… (a connection made through the App) or
 * Edit connection… (a pasted key, a GitLab token) · Withdraw CI attestation… or Attest CI… · Remove connection….
 *
 * Desktop (md): one grid row under the list's column header (Repository · CI · Issues · Label), the action and the two
 * icon buttons at the end. Narrow: the repository with ⓘ and ⋯ beside it, then each cell on its own line, and the action
 * full width (`min-h-9`). Keyboard order: the issues switch, the action, ⓘ, ⋯. The action names its repository to a
 * screen reader ("Attest CI example-org/web"). No id is content: the connection id, the App's and the installation's
 * live in the details.
 *
 * @module pages/Agents/ConnectionRow
 */
import { useTranslation } from 'react-i18next'
import { FolderGit2, GitBranch, Loader2, Pencil, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import { RowActionsMenu } from '../../components/RowActionsMenu/RowActionsMenu'
import { isCiAttested } from '../../api/engineeringConnectionsApi'
import { formatCalendarDay } from '../../utils/dateUtils'
import { EXPIRY_WARNING_DAYS, todayUtc, tokenExpiry } from './connectionRules'
import { issuesOf, rowPrimary, viaApp } from './connectionStatus'
import { CiBadge } from './CiAttestation'
import { ConnectionDetails } from './ConnectionDetails'
import { IssuesCell, LabelCell } from './ConnectionIssues'
import type { TFunction } from 'i18next'
import type { RowMenuEntry } from '../../components/RowActionsMenu/rowMenuEntries'
import type { EngineeringConnection } from '../../api/engineeringConnectionsApi'
import type { IssuesSourceView } from '../../api/issuesSourceApi'
import type { RowPrimary } from './connectionStatus'

/** What a row's action, details and menu open (the page owns the dialogs). */
export interface RowActions {
  readonly onEdit: (connection: EngineeringConnection) => void
  readonly onRemove: (connection: EngineeringConnection) => void
  readonly onAttest: (connection: EngineeringConnection) => void
  readonly onWithdraw: (connection: EngineeringConnection) => void
  /** Create the `voc-agent` label again: the check of the App the connection goes through. */
  readonly onCreateLabel: (connection: EngineeringConnection) => void
}

/** The column header's and the row's grid on md (repository · CI · issues · label · action · ⓘ ⋯). */
const ROW_COLUMNS = 'md:grid-cols-[minmax(0,1fr)_9rem_11rem_8rem_auto_auto]'

/** A GitLab token's expiry: its day, a warning within the last `EXPIRY_WARNING_DAYS`, a danger badge once past. */
function TokenExpiryLine({ expiresAt }: Readonly<{ expiresAt: string | null }>) {
  const { t, i18n } = useTranslation('agents')
  const expiry = tokenExpiry(expiresAt, todayUtc())
  if (expiry.state === 'none') return <p className="text-[12px] text-warn">{t('connections.expiry.unknown')}</p>
  const date = formatCalendarDay(expiry.date, i18n.language)
  if (expiry.state === 'ok') return <p className="text-[12px] text-muted">{t('connections.expiry.on', { date })}</p>
  const soon = expiry.state === 'soon'
  return (
    <p className="flex flex-wrap items-center gap-2 text-[12px]">
      <span className={soon ? 'badge badge-warn' : 'badge badge-danger'}>
        {soon ? t('connections.expiry.soonBadge') : t('connections.expiry.expiredBadge')}
      </span>
      <span className={soon ? 'text-warn' : 'text-danger'}>
        {soon ? t('connections.expiry.soon', { date, days: EXPIRY_WARNING_DAYS }) : t('connections.expiry.expired', { date })}
      </span>
    </p>
  )
}

/** The repository cell: its name, its default branch, a missing credential or a GitLab token's expiry. */
function RepositoryCell({ connection }: Readonly<{ connection: EngineeringConnection }>) {
  const { t } = useTranslation('agents')
  const { credential } = connection
  return (
    <div className="col-start-1 row-start-1 flex min-w-0 items-start gap-3 md:col-start-1">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-hover text-muted">
        <FolderGit2 size={16} aria-hidden="true" />
      </span>
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-semibold text-text-strong break-words [overflow-wrap:anywhere]">{connection.repository}</p>
        <p className="flex items-center gap-1 text-[12px] text-muted">
          <GitBranch size={12} aria-hidden="true" /> {t('connections.branch', { branch: connection.default_branch })}
        </p>
        {!credential.set && !viaApp(connection) && <p className="text-[12px] text-warn">{t('connections.notSetHint')}</p>}
        {connection.host === 'gitlab' && credential.set && <TokenExpiryLine expiresAt={credential.expires_at} />}
      </div>
    </div>
  )
}

/** The row's one action, naming its repository to a screen reader; `busy`: its work is on its way. */
function PrimaryAction({ primary, connection, busy, actions }: Readonly<{
  primary: Exclude<RowPrimary, null>; connection: EngineeringConnection; busy: boolean; actions: RowActions
}>) {
  const { t } = useTranslation('agents')
  const run: Record<typeof primary, () => void> = {
    storeKey: () => { actions.onEdit(connection) },
    replaceToken: () => { actions.onEdit(connection) },
    attest: () => { actions.onAttest(connection) },
    createLabel: () => { actions.onCreateLabel(connection) },
  }
  const label: Record<typeof primary, string> = {
    storeKey: t('connections.actions.storeKey'),
    replaceToken: t('connections.actions.replaceToken'),
    attest: t('connections.ci.attest'),
    createLabel: t('connections.actions.createLabel'),
  }
  // (the name starts with the visible verb, WCAG 2.5.3, and names the repository the row is)
  return (
    <button type="button" className="btn btn-secondary btn-sm min-h-9 w-full justify-center md:min-h-0 md:w-auto"
      aria-label={`${label[primary]} ${connection.repository}`} aria-disabled={busy || undefined}
      onClick={() => { if (!busy) run[primary]() }}>
      {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
      {label[primary]}
    </button>
  )
}

/** The row's "⋯": its edit, its CI attestation's other move, and its removal last. */
function menuEntries(connection: EngineeringConnection, primary: RowPrimary, actions: RowActions,
  t: TFunction<'agents'>): RowMenuEntry[] {
  const app = viaApp(connection)
  const entries: RowMenuEntry[] = [{
    kind: 'action', id: 'edit', icon: app ? GitBranch : Pencil,
    label: app ? t('connections.menu.changeBranch') : t('connections.menu.edit'), onSelect: () => { actions.onEdit(connection) },
  }]
  if (isCiAttested(connection)) {
    entries.push({ kind: 'action', id: 'withdraw', icon: ShieldOff, label: t('connections.menu.withdraw'),
      onSelect: () => { actions.onWithdraw(connection) } })
  } else if (primary !== 'attest') {
    entries.push({ kind: 'action', id: 'attest', icon: ShieldCheck, label: t('connections.menu.attest'),
      onSelect: () => { actions.onAttest(connection) } })
  }
  entries.push({ kind: 'separator', id: 'remove-separator' }, {
    kind: 'action', id: 'remove', icon: Trash2, danger: true, label: t('connections.menu.remove'),
    onSelect: () => { actions.onRemove(connection) },
  })
  return entries
}

/**
 * A card's repositories: the column header (md only, `aria-hidden`: each cell names itself) and one row each, in a
 * list named `label` ("Repositories through voc-agents-ac7a4f").
 */
export function RepositoryList({ label, connections, view, actions, labelBusy }: Readonly<{
  label: string
  connections: readonly EngineeringConnection[]
  view: IssuesSourceView | undefined
  actions: RowActions
  /** Whether the check that creates a row's label again is on its way, by the row's connection. */
  labelBusy: (connection: EngineeringConnection) => boolean
}>) {
  const { t } = useTranslation('agents')
  return (
    <div className="border-t border-border">
      <div aria-hidden="true" className={`hidden bg-bg-accent px-4 py-2 text-[11px] font-semibold uppercase tracking-[.04em] text-muted-strong md:grid md:gap-x-4 ${ROW_COLUMNS}`}>
        <span>{t('connections.columns.repository')}</span>
        <span>{t('connections.columns.ci')}</span>
        <span>{t('connections.columns.issues')}</span>
        <span>{t('connections.columns.label')}</span>
      </div>
      {/* (`role="list"`: Safari drops a list's semantics under list-style none) */}
      <ul role="list" aria-label={label} className="divide-y divide-border">
        {connections.map((connection) => (
          <ConnectionRow key={connection.connection_id} connection={connection} view={view} actions={actions}
            labelBusy={labelBusy(connection)} />
        ))}
      </ul>
    </div>
  )
}

function ConnectionRow({ connection, view, actions, labelBusy }: Readonly<{
  connection: EngineeringConnection
  /** The deployment's GitHub Issues source's view, once read. */
  view: IssuesSourceView | undefined
  actions: RowActions
  /** The check that creates the label again is on its way (its App's). */
  labelBusy: boolean
}>) {
  const { t } = useTranslation('agents')
  const issues = issuesOf(view, connection.connection_id)
  const primary = rowPrimary(connection, issues, todayUtc())
  const cell = 'col-span-2 min-w-0 md:col-span-1 md:row-start-1'
  return (
    <li className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 py-3 md:items-center md:gap-x-4 ${ROW_COLUMNS}`}
      data-testid={`connection-row-${connection.connection_id}`}>
      <RepositoryCell connection={connection} />
      <div className={`${cell} md:col-start-2`}><CiBadge connection={connection} /></div>
      <div className={`${cell} md:col-start-3`}><IssuesCell connection={connection} view={view} /></div>
      <div className={`${cell} md:col-start-4`}>
        <span className="sr-only">{t('connections.columns.label')} </span>
        <LabelCell connection={connection} view={view} />
      </div>
      {primary !== null && (
        <div className={`${cell} md:col-start-5`}>
          <PrimaryAction primary={primary} connection={connection} busy={primary === 'createLabel' && labelBusy} actions={actions} />
        </div>
      )}
      <div className="col-start-2 row-start-1 flex items-center gap-1 md:col-start-6">
        <ConnectionDetails connection={connection} issues={issues} labelName={view?.label ?? 'voc-agent'} />
        <RowActionsMenu label={t('connections.menu.label', { repository: connection.repository })}
          entries={menuEntries(connection, primary, actions, t)} />
      </div>
    </li>
  )
}
