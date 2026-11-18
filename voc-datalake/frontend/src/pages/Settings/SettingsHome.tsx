/**
 * @fileoverview Administration's home (`/admin`, 7.54.00, T1): what an administrator comes to do, by how often.
 *
 * - The header: the page's job in one line, the workspace the app is in (its own settings are on its Workspace
 *   settings page) and the search (SettingsSearch.tsx).
 * - "Needs attention" (`role="status"`, read once, hidden when empty), built from reads the pages make anyway: the
 *   sources a breaker paused (`GET /sources/status`), the people with no way of working saved (`GET /users`), the
 *   AI models this account cannot call (`GET /settings/model/capacity`).
 * - The groups of adminTabs.ts: Everyday as cards with a count (people, sources on and paused, errors in the last
 *   24 hours), the others as one line of links; then what lives elsewhere (Agents › Spend and Connections, Account ›
 *   Preferences) and the footer "Version … · Release notes" (`/admin/version`).
 *
 * Below `lg` this list is Administration's navigation; from `lg` up a tab's page has the same groups on its left.
 *
 * @module pages/Settings/SettingsHome
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, UserPlus } from 'lucide-react'
import { api } from '../../api/client'
import { logsSummaryKey, sourcesStatusKey, usersKey } from '../../api/queryKeys'
import { readStoredAiMode } from '../../api/aiModeApi'
import { isMenuItemEnabled } from '../../config/menuConfig'
import { getEnabledPlugins } from '../../plugins'
import { usePluginCopy } from '../../plugins/pluginCopy'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import { agentsPath } from '../Agents/agentsPaths'
import { accountTabPath } from '../Account/accountSections'
import { PEOPLE_INVITE, adminPath, adminTabPath } from './adminPaths'
import { visibleGroups, visibleSections } from './adminTabs'
import type { AdminGroupId, AdminTabId } from './adminTabs'
import { TAB_ICONS, groupLabelKey, sectionLabelKey, tabHintKey } from './adminTabLabels'
import { BUILD_INFO, paddedVersion } from './buildInfo'
import { isBlockedAccess, useModelCapacity } from './useModelCapacity'
import SettingsSearch from './SettingsSearch'

interface HomeProps {
  readonly isAdmin: boolean
  readonly isPlatformAdmin: boolean
  readonly apiEndpoint: string
}

const JOB_TITLE_KEYS: Readonly<Record<AdminTabId, string>> = {
  people: 'home.jobs.people.title', sources: 'home.jobs.sources.title', logs: 'home.jobs.logs.title',
  categories: 'home.jobs.categories.title', boards: 'home.jobs.boards.title', ai: 'home.jobs.ai.title',
  brand: 'home.jobs.brand.title', privacy: 'home.jobs.privacy.title', platform: 'home.jobs.platform.title',
  version: 'home.jobs.version.title',
}

/** The page's reads, shared (same keys) with the pages that make them; each only where its route lets this caller. */
function useHomeData({ isAdmin, apiEndpoint }: HomeProps) {
  const ready = apiEndpoint !== ''
  const users = useQuery({ queryKey: usersKey(), queryFn: () => api.getUsers(), enabled: ready && isAdmin })
  const sources = useQuery({ queryKey: sourcesStatusKey(), queryFn: () => api.getSourcesStatus(), enabled: ready })
  const errors = useQuery({ queryKey: logsSummaryKey(1), queryFn: () => api.getLogsSummary(1), enabled: ready })
  const capacity = useModelCapacity(ready && isAdmin)
  const plugins = getEnabledPlugins()
  const statusOf = (id: string) => sources.data?.sources[id]
  const pausedSources = plugins.filter((plugin) => statusOf(plugin.id)?.circuit.tripped === true)
  const summary = errors.data?.summary
  return {
    people: users.data?.users,
    waysUnset: (users.data?.users ?? []).filter((user) => user.enabled && !readStoredAiMode(user).saved).length,
    pausedSources: sources.data === undefined ? [] : pausedSources,
    sourcesOn: sources.data === undefined ? undefined : plugins.filter((plugin) => statusOf(plugin.id)?.enabled === true).length,
    errorCount: summary === undefined ? undefined : summary.total_validation_failures + summary.total_processing_errors,
    modelsBlocked: (capacity.data?.models ?? []).filter((row) => isBlockedAccess(row.access?.status ?? 'unknown')).length,
  }
}

