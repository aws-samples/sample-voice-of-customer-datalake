/**
 * @fileoverview A repository's issues as its connection drives them (7.50.02; api/issuesSourceApi.ts): connecting a
 * repository through the deployment's GitHub App reads its issues automatically into the deployment's GitHub Issues
 * source, and creates its `voc-agent` label, with no Data sources step.
 *
 * - {@link IssuesCell}, a repository row's Issues column on Agents → Connections (7.52.00, part 2 S4): on a connection
 *   made through one of the deployment's Apps, the "Read this repository's issues" switch (on unless an administrator
 *   turned it off; no confirmation to turn it off, the page's status line says so) with its state as visible text
 *   ("Reading", "Not read", "Off"), and why the source does not read it when it does not (switched off; the source
 *   signs in with a token, which an administrator manages under Administration → Sources → Source settings; another App; its 20
 *   repositories taken; no source deployed here; not in its list yet, with "Read its issues now"). A GitLab
 *   connection, or one with a pasted key, shows "—" (read only through the App: said to screen readers);
 * - {@link LabelCell}, its Label column: the `voc-agent` label on the repository (`ok`), or that it could not be created
 *   (`danger`: the row's primary is then Create label, the App's check trying again);
 * - {@link IssuesFollowLines}, under an installation's return and a Check installation: what followed for the source.
 *
 * @module pages/Agents/ConnectionIssues
 */
import { useId } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CircleX, Tag } from 'lucide-react'
import clsx from 'clsx'
import { IconBadge } from '../../components/IconBadge/IconBadge'
import { issuesSourceApi, issuesSourceKeys } from '../../api/issuesSourceApi'
import { isPublicRead } from '../../api/engineeringConnectionsApi'
import { deploymentSourcePath } from '../Settings/adminPaths'
import { ConnectionChangeError } from './ConnectionChangeError'
import { issuesOf, viaApp } from './connectionStatus'
import type { ConnectionIssues as Issues, IssuesFollow, IssuesSkipReason, IssuesSourceView } from '../../api/issuesSourceApi'
import type { EngineeringConnection } from '../../api/engineeringConnectionsApi'

/** The deployment's GitHub Issues card (Administration → Sources → Source settings), where a token-signed source is managed. */
const ISSUES_CARD = deploymentSourcePath('github_issues')
/** The most repositories the source reads (plugins/_shared/github_config.py MAX_REPOS). */
const MAX_REPOSITORIES = 20
/** The `switch` recipe's track, as components/Switch draws it. */
const TRACK = 'switch peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50'

function SourcesLink() {
  const { t } = useTranslation('agents')
  return <Link className="link" to={ISSUES_CARD}>{t('connections.issues.openSources')}</Link>
}

