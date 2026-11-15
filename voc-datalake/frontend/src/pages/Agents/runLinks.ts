/**
 * @fileoverview The run's issue and pull request as the run monitor links them (`lambda/engineering/run_links.py`, which
 * keeps an address only when it is the run's own repository's): a recorded address becomes a link only when it is
 * https on its host's own domain, under the run's repository, with no port or credentials in it; else it is shown
 * unlinked.
 *
 * @module pages/Agents/runLinks
 */
import { isHttpsUrl } from '../../utils/httpsUrl'
import type { RunIssueLink, RunPullRequestLink } from '../../api/engineeringRunsApi'

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