type HomeData = ReturnType<typeof useHomeData>

function AttentionItem({ text, action, to }: Readonly<{ text: string; action: string; to: string }>) {
  return (
    <li className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
      <span className="flex items-start gap-2 text-sm text-text">
        <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-warn" aria-hidden="true" />
        {text}
      </span>
      <Link to={to} className="btn btn-secondary btn-sm self-start sm:self-auto">{action}</Link>
    </li>
  )
}

/** "Needs attention": nothing while nothing does; the region is always there, so its content is read once. */
function NeedsAttention({ data }: Readonly<{ data: HomeData }>) {
  const { t } = useTranslation('settings')
  const copy = usePluginCopy()
  const titleId = useId()
  const items: ReactNode[] = []
  if (data.pausedSources.length > 0) {
    const list = data.pausedSources.map((plugin) => copy(plugin).name).join(', ')
    items.push(<AttentionItem key="sources" text={t('home.attention.sourcesPaused', { count: data.pausedSources.length, list })}
      action={t('home.attention.reviewSources')} to={adminTabPath('sources')} />)
  }
  if (data.waysUnset > 0) {
    items.push(<AttentionItem key="ways" text={t('home.attention.waysUnset', { count: data.waysUnset })}
      action={t('home.attention.openPeople')} to={adminTabPath('people')} />)
  }
  if (data.modelsBlocked > 0) {
    items.push(<AttentionItem key="models" text={t('home.attention.modelsBlocked', { count: data.modelsBlocked })}
      action={t('home.attention.openModels')} to={adminTabPath('ai')} />)
  }
  return (
    <div role="status">
      {items.length === 0 ? null : (
        <section aria-labelledby={titleId} className="card border-warn/40">
          <h2 id={titleId} className="text-sm font-semibold tracking-tight text-text-strong">{t('home.attention.title')}</h2>
          <ul className="mt-1 divide-y divide-border">{items}</ul>
        </section>
      )}
    </div>
  )
}

/** An Everyday card's count, or nothing while it is not known. */
function everydayCount(t: (key: string, options?: Record<string, unknown>) => string, tab: AdminTabId, data: HomeData): string | null {
  if (tab === 'people') return data.people === undefined ? null : t('home.counts.people', { count: data.people.length })
  if (tab === 'sources') {
    return data.sourcesOn === undefined ? null : t('home.counts.sources', { on: data.sourcesOn, paused: data.pausedSources.length })
  }
  return tab === 'logs' && data.errorCount !== undefined ? t('home.counts.errors', { count: data.errorCount }) : null
}

/** An Everyday job: a card that is one link (named by its title and count), People with Invite beside it. */
function JobCard({ tab, data }: Readonly<{ tab: AdminTabId; data: HomeData }>) {
  const { t } = useTranslation('settings')
  const titleId = useId()
  const hintId = useId()
  const countId = useId()
  const Icon = TAB_ICONS[tab]
  const count = everydayCount(t, tab, data)
  return (
    <li className="card flex flex-col gap-3">
      <Link to={adminTabPath(tab)} aria-labelledby={count === null ? titleId : `${titleId} ${countId}`} aria-describedby={hintId}
        className="group flex flex-1 flex-col gap-1 rounded-md focus-ring">
        <span className="flex items-center gap-2">
          <Icon size={16} className="text-accent" aria-hidden="true" />
          <span id={titleId} className="font-semibold tracking-tight text-text-strong group-hover:text-accent-text">{t(JOB_TITLE_KEYS[tab])}</span>
        </span>
        <span id={hintId} className="text-sm text-muted">{t(tabHintKey(tab))}</span>
        {count === null ? null : <span id={countId} className="mt-auto pt-2 text-sm font-medium text-text">{count}</span>}
      </Link>
      {tab === 'people' ? (
        <Link to={adminPath({ tab: 'people', section: null }, PEOPLE_INVITE)} className="btn btn-secondary btn-sm self-start">
          <UserPlus size={14} aria-hidden="true" /> {t('home.invite')}
        </Link>
      ) : null}
    </li>
  )
}

