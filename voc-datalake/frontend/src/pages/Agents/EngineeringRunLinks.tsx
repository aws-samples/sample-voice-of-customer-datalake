/**
 * @fileoverview The run monitor's links to the issue the run was started from and to its draft pull request (a GitLab
 * merge request), as the run's record keeps them (`lambda/engineering/run_links.py`). Each opens on the host in a new
 * tab, only when its address passes `runLinkHref`; an issue recorded as given at the start says so.
 *
 * @module pages/Agents/EngineeringRunLinks
 */
import { ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { runLinkHref } from './runLinks'
import type { EngineeringOverview } from '../../api/engineeringRunsApi'

function RunLink({ href, label, note }: Readonly<{ href: string | null; label: string; note?: string }>) {
  const { t } = useTranslation('agents')
  return (
    <span className="inline-flex min-w-0 items-center gap-1 break-all">
      {href === null ? <span>{label}</span> : (
        <a className="link inline-flex items-center gap-1" href={href} target="_blank" rel="noopener noreferrer"
          aria-label={t('engineeringRun.links.opens', { label })}>
          {label}<ExternalLink size={12} aria-hidden="true" />
        </a>
      )}
      {note !== undefined && <span className="text-muted">({note})</span>}
    </span>
  )
}

export function EngineeringRunLinks({ run }: Readonly<{ run: EngineeringOverview['run'] }>) {
  const { t } = useTranslation('agents')
  const { issue, pull_request: pull, repo } = run
  if (issue === null && pull === null) return null
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      {issue !== null && (
        <RunLink href={runLinkHref(issue, repo)} label={t('engineeringRun.links.issue', { number: issue.number })}
          note={issue.verified ? undefined : t('engineeringRun.links.asGiven')} />
      )}
      {pull !== null && (
        <RunLink href={runLinkHref(pull, repo)} label={t(pull.host === 'gitlab' ? 'engineeringRun.links.mergeRequest'
          : 'engineeringRun.links.pullRequest', { number: pull.number })} />
      )}
    </p>
  )
}
