/**
 * @fileoverview A repository's issues as its connection drives them (7.50.02; api/issuesSourceApi.ts): connecting a
 * repository through the deployment's GitHub App reads its issues automatically into the deployment's GitHub Issues
 * source, and creates its `voc-agent` label, with no Data sources step.
 *
 * - {@link ConnectionIssues}, on each connection made through one of the deployment's Apps (Agents → Connections): the
 *   "Read this repository's issues" switch (on unless an administrator turned it off), whether the source reads it
 *   now or why not (switched off; the source signs in with a token, which an administrator manages under
 *   Administration → Data sources; another App; its 20 repositories taken; no source deployed here; not in its list
 *   yet, with "Read its issues now"), and its label;
 * - {@link IssuesFollowLines}, under an installation's return and a Check installation: what followed for the source.
 *
 * @module pages/Agents/ConnectionIssues
 */
import { useId } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import Switch from '../../components/Switch/Switch'
import { issuesSourceApi, issuesSourceKeys } from '../../api/issuesSourceApi'
import { deploymentSourcePath } from '../Settings/adminPaths'
import { useConnectionError } from './connectionText'
import type { ConnectionIssues as Issues, IssuesFollow, IssuesSkipReason, IssuesSourceView } from '../../api/issuesSourceApi'
import type { EngineeringConnection } from '../../api/engineeringConnectionsApi'

/** The deployment's GitHub Issues card (Administration → Data sources), where a token-signed source is managed. */
const ISSUES_CARD = deploymentSourcePath('github_issues')
/** The most repositories the source reads (plugins/_shared/github_config.py MAX_REPOS). */
const MAX_REPOSITORIES = 20

/** A connection made through one of the deployment's GitHub Apps: the only kind whose issues follow it. */
const followsIssues = (connection: EngineeringConnection): boolean =>
  connection.host === 'github' && connection.credential.kind === 'app_reference'

function SourcesLink() {
  const { t } = useTranslation('agents')
  return <Link className="link" to={ISSUES_CARD}>{t('connections.issues.openSources')}</Link>
}

/** Whether the source reads the repository now, or why not; `onReadNow`: a connection not in its list yet, read now. */
function StatusLine({ issues, id, busy, onReadNow }: Readonly<{
  issues: Issues; id: string; busy: boolean; onReadNow: () => void
}>) {
  const { t } = useTranslation('agents')
  if (issues.reading) return <p id={id} className="text-[12px] text-ok">{t('connections.issues.reading')}</p>
  const reason = issues.reason ?? 'unknown'
  return (
    <p id={id} className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
      <span>{t(`connections.issues.reasons.${reason}`, { limit: MAX_REPOSITORIES })}</span>
      {(reason === 'token' || reason === 'limit') && <SourcesLink />}
      {reason === 'pending' && (
        <button type="button" className="btn btn-secondary btn-sm" aria-disabled={busy}
          onClick={() => { if (!busy) onReadNow() }}>{t('connections.issues.readNow')}</button>
      )}
    </p>
  )
}

function LabelLine({ issues, label }: Readonly<{ issues: Issues; label: string }>) {
  const { t } = useTranslation('agents')
  if (issues.label === null) return null
  const failed = issues.label === 'failed'
  return <p className={failed ? 'text-[12px] text-warn' : 'text-[12px] text-muted'}>{t(`connections.issues.label.${issues.label}`, { label })}</p>
}

/**
 * The connection's issues as `view` says them (nothing while it is not read, or does not name the connection): its
 * switch, written through `PUT …/connections/<id>/issues`, whose answer replaces the view.
 */
export function ConnectionIssues({ connection, view }: Readonly<{
  connection: EngineeringConnection; view: IssuesSourceView | undefined
}>) {
  const { t } = useTranslation('agents')
  const errorText = useConnectionError()
  const queryClient = useQueryClient()
  const statusId = useId()
  const change = useMutation({
    mutationFn: (read: boolean) => issuesSourceApi.setRead(connection.connection_id, read),
    onSuccess: (answer) => { queryClient.setQueryData(issuesSourceKeys.view(), answer) },
  })
  const issues = view?.connections.find((entry) => entry.connection_id === connection.connection_id)
  if (view === undefined || issues === undefined || !followsIssues(connection)) return null
  return (
    <div className="space-y-1" data-testid={`connection-issues-${connection.connection_id}`}>
      {view.deployed && (
        <Switch label={t('connections.issues.switch')} checked={issues.read} disabled={change.isPending}
          describedBy={statusId} onChange={(read) => { change.mutate(read) }} />
      )}
      <StatusLine issues={issues} id={statusId} busy={change.isPending} onReadNow={() => { change.mutate(true) }} />
      <LabelLine issues={issues} label={view.label} />
      {change.isError && <p role="alert" className="text-[12px] text-danger">{errorText(change.error)}</p>}
    </div>
  )
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