/** A group of the home: a heading and its places. */
function Group({ id, children, labelKey }: Readonly<{ id: string; labelKey: string; children: ReactNode }>) {
  const { t } = useTranslation('settings')
  const headingId = `admin-home-${id}`
  return (
    <section aria-labelledby={headingId} className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <h2 id={headingId} className="text-sm font-semibold tracking-tight text-text-strong sm:pt-0.5">{t(labelKey)}</h2>
      {children}
    </section>
  )
}

interface PlaceLink {
  readonly key: string
  readonly to: string
  readonly label: string
}

function LinkLine({ links }: Readonly<{ links: readonly PlaceLink[] }>) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {links.map((link) => (
        <li key={link.key}><Link to={link.to} className="link">{link.label}</Link></li>
      ))}
    </ul>
  )
}

/** A group's places as links: its tabs, and on "Set up once" the Data sources cards that are set up once too. */
function groupLinks(t: (key: string) => string, group: { id: AdminGroupId; tabs: readonly AdminTabId[] }, isAdmin: boolean,
  isPlatformAdmin: boolean): PlaceLink[] {
  const tabs = group.tabs.map((tab) => ({ key: tab, to: adminTabPath(tab), label: t(JOB_TITLE_KEYS[tab]) }))
  if (group.id !== 'once') return tabs
  const cards = visibleSections('sources', isAdmin, isPlatformAdmin).map((section) => ({
    key: `sources/${section}`, to: adminPath({ tab: 'sources', section }), label: t(sectionLabelKey(section)),
  }))
  return [...tabs, ...cards]
}

function Elsewhere() {
  const { t } = useTranslation('settings')
  const agents = isMenuItemEnabled('agents')
  const links: PlaceLink[] = [
    ...(agents ? [
      { key: 'spend', to: agentsPath({ view: 'spend' }), label: t('home.elsewhere.cost') },
      { key: 'connections', to: agentsPath({ view: 'connections' }), label: t('home.elsewhere.github') },
    ] : []),
    { key: 'preferences', to: accountTabPath('preferences'), label: t('home.elsewhere.preferences') },
  ]
  return <Group id="elsewhere" labelKey="home.groups.elsewhere"><LinkLine links={links} /></Group>
}

function WorkspaceLine() {
  const workspace = useCurrentWorkspace()
  if (workspace === null) return null
  return (
    <p className="mt-2 text-sm text-text">
      <Trans i18nKey="home.inWorkspace" ns="settings" values={{ name: workspace.name }}
        components={{ settings: <Link to="/workspace-settings" className="link" /> }} />
    </p>
  )
}

export default function SettingsHome(props: HomeProps) {
  const { t } = useTranslation('settings')
  const { isAdmin, isPlatformAdmin } = props
  const data = useHomeData(props)
  const groups = visibleGroups(isAdmin, isPlatformAdmin)
  return (
    <div className="max-w-5xl mx-auto min-w-0 w-full space-y-6 sm:space-y-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('title')}</h1>
          <p className="mt-1 max-w-prose text-sm text-muted">{t('subtitle')}</p>
          <WorkspaceLine />
        </div>
        <SettingsSearch isAdmin={isAdmin} isPlatformAdmin={isPlatformAdmin} className="w-full lg:w-80" />
      </header>
      <NeedsAttention data={data} />
      {groups.map((group) => (
        <Group key={group.id} id={group.id} labelKey={groupLabelKey(group.id)}>
          {group.id === 'everyday' ? (
            <ul className="grid gap-3 sm:grid-cols-3">{group.tabs.map((tab) => <JobCard key={tab} tab={tab} data={data} />)}</ul>
          ) : <LinkLine links={groupLinks(t, group, isAdmin, isPlatformAdmin)} />}
        </Group>
      ))}
      <Elsewhere />
      {isAdmin ? (
        <footer className="border-t border-border pt-4 text-sm text-muted">
          <Trans i18nKey="home.version" ns="settings" values={{ version: paddedVersion(BUILD_INFO.version) }}
            components={{ notes: <Link to={adminTabPath('version')} className="link" /> }} />
        </footer>
      ) : null}
    </div>
  )
}