/** Why the source does not read the repository; `onReadNow`: a connection not in its list yet, read now. */
function ReasonLine({ issues, id, busy, onReadNow }: Readonly<{
  issues: Issues; id: string; busy: boolean; onReadNow: () => void
}>) {
  const { t } = useTranslation('agents')
  const reason = issues.reason ?? 'unknown'
  return (
    <p id={id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
      <span>{t(`connections.issues.reasons.${reason}`, { limit: MAX_REPOSITORIES })}</span>
      {(reason === 'token' || reason === 'limit') && <SourcesLink />}
      {reason === 'pending' && (
        <button type="button" className="btn btn-secondary btn-sm" aria-disabled={busy}
          onClick={() => { if (!busy) onReadNow() }}>{t('connections.issues.readNow')}</button>
      )}
    </p>
  )
}

/** What the switch's visible text says: the source reads it, it is switched on but not read, or it is off. */
function stateOf(issues: Issues): 'reading' | 'notRead' | 'off' {
  if (!issues.read) return 'off'
  return issues.reading ? 'reading' : 'notRead'
}

/**
 * The switch, named "Read this repository's issues" (components/Switch's recipe; its visible text is the state, so
 * the name is the input's own label), described by the reason line.
 */
function ReadSwitch({ issues, busy, describedBy, onChange }: Readonly<{
  issues: Issues; busy: boolean; describedBy: string | undefined; onChange: (read: boolean) => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <label className="inline-flex items-center gap-2 text-[12px] text-text">
      <span className="relative inline-flex flex-shrink-0 items-center">
        <input type="checkbox" role="switch" className="peer sr-only" checked={issues.read} disabled={busy}
          aria-label={t('connections.issues.switch')} aria-describedby={describedBy}
          onChange={(event) => { onChange(event.target.checked) }} />
        <span aria-hidden="true" className={clsx(TRACK, issues.read && 'switch-on')}><span className="switch-knob" /></span>
      </span>
      <span aria-hidden="true">{t(`connections.issues.state.${stateOf(issues)}`)}</span>
    </label>
  )
}

/** "—", with what it means said to a screen reader. */
function NoIssues({ meaning }: Readonly<{ meaning: string | null }>) {
  return (
    <span className="text-[12px] text-muted">
      <span aria-hidden="true">—</span>
      {meaning !== null && <span className="sr-only">{meaning}</span>}
    </span>
  )
}

/**
 * The connection's Issues column, as `view` says it: written through `PUT …/connections/<id>/issues`, whose answer
 * replaces the view. "—" while the view is not read, or does not name the connection, or for a connection whose issues
 * do not follow it.
 */
export function IssuesCell({ connection, view }: Readonly<{
  connection: EngineeringConnection; view: IssuesSourceView | undefined
}>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const reasonId = useId()
  const change = useMutation({
    mutationFn: (read: boolean) => issuesSourceApi.setRead(connection.connection_id, read),
    onSuccess: (answer) => { queryClient.setQueryData(issuesSourceKeys.view(), answer) },
  })
  if (connection.host === 'gitlab') return <NoIssues meaning={t('connections.issues.githubOnly')} />
  // (7.57.00: a fork's issues are its upstream's, read through the upstream's own read-only connection)
  if (connection.fork !== null) {
    return <NoIssues meaning={t('connections.issues.fromUpstream', { upstream: connection.fork.upstream })} />
  }
  if (!viaApp(connection) && !isPublicRead(connection)) return <NoIssues meaning={t('connections.issues.appOnly')} />
  const issues = issuesOf(view, connection.connection_id)
  if (view === undefined || issues === undefined) return <NoIssues meaning={null} />
  return (
    <div className="space-y-1" data-testid={`connection-issues-${connection.connection_id}`}>
      {view.deployed && (
        <ReadSwitch issues={issues} busy={change.isPending} describedBy={issues.reading ? undefined : reasonId}
          onChange={(read) => { change.mutate(read) }} />
      )}
      {!issues.reading && (
        <ReasonLine issues={issues} id={reasonId} busy={change.isPending} onReadNow={() => { change.mutate(true) }} />
      )}
      <ConnectionChangeError change={change} />
    </div>
  )
}

/** The connection's Label column: the label on the repository, or that it could not be created; "—" when unsaid. */
export function LabelCell({ connection, view }: Readonly<{
  connection: EngineeringConnection; view: IssuesSourceView | undefined
}>) {
  const { t } = useTranslation('agents')
  // (a public repository read only gets no label: nothing is ever written to it)
  if (isPublicRead(connection)) return <NoIssues meaning={t('connections.issues.noLabelReadOnly')} />
  const issues = viaApp(connection) && connection.fork === null ? issuesOf(view, connection.connection_id) : undefined
  if (view === undefined || issues === undefined || issues.label === null) return <NoIssues meaning={null} />
  if (issues.label === 'failed') {
    return <IconBadge toneClass="badge-danger" icon={CircleX}>{t('connections.issues.labelFailed')}</IconBadge>
  }
  return <IconBadge toneClass="badge-ok" icon={Tag}>{view.label}</IconBadge>
}

const LABEL = 'voc-agent'
const listOf = (repositories: readonly string[]) => repositories.join(', ')

/** The skipped repositories by why, in the order the lines are said. */
function skippedBy(follow: IssuesFollow): [IssuesSkipReason, string[]][] {
  const reasons: IssuesSkipReason[] = ['off', 'other_app', 'limit']
  return reasons.map((reason): [IssuesSkipReason, string[]] => [
    reason, follow.skipped.filter((skip) => skip.reason === reason).map((skip) => skip.repository),
  ]).filter(([, repositories]) => repositories.length > 0)
}

/**
 * What followed for the deployment's GitHub Issues source from an installation or a check (nothing when no source is
 * deployed here): the repositories read automatically, the labels created or not, why any is not read.
 */
export function IssuesFollowLines({ follow }: Readonly<{ follow: IssuesFollow | null }>) {
  const { t } = useTranslation('agents')
  if (follow === null) return null
  const created = follow.labels.filter((label) => label.state !== 'failed').map((label) => label.repository)
  const failed = follow.labels.filter((label) => label.state === 'failed').map((label) => label.repository)
  return (
    <div className="space-y-1 text-[12px]" data-testid="issues-follow">
      {follow.signs_in === 'token'
        ? (
            <p className="flex flex-wrap items-center gap-x-2 text-muted">
              <span>{t('connections.issues.follow.token')}</span>
              <SourcesLink />
            </p>
          )
        : <p className="text-text">{t('connections.issues.follow.reading', { count: follow.reading.length })}</p>}
      {created.length > 0 && <p className="text-muted">{t('connections.issues.follow.labelsCreated', { label: LABEL, list: listOf(created) })}</p>}
      {failed.length > 0 && <p className="text-warn">{t('connections.issues.follow.labelsFailed', { label: LABEL, list: listOf(failed) })}</p>}
      {skippedBy(follow).map(([reason, repositories]) => (
        <p key={reason} className="text-muted">
          {t(`connections.issues.follow.skipped.${reason}`, { list: listOf(repositories), limit: MAX_REPOSITORIES })}
        </p>
      ))}
      {follow.schedule === 'off' && <p className="text-warn">{t('connections.issues.follow.scheduleOff')}</p>}
      {follow.error !== null && <p className="text-danger">{t('connections.issues.follow.error', { error: follow.error })}</p>}
    </div>
  )
}
