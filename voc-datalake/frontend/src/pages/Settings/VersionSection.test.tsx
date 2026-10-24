/**
 * Administration → Version: the stamped build values, and the changelog that
 * loads only when the tab mounts, hides an empty Unreleased section, renders
 * ten releases then more on demand, and never emits an unsafe link.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'

const loadChangelog = vi.fn<() => Promise<string>>()
vi.mock('./changelogSource', () => ({ loadChangelog: () => loadChangelog() }))

const { default: VersionSection } = await import('./VersionSection')

/** A changelog with an empty Unreleased heading and `count` releases, newest first. */
function changelogWith(count: number): string {
  const releases = Array.from({ length: count }, (_, i) => `## [1.${String(count - i).padStart(2, '0')}.00] - 2026-01-01\n\n- Change ${count - i}.`)
  return ['# Changelog', '', 'Preamble.', '', '## [Unreleased]', '', ...releases].join('\n')
}

function releaseHeadings(): string[] {
  return screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
}

beforeEach(() => { loadChangelog.mockReset() })

describe('VersionSection', () => {
  it('shows the stamped version in the changelog padded form, the commit and the UTC build time', () => {
    loadChangelog.mockReturnValue(new Promise(() => {}))
    renderWithQueryClient(<VersionSection />)

    expect(screen.getByText('3.04.00')).toBeInTheDocument()
    expect(screen.getByText('abc1234')).toBeInTheDocument()
    expect(screen.getByText('2026-01-02 03:04 UTC')).toBeInTheDocument()
  })

  it('loads the changelog when the tab mounts and skips the empty Unreleased heading', async () => {
    loadChangelog.mockResolvedValue(changelogWith(3))
    renderWithQueryClient(<VersionSection />)

    await screen.findByText('Change 3.')
    expect(loadChangelog).toHaveBeenCalledTimes(1)
    expect(releaseHeadings()).toStrictEqual(['[1.03.00] - 2026-01-01', '[1.02.00] - 2026-01-01', '[1.01.00] - 2026-01-01'])
    expect(screen.queryByText(/Unreleased|Preamble/)).not.toBeInTheDocument()
  })

  it('renders only the newest ten releases at first', async () => {
    loadChangelog.mockResolvedValue(changelogWith(23))
    renderWithQueryClient(<VersionSection />)
    await screen.findByText('Change 23.')

    expect(releaseHeadings()).toHaveLength(10)
    expect(screen.queryByText('Change 13.')).not.toBeInTheDocument()
  })

  it('adds ten older releases per "Show older releases" until none are left', async () => {
    loadChangelog.mockResolvedValue(changelogWith(23))
    renderWithQueryClient(<VersionSection />)
    await screen.findByText('Change 23.')

    await userEvent.click(screen.getByRole('button', { name: /Show older releases \(13 more\)/ }))
    expect(releaseHeadings()).toHaveLength(20)
    await userEvent.click(screen.getByRole('button', { name: /Show older releases \(3 more\)/ }))
    expect(releaseHeadings().at(-1)).toBe('[1.01.00] - 2026-01-01')
    expect(screen.queryByRole('button', { name: /Show older releases/ })).not.toBeInTheDocument()
  })

  it('opens web and repo-doc links in a new tab and renders unsafe or in-page links as plain text', async () => {
    loadChangelog.mockResolvedValue([
      '## [1.00.00] - 2026-01-01',
      '',
      '- [Web](https://example.com/a) [Doc](docs/mcp.md#tokens) [Anchor](#x) [Mail](mailto:a@example.com) [Up](../secret.md)',
      '- <b>raw html</b> ![Pic](https://example.com/p.png)',
    ].join('\n'))
    renderWithQueryClient(<VersionSection />)
    const release = await screen.findByRole('region', { name: '[1.00.00] - 2026-01-01' })

    const links = within(release).getAllByRole('link')
    expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])).toStrictEqual([
      ['Web', 'https://example.com/a', '_blank', 'noopener noreferrer'],
      ['Doc', 'https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/docs/mcp.md#tokens', '_blank', 'noopener noreferrer'],
    ])
    const plain = ['Anchor', 'Mail', 'Up', 'Pic'].filter((text) => within(release).getByText(text).closest('a') !== null)
    expect(plain).toStrictEqual([])
    expect(release.querySelector('b, img')).toBeNull()
  })

  it('offers a retry when the changelog chunk fails to load', async () => {
    loadChangelog.mockRejectedValue(new Error('chunk failed'))
    renderWithQueryClient(<VersionSection />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this section.')
  })
})
