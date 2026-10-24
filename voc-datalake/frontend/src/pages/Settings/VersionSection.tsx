/**
 * @fileoverview Administration → System → Version: the build stamps (platform version,
 * git commit, build time) and the release notes from CHANGELOG.md, which is
 * loaded only when this tab opens and rendered a page of releases at a time.
 *
 * @module pages/Settings/VersionSection
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronDown, History, Info } from 'lucide-react'
import { QueryState, SectionHeader } from '../Company/ContextParts'
import { BUILD_INFO, formatBuildTime, paddedVersion, type BuildInfo } from './buildInfo'
import { splitReleases } from './changelog'
import { loadChangelog } from './changelogSource'
import ChangelogMarkdown from './ChangelogMarkdown'

/** Releases rendered at first and added per "Show older releases". */
const RELEASES_PAGE_SIZE = 10

function VersionCard({ info }: Readonly<{ info: BuildInfo }>) {
  const { t } = useTranslation('settings')
  const rows: readonly (readonly [string, string])[] = [
    [t('version.platform'), paddedVersion(info.version)],
    [t('version.commit'), info.commit],
    [t('version.builtAt'), formatBuildTime(info.builtAt)],
  ]
  return (
    <div className="card">
      <SectionHeader icon={Info} title={t('version.title')} description={t('version.description')} />
      <dl className="grid gap-3 sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-md border border-border bg-bg-accent px-3 py-2">
            <dt className="text-[0.6875rem] font-semibold uppercase tracking-[.04em] text-muted-strong">{label}</dt>
            <dd className="font-mono text-sm text-text-strong break-all">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function ChangelogPanel() {
  const { t } = useTranslation('settings')
  const query = useQuery({ queryKey: ['settings', 'changelog'], queryFn: loadChangelog, staleTime: Infinity })
  const releases = useMemo(() => (query.data === undefined ? [] : splitReleases(query.data)), [query.data])
  const [shown, setShown] = useState(RELEASES_PAGE_SIZE)
  const visible = releases.slice(0, shown)
  return (
    <div className="card">
      <SectionHeader icon={History} title={t('version.changelogTitle')} description={t('version.changelogDescription')} />
      <QueryState isLoading={query.isLoading} isError={query.isError} onRetry={() => void query.refetch()} />
      <div className="divide-y divide-border">
        {visible.map((release) => (
          <section key={release.heading} aria-label={release.heading} className="py-4 first:pt-0">
            <h3 className="font-mono text-sm font-semibold text-text-strong mb-2">{release.heading}</h3>
            <ChangelogMarkdown source={release.body} />
          </section>
        ))}
      </div>
      {releases.length > shown ? (
        <button type="button" onClick={() => setShown(shown + RELEASES_PAGE_SIZE)} className="btn btn-secondary btn-sm mt-4 flex items-center gap-1.5">
          <ChevronDown size={14} /> {t('version.showOlder', { count: releases.length - shown })}
        </button>
      ) : null}
    </div>
  )
}

export default function VersionSection() {
  return (
    <>
      <VersionCard info={BUILD_INFO} />
      <ChangelogPanel />
    </>
  )
}
