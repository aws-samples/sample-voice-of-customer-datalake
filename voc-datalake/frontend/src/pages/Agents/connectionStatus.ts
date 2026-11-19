/**
 * @fileoverview Agents → Connections as a state (7.52.00, ux-agents-redesign part 1 §2.6 and part 2 S4), pure: how the
 * connections group under the deployment's GitHub Apps, each repository row's one primary action, each App's, and the
 * page's status line. The table "One primary per state" in order, the first that matches wins:
 *
 * | State | Primary | Where |
 * |---|---|---|
 * | No App, no connection | Create the App on GitHub | the hero (the page's one `btn-primary`) |
 * | App made, not installed | Install on GitHub | the App's header |
 * | A check finds repositories no longer covered | Reinstall on GitHub | the App's header (a warn banner) |
 * | Credential missing | Store the key | the row (its Edit dialog) |
 * | GitLab token expired or expiring | Replace token | the row (its Edit dialog) |
 * | CI not attested | Attest CI | the row |
 * | The `voc-agent` label couldn't be created (7.50.02) | Create label | the row (the App's check tries again) |
 * | All healthy | none: Check now (secondary) in the header refreshes every App | — |
 *
 * A connection made through one of the deployment's Apps (`app_reference`) has no key of its own (the App's is stored
 * once): its missing credential is the App's to fix, never "Store the key" on the row.
 *
 * Since 7.57.00 a read-only public repository (`public_read`) is in a card of its own (PublicRepositories.tsx): nothing
 * is written to it, so it has no CI to attest and no row primary; a fork connection (`fork`, the App installed on a
 * person's fork) is a row of its App like any other, its CI attested before the agents push to the fork.
 *
 * @module pages/Agents/connectionStatus
 */
import { isCiAttested, isPublicRead } from '../../api/engineeringConnectionsApi'
import { tokenExpiry } from './connectionRules'
import type { EngineeringConnection } from '../../api/engineeringConnectionsApi'
import type { GitHubApp, InstallationCheck } from '../../api/githubAppsApi'
import type { ConnectionIssues, IssuesSourceView } from '../../api/issuesSourceApi'

/** A repository row's one action, or none (healthy). */
export type RowPrimary = 'storeKey' | 'replaceToken' | 'attest' | 'createLabel' | null

/** An App header's one action, or none. */
export type AppPrimary = 'install' | 'reinstall' | null

/** One App and the connections made through it, in the list's order. */
export interface AppGroupOf {
  readonly app: GitHubApp
  readonly connections: readonly EngineeringConnection[]
}

/** The page's connections as its cards show them. */
export interface ConnectionGroups {
  readonly apps: readonly AppGroupOf[]
  /** A pasted App key's, a GitLab token's, or one made through an App this deployment no longer lists. */
  readonly others: readonly EngineeringConnection[]
  /** (7.57.00) The public repositories read only, whatever App reads them. */
  readonly publicRead: readonly EngineeringConnection[]
}

/** A connection made through one of the deployment's GitHub Apps: its key is the App's, its issues follow it. */
export const viaApp = (connection: EngineeringConnection): boolean =>
  connection.host === 'github' && connection.credential.kind === 'app_reference'

/** Each App with the connections made through it (by the App's id), and every other connection apart. */
export function groupConnections(connections: readonly EngineeringConnection[], apps: readonly GitHubApp[]): ConnectionGroups {
  const listed = new Set(apps.map((app) => app.app_id))
  const ownApp = (connection: EngineeringConnection): string | null =>
    viaApp(connection) && connection.credential.app_id !== null && listed.has(connection.credential.app_id)
      ? connection.credential.app_id : null
  const written = connections.filter((connection) => !isPublicRead(connection))
  return {
    apps: apps.map((app) => ({ app, connections: written.filter((connection) => ownApp(connection) === app.app_id) })),
    others: written.filter((connection) => ownApp(connection) === null),
    publicRead: connections.filter(isPublicRead),
  }
}

/** The view's word on one connection's issues, when it names it. */
export function issuesOf(view: IssuesSourceView | undefined, connectionId: string): ConnectionIssues | undefined {
  return view?.connections.find((entry) => entry.connection_id === connectionId)
}

/** The row's one primary (the module's table, repository rows), as of `today` (`YYYY-MM-DD`, UTC). */
export function rowPrimary(connection: EngineeringConnection, issues: ConnectionIssues | undefined, today: string): RowPrimary {
  if (isPublicRead(connection)) return null
  if (!connection.credential.set && !viaApp(connection)) return 'storeKey'
  if (connection.host === 'gitlab' && connection.credential.set) {
    const expiry = tokenExpiry(connection.credential.expires_at, today)
    if (expiry.state === 'soon' || expiry.state === 'expired') return 'replaceToken'
  }
  if (!isCiAttested(connection)) return 'attest'
  if (viaApp(connection) && issues?.label === 'failed') return 'createLabel'
  return null
}

/** The App's one primary: installed nowhere yet, or a check this session found repositories it no longer covers. */
export function appPrimary(app: GitHubApp, check: InstallationCheck | null | undefined): AppPrimary {
  if (app.connections.length === 0) return 'install'
  return (check?.missing.length ?? 0) > 0 ? 'reinstall' : null
}

/** The status line's facts: whether anything waits for an administrator, and what the line says. */
export interface ConnectionsSummary {
  /** Nothing connected: no App and no connection (the hero shows instead of a status line). */
  readonly empty: boolean
  /** A row or an App has a primary action: the line's chip says "Needs attention". */
  readonly attention: boolean
  /** Each App with connections: how many repositories go through it. */
  readonly through: readonly { readonly slug: string; readonly count: number }[]
  /** Connections outside every listed App. */
  readonly others: number
  /** (7.57.00) Public repositories read only. */
  readonly publicRead: number
  /** Connections whose CI is not attested yet (the agents push nothing to them). */
  readonly ciNeeded: number
  /** The deployment's GitHub Issues source reads at least one repository. */
  readonly issuesRead: boolean
}

export function connectionsSummary(input: Readonly<{
  connections: readonly EngineeringConnection[]
  apps: readonly GitHubApp[]
  issues: IssuesSourceView | undefined
  checks: ReadonlyMap<string, InstallationCheck>
  today: string
}>): ConnectionsSummary {
  const { connections, apps, issues, checks, today } = input
  const groups = groupConnections(connections, apps)
  const rowsWait = connections.some((connection) => rowPrimary(connection, issuesOf(issues, connection.connection_id), today) !== null)
  const appsWait = apps.some((app) => appPrimary(app, checks.get(app.app_id)) !== null)
  return {
    empty: connections.length === 0 && apps.length === 0,
    attention: rowsWait || appsWait,
    through: groups.apps.filter((group) => group.connections.length > 0)
      .map((group) => ({ slug: group.app.slug, count: group.connections.length })),
    others: groups.others.length,
    publicRead: groups.publicRead.length,
    ciNeeded: connections.filter((connection) => !isPublicRead(connection) && !isCiAttested(connection)).length,
    issuesRead: issues?.connections.some((entry) => entry.reading) ?? false,
  }
}
