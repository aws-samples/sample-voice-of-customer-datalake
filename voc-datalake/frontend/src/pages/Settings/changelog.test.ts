import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveChangelogLink, splitReleases } from './changelog'
import { loadChangelog } from './changelogSource'
import { paddedVersion, formatBuildTime } from './buildInfo'

describe('splitReleases', () => {
  it('keeps an Unreleased section that has content', () => {
    expect(splitReleases('## [Unreleased]\n\n- Pending.\n## [1.00.00]\n- Done.')).toStrictEqual([
      { heading: '[Unreleased]', body: '- Pending.' },
      { heading: '[1.00.00]', body: '- Done.' },
    ])
  })

  it('loads the real CHANGELOG.md and splits it into releases, newest first, with the current version on top', async () => {
    const source = await loadChangelog()
    const rootPackage: unknown = JSON.parse(readFileSync(join(__dirname, '../../../../../package.json'), 'utf8'))
    const rootVersion = typeof rootPackage === 'object' && rootPackage !== null && 'version' in rootPackage ? rootPackage.version : null
    const releases = splitReleases(source)

    expect(releases.length).toBeGreaterThan(10)
    expect(releases[0]?.heading.startsWith(`[${paddedVersion(String(rootVersion))}]`)).toBe(true)
    expect(releases.some((r) => /unreleased/i.test(r.heading))).toBe(false)
  })
})

describe('resolveChangelogLink', () => {
  it.each([
    ['https://example.com', { kind: 'external', href: 'https://example.com' }],
    ['./CONTRIBUTING.md', { kind: 'external', href: 'https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/CONTRIBUTING.md' }],
    ['javascript:alert(1)', { kind: 'text' }],
    ['//evil.example', { kind: 'text' }],
    ['/admin', { kind: 'text' }],
    ['docs/../../x', { kind: 'text' }],
    [undefined, { kind: 'text' }],
  ])('%s', (href, expected) => {
    expect(resolveChangelogLink(href)).toStrictEqual(expected)
  })
})

describe('build stamps', () => {
  it('pads minor and patch to two digits and leaves non-SemVer as is', () => {
    expect([paddedVersion('3.12.0'), paddedVersion('10.1.12'), paddedVersion('unknown')]).toStrictEqual(['3.12.00', '10.01.12', 'unknown'])
  })

  it('formats the build time in UTC and passes an unparseable stamp through', () => {
    expect([formatBuildTime('2026-10-09T23:59:30.000Z'), formatBuildTime('unknown')]).toStrictEqual(['2026-10-09 23:59 UTC', 'unknown'])
  })
})
