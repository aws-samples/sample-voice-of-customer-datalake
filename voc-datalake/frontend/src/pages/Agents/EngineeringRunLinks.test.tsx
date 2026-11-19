/**
 * @fileoverview The run's issue and pull request on the run monitor: an address is linked only when it is https on its
 * host's own domain under the run's repository (runLinks.ts, LOCKSTEP with `lambda/engineering/run_links.py` HOSTS),
 * and a link opens in a new tab with `rel="noopener noreferrer"`. Since 7.57.00 a fork run's pull request on the
 * upstream: opened (as whom), one click away on GitHub's compare page (only the upstream's own, with Copy the
 * description when the link's body is shortened), refused (no link), unknown; and the ended run's notice of it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { engineeringOverview } from '@test/engineeringRunFixtures'
import { parseOverview } from '../../api/engineeringRunsApi'
import { EngineeringRunLinks, UpstreamEndNotice } from './EngineeringRunLinks'
import { RUN_LINK_HOSTS, runLinkHref, upstreamCompareHref, upstreamPullHref } from './runLinks'

const REPO = 'example-org/storefront'
const ISSUE = `https://github.com/${REPO}/issues/12`
const PULL = `https://github.com/${REPO}/pull/7`
const MERGE = `https://gitlab.com/${REPO}/-/merge_requests/8`

function runWith(links: Record<string, unknown>) {
  return parseOverview(engineeringOverview(links)).run
}

describe('runLinkHref', () => {
  it('links an https address on the host\'s own domain under the run\'s repository', () => {
    expect(runLinkHref({ host: 'github', url: PULL }, REPO)).toBe(PULL)
    expect(runLinkHref({ host: 'gitlab', url: MERGE }, REPO)).toBe(MERGE)
    // (the host's own casing of the repository's path)
    expect(runLinkHref({ host: 'github', url: 'https://github.com/Example-Org/Storefront/pull/7' }, REPO)).not.toBeNull()
  })

  it('refuses another scheme, domain or repository', () => {
    expect(runLinkHref({ host: 'github', url: PULL.replace('https:', 'http:') }, REPO)).toBeNull()
    expect(runLinkHref({ host: 'gitlab', url: PULL }, REPO)).toBeNull()
    expect(runLinkHref({ host: 'github', url: 'https://github.com.example.net/example-org/storefront/pull/7' }, REPO)).toBeNull()
    expect(runLinkHref({ host: 'github', url: `https://github.com/other-org/storefront/pull/7` }, REPO)).toBeNull()
  })

  it('refuses a port, credentials, a script address, or a run with no repository', () => {
    expect(runLinkHref({ host: 'github', url: `https://github.com:8443/${REPO}/pull/7` }, REPO)).toBeNull()
    expect(runLinkHref({ host: 'github', url: `https://someone@github.com/${REPO}/pull/7` }, REPO)).toBeNull()
    expect(runLinkHref({ host: 'github', url: 'javascript:alert(1)' }, REPO)).toBeNull()
    expect(runLinkHref({ host: 'github', url: PULL }, '')).toBeNull()
  })

  it('knows the host kinds the server does', () => {
    const source = readFileSync(join(__dirname, '../../../../lambda/engineering/run_links.py'), 'utf8')
    const hosts = /^HOSTS: Final\[Mapping\[str, str\]\] = (\{[^}]*\})$/m.exec(source)?.[1] ?? ''
    expect(JSON.parse(hosts.replaceAll("'", '"'))).toStrictEqual(RUN_LINK_HOSTS)
  })
})

describe('EngineeringRunLinks', () => {
  it('opens the issue and the pull request in a new tab, with no opener or referrer', () => {
    render(<EngineeringRunLinks run={runWith({
      issue: { host: 'github', number: 12, url: ISSUE, verified: false },
      pull_request: { host: 'github', number: 7, url: PULL, head: 'voc-agent/RUN1/fix', base: 'main' },
    })} />)
    const pull = screen.getByRole('link', { name: 'Pull request #7 (opens in a new tab)' })
    expect(pull).toHaveAttribute('href', PULL)
    expect(pull).toHaveAttribute('target', '_blank')
    expect(pull).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByRole('link', { name: 'Issue #12 (opens in a new tab)' })).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('names a merge request as GitLab does, and says an issue was recorded as given', () => {
    render(<EngineeringRunLinks run={runWith({
      issue: { host: 'gitlab', number: 3, url: `https://gitlab.com/${REPO}/-/issues/3`, verified: false },
      pull_request: { host: 'gitlab', number: 8, url: MERGE, head: 'voc-agent/RUN1/fix', base: 'main' },
    })} />)
    expect(screen.getByRole('link', { name: 'Merge request !8 (opens in a new tab)' })).toHaveAttribute('href', MERGE)
    expect(screen.getByText('(as given at the start, not checked on the host)')).toBeInTheDocument()
  })

  it('shows an address that fails the check as text, never as a link', () => {
    render(<EngineeringRunLinks run={runWith({
      pull_request: { host: 'github', number: 7, url: 'https://code.example.net/pull/7', head: 'h', base: 'main' },
    })} />)
    expect(screen.getByText('Pull request #7')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('shows nothing for a run with neither, or an answer without them', () => {
    const { container } = render(<EngineeringRunLinks run={runWith({ issue: null })} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the upstream pull request of a run on a fork connection (7.57.00)', () => {
  const UPSTREAM = 'https://github.com/open-tools/lint-kit/pull/128'
  const upstream = (fields: Record<string, unknown>) => ({
    state: 'opened', upstream: 'open-tools/lint-kit', number: 128, url: UPSTREAM, as: 'alice', reason: null, at: null, ...fields,
  })

  // (the compare page: `/compare/<default>...<fork owner>:<fork repo>:<branch>?expand=1&title=…&body=…`)
  const COMPARE = 'https://github.com/open-tools/lint-kit/compare/main...alice:lint-kit:voc-agent/RUN1/fix?expand=1&title=Fix'
  const oneClick = (fields: Record<string, unknown> = {}) => upstream({
    state: 'link', number: null, url: null, as: null, compare_url: COMPARE, title: 'Fix', description: null,
    reason: 'The app opens it for you once you authorize it (Authorize as me).', ...fields,
  })
  const OPEN_COMPARE = 'Open the pull request on open-tools/lint-kit (opens in a new tab)'

  it('links only the upstream\'s own address of that number', () => {
    expect(upstreamPullHref({ upstream: 'open-tools/lint-kit', number: 128, url: UPSTREAM })).toBe(UPSTREAM)
    expect([
      upstreamPullHref({ upstream: 'open-tools/lint-kit', number: 128, url: 'https://github.com/alice/lint-kit/pull/128' }),
      upstreamPullHref({ upstream: 'open-tools/lint-kit', number: 127, url: UPSTREAM }),
      upstreamPullHref({ upstream: 'open-tools/lint-kit', number: 128, url: `${UPSTREAM}?x=1` }),
      upstreamPullHref({ upstream: 'open-tools/lint-kit', number: 128, url: UPSTREAM.replace('https:', 'http:') }),
      upstreamPullHref({ upstream: 'open-tools/lint-kit', number: 128, url: null }),
    ]).toStrictEqual([null, null, null, null, null])
  })

  it('opens it in a new tab once opened, as whom', () => {
    render(<EngineeringRunLinks run={runWith({
      pull_request: { host: 'github', number: 7, url: PULL, head: 'voc-agent/RUN1/fix', base: 'main' },
      upstream_pull_request: upstream({}),
    })} />)
    const link = screen.getByRole('link', { name: 'Upstream pull request open-tools/lint-kit#128 (opens in a new tab)' })
    expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')])
      .toStrictEqual([UPSTREAM, '_blank', 'noopener noreferrer'])
    expect(screen.getByText('(as @alice)')).toBeInTheDocument()
  })

  it('says why none was opened, with no link even when one is on the record, or that its outcome is unknown', () => {
    const { unmount } = render(<EngineeringRunLinks run={runWith({
      upstream_pull_request: upstream({ state: 'refused', number: null, url: null, as: null, compare_url: COMPARE,
        reason: 'The upstream opts out of bot pull requests (topic no-bot-prs).' }),
    })} />)
    expect(screen.getByTestId('upstream-refused')).toHaveTextContent(
      'No pull request on open-tools/lint-kit: The upstream opts out of bot pull requests (topic no-bot-prs).')
    expect([screen.queryByRole('link'), screen.queryByTestId('upstream-compare')]).toStrictEqual([null, null])
    unmount()
    render(<EngineeringRunLinks run={runWith({ upstream_pull_request: upstream({ state: 'later', number: null, url: null }) })} />)
    expect(screen.getByText('Pull request on open-tools/lint-kit: outcome unknown, check GitHub.')).toBeInTheDocument()
  })

  it('links only the upstream\'s own compare page on GitHub', () => {
    expect(upstreamCompareHref({ upstream: 'open-tools/lint-kit', compare_url: COMPARE })).toBe(COMPARE)
    expect(upstreamCompareHref({ upstream: 'Open-Tools/Lint-Kit', compare_url: COMPARE })).toBe(COMPARE)
    expect([
      upstreamCompareHref({ upstream: 'open-tools/lint-kit', compare_url: COMPARE.replace('https:', 'http:') }),
      upstreamCompareHref({ upstream: 'open-tools/lint-kit', compare_url: COMPARE.replace('github.com', 'gitlab.com') }),
      upstreamCompareHref({ upstream: 'open-tools/lint-kit', compare_url: COMPARE.replace('github.com', 'github.com.example.net') }),
      upstreamCompareHref({ upstream: 'open-tools/lint-kit', compare_url: COMPARE.replace('github.com', 'github.com:8443') }),
      upstreamCompareHref({ upstream: 'open-tools/lint-kit', compare_url: COMPARE.replace('github.com', 'x:y@github.com') }),
      upstreamCompareHref({ upstream: 'open-tools/lint-kit', compare_url: `${COMPARE}#top` }),
      upstreamCompareHref({ upstream: 'open-tools/lint-kit', compare_url: 'https://github.com/alice/lint-kit/compare/main...fix' }),
      upstreamCompareHref({ upstream: 'open-tools/lint-kit', compare_url: 'https://github.com/open-tools/lint-kit/pull/128' }),
      upstreamCompareHref({ upstream: 'open-tools/lint-kit', compare_url: 'javascript:alert(1)' }),
      upstreamCompareHref({ upstream: 'open-tools/lint-kit', compare_url: null }),
    ]).toStrictEqual(Array.from({ length: 10 }, () => null))
  })

  it('puts the pull request one click away on GitHub\'s compare page, why the app did not open it a plain note', () => {
    render(<EngineeringRunLinks run={runWith({ upstream_pull_request: oneClick() })} />)
    const link = screen.getByRole('link', { name: OPEN_COMPARE })
    expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')])
      .toStrictEqual([COMPARE, '_blank', 'noopener noreferrer'])
    const compare = screen.getByTestId('upstream-compare')
    expect(compare).toHaveTextContent('The app opens it for you once you authorize it (Authorize as me).')
    expect([within(compare).queryByRole('button'), screen.queryByTestId('upstream-refused'), compare.querySelector('.text-warn')])
      .toStrictEqual([null, null, null])
  })

  it('copies the full description when the link carries a shortened one', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    const description = '## What this changes\n\nThe rule reads an optional call as guarded.\n\n## Why\n\nA false positive.'
    render(<EngineeringRunLinks run={runWith({ upstream_pull_request: oneClick({ description, reason: null }) })} />)
    const compare = screen.getByTestId('upstream-compare')
    expect(compare).toHaveTextContent('You click Create on GitHub: the pull request is yours. The link carries a shorter '
      + 'description: paste the full one from Copy the description.')
    await user.click(within(compare).getByRole('button', { name: 'Copy the description' }))
    expect(writeText).toHaveBeenCalledWith(description)
    expect(within(compare).getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('shows a compare address off the upstream\'s GitHub page as text, never as a link', () => {
    render(<EngineeringRunLinks run={runWith({
      upstream_pull_request: oneClick({ compare_url: 'https://example.net/open-tools/lint-kit/compare/main...alice:fix' }),
    })} />)
    expect(screen.getByTestId('upstream-compare')).toHaveTextContent('Open the pull request on open-tools/lint-kit')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('keeps the compare link of an unknown outcome', () => {
    render(<EngineeringRunLinks run={runWith({ upstream_pull_request: oneClick({ state: 'unknown', reason: null }) })} />)
    expect(screen.getByText('Pull request on open-tools/lint-kit: outcome unknown, check GitHub.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: OPEN_COMPARE })).toHaveAttribute('href', COMPARE)
  })

  it('says it once the run ended, at the head of the run\'s page, and not again in the links', () => {
    const ended = runWith({ ended_at: '2026-11-12T09:00:00Z', upstream_pull_request: oneClick() })
    const { container, unmount } = render(<EngineeringRunLinks run={ended} />)
    expect(container).toBeEmptyDOMElement()
    unmount()
    render(<UpstreamEndNotice run={ended} />)
    const notice = screen.getByTestId('upstream-end-notice')
    expect([notice.getAttribute('role'), notice.querySelector('p')?.textContent])
      .toStrictEqual(['status', 'The run ended with its pull request on open-tools/lint-kit one click away.'])
    expect(within(notice).getByRole('link', { name: OPEN_COMPARE })).toHaveAttribute('href', COMPARE)
  })

  it('has no end notice for a live run, an opened pull request or a refused one', () => {
    const at = '2026-11-12T09:00:00Z'
    const { container } = render(<>
      <UpstreamEndNotice run={runWith({ upstream_pull_request: oneClick() })} />
      <UpstreamEndNotice run={runWith({ ended_at: at, upstream_pull_request: upstream({ compare_url: COMPARE }) })} />
      <UpstreamEndNotice run={runWith({ ended_at: at, upstream_pull_request: oneClick({ state: 'refused' }) })} />
      <UpstreamEndNotice run={runWith({ ended_at: at, upstream_pull_request: oneClick({ compare_url: null }) })} />
      <UpstreamEndNotice run={runWith({ ended_at: at })} />
    </>)
    expect(container).toBeEmptyDOMElement()
  })
})
