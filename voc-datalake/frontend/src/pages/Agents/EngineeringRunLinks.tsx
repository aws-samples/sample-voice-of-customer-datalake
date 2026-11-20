/**
 * @fileoverview The run monitor's links to the issue the run was started from and to its draft pull request (a GitLab
 * merge request), as the run's record keeps them (`lambda/engineering/run_links.py`). Each opens on the host in a new
 * tab, only when its address passes `runLinkHref`; an issue recorded as given at the start says so.
 *
 * Since 7.57.00 a run on a fork connection also shows its pull request on the upstream (the upstream is its owner's; the
 * fork and the pull request are the person's):
 *
 * - **opened** (found open from the run's branch: the person created it): a link only to
 *   `https://github.com/<upstream>/pull/<n>`;
 * - **one click away** (`link`): **Open the pull request on ‹upstream›**, GitHub's compare page with the title and body
 *   prefilled, where the person clicks Create (so it is theirs; no token, no App on the upstream; 7.58.00: the app never
 *   opens it itself). A link only to `https://github.com/<upstream>/compare/…`. When the link's body had to be
 *   shortened, **Copy the description** copies the full one;
 * - **refused** by a safety check (no link: the reason);
 * - **unknown** outcome (the compare link kept, when there is one).
 *
 * {@link UpstreamEndNotice} says the same once the run has ended, at the head of the run's page.
 *
 * @module pages/Agents/EngineeringRunLinks
 */
import { ExternalLink, GitPullRequest } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { runLinkHref, upstreamCompareHref, upstreamPullHref } from './runLinks'
import type { EngineeringOverview, RunUpstreamPullRequest } from '../../api/engineeringRunsApi'

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

/** Copy the description: the full body, when the compare link carries a shortened one. */
function CopyDescription({ description }: Readonly<{ description: string }>) {
  const { t } = useTranslation('agents')
  const { copy, copiedKey } = useCopyToClipboard()
  return (
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => { copy(description) }}>
      {copiedKey === null ? t('engineeringRun.links.upstreamCopy') : t('engineeringRun.links.upstreamCopied')}
    </button>
  )
}

/** The pull request one click away: GitHub's compare page, the full description to copy when shortened, the note. */
function UpstreamCompare({ upstream }: Readonly<{ upstream: RunUpstreamPullRequest }>) {
  const { t } = useTranslation('agents')
  const href = upstreamCompareHref(upstream)
  const label = t('engineeringRun.links.upstreamCompare', { upstream: upstream.upstream })
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-2" data-testid="upstream-compare">
      {href === null ? <span>{label}</span> : (
        <a className="btn btn-primary btn-sm inline-flex items-center gap-1.5" href={href} target="_blank" rel="noopener noreferrer"
          aria-label={t('engineeringRun.links.opens', { label })}>
          <GitPullRequest size={14} aria-hidden="true" />{label}<ExternalLink size={12} aria-hidden="true" />
        </a>
      )}
      {upstream.description !== null && <CopyDescription description={upstream.description} />}
      <span className="min-w-0 text-muted [overflow-wrap:anywhere]">
        {upstream.reason ?? t('engineeringRun.links.upstreamYours')}
        {upstream.description !== null && <> {t('engineeringRun.links.upstreamShortened')}</>}
      </span>
    </span>
  )
}

/** The upstream pull request: its link once opened, one click away, the reason when refused, or an unknown outcome. */
function UpstreamLine({ upstream }: Readonly<{ upstream: RunUpstreamPullRequest }>) {
  const { t } = useTranslation('agents')
  if (upstream.state === 'opened') {
    const label = upstream.number === null
      ? t('engineeringRun.links.upstreamOpened', { upstream: upstream.upstream })
      : t('engineeringRun.links.upstream', { upstream: upstream.upstream, number: upstream.number })
    return (
      <RunLink href={upstreamPullHref(upstream)} label={label}
        note={upstream.as === null ? undefined : t('engineeringRun.links.upstreamAs', { login: upstream.as })} />
    )
  }
  if (upstream.state === 'link') return <UpstreamCompare upstream={upstream} />
  if (upstream.state === 'refused') {
    return (
      <span className="min-w-0 break-words text-warn [overflow-wrap:anywhere]" data-testid="upstream-refused">
        {t('engineeringRun.links.upstreamRefused', { upstream: upstream.upstream })}
        {upstream.reason !== null && <> {upstream.reason}</>}
      </span>
    )
  }
  return (
    <>
      <span className="text-muted">{t('engineeringRun.links.upstreamUnknown', { upstream: upstream.upstream })}</span>
      {upstream.compare_url !== null && <UpstreamCompare upstream={upstream} />}
    </>
  )
}

/** The ended run's pull request on the upstream one click away (`link`, or unknown with its compare link), else null. */
function oneClickAtEnd(run: EngineeringOverview['run']): RunUpstreamPullRequest | null {
  const upstream = run.upstream_pull_request
  if (run.ended_at === null || upstream === null) return null
  return upstream.compare_url !== null && (upstream.state === 'link' || upstream.state === 'unknown') ? upstream : null
}

/**
 * The ended run's notice of its pull request on the upstream one click away: what the person does next, at the head of
 * the run's page. Nothing for any other run.
 */
export function UpstreamEndNotice({ run }: Readonly<{ run: EngineeringOverview['run'] }>) {
  const { t } = useTranslation('agents')
  const upstream = oneClickAtEnd(run)
  if (upstream === null) return null
  return (
    <div role="status" className="space-y-2 rounded-md border border-border bg-bg-hover px-3 py-2 text-sm" data-testid="upstream-end-notice">
      <p className="font-semibold text-text-strong">{t('engineeringRun.links.endNotice', { upstream: upstream.upstream })}</p>
      <UpstreamCompare upstream={upstream} />
    </div>
  )
}

export function EngineeringRunLinks({ run }: Readonly<{ run: EngineeringOverview['run'] }>) {
  const { t } = useTranslation('agents')
  const { issue, pull_request: pull, repo, upstream_pull_request: upstream } = run
  // (an ended run's one-click pull request is the end notice's, at the head of the page: not said twice)
  const noticed = oneClickAtEnd(run) !== null
  if (issue === null && pull === null && (upstream === null || noticed)) return null
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
      {upstream !== null && !noticed && <UpstreamLine upstream={upstream} />}
    </p>
  )
}
