/**
 * @fileoverview The run's issue and pull request as the run monitor links them (`lambda/engineering/run_links.py`, which
 * keeps an address only when it is the run's own repository's): a recorded address becomes a link only when it is
 * https on its host's own domain, under the run's repository, with no port or credentials in it; else it is shown
 * unlinked.
 *
 * @module pages/Agents/runLinks
 */
import { isHttpsUrl } from '../../utils/httpsUrl'
import type { RunIssueLink, RunPullRequestLink, RunUpstreamPullRequest } from '../../api/engineeringRunsApi'

/** Each host kind's own web domain (run_links.py HOSTS: held to it by this module's lockstep test). */
export const RUN_LINK_HOSTS: Readonly<Record<RunIssueLink['host'], string>> = { github: 'github.com', gitlab: 'gitlab.com' }

/**
 * The address to link `link` to: its recorded URL when it is https on its host's own domain, with no port or
 * credentials, and under the run's repository `repo`; null otherwise (shown, not linked).
 */
export function runLinkHref(link: Pick<RunIssueLink | RunPullRequestLink, 'host' | 'url'>, repo: string): string | null {
  if (!isHttpsUrl(link.url) || repo === '') return null
  const url = new URL(link.url)
  if (url.hostname !== RUN_LINK_HOSTS[link.host] || url.port !== '' || url.username !== '' || url.password !== '') return null
  return url.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/`) ? url.href : null
}

/**
 * (7.57.00) The address to link an upstream pull request to: exactly `https://github.com/<upstream>/pull/<number>` (the
 * upstream's own casing taken), no port, credentials, query or fragment; null otherwise (shown, not linked).
 */
export function upstreamPullHref(upstream: Pick<RunUpstreamPullRequest, 'upstream' | 'number' | 'url'>): string | null {
  if (upstream.url === null || upstream.number === null || !isHttpsUrl(upstream.url)) return null
  const url = new URL(upstream.url)
  if (url.hostname !== RUN_LINK_HOSTS.github || url.port !== '' || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '') return null
  return url.pathname.toLowerCase() === `/${upstream.upstream.toLowerCase()}/pull/${upstream.number}` ? url.href : null
}

/**
 * (7.57.00) The address of the upstream pull request one click away: GitHub's compare page of the upstream, exactly
 * `https://github.com/<upstream>/compare/…` (its prefilled title and body in the query), no port, credentials or
 * fragment; null otherwise (not linked).
 */
export function upstreamCompareHref(upstream: Pick<RunUpstreamPullRequest, 'upstream' | 'compare_url'>): string | null {
  if (upstream.compare_url === null || !isHttpsUrl(upstream.compare_url)) return null
  const url = new URL(upstream.compare_url)
  if (url.hostname !== RUN_LINK_HOSTS.github || url.port !== '' || url.username !== '' || url.password !== ''
    || url.hash !== '') return null
  return url.pathname.toLowerCase().startsWith(`/${upstream.upstream.toLowerCase()}/compare/`) ? url.href : null
}
