/**
 * @fileoverview The run's issue and pull request on the run monitor: an address is linked only when it is https on its
 * host's own domain under the run's repository (runLinks.ts, LOCKSTEP with `lambda/engineering/run_links.py` HOSTS),
 * and a link opens in a new tab with `rel="noopener noreferrer"`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { engineeringOverview } from '@test/engineeringRunFixtures'
import { parseOverview } from '../../api/engineeringRunsApi'
import { EngineeringRunLinks } from './EngineeringRunLinks'
import { RUN_LINK_HOSTS, runLinkHref } from './runLinks'

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
