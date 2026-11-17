/**
 * @fileoverview Administration's left navigation on a tab's page (7.54.00): the home's groups (Everyday, Regularly,
 * Set up once, Rare; adminTabs.ts `visibleGroups`), each a labelled list of its tabs' links, the open one
 * `aria-current="page"`. Shown from `lg` up; below it each page has "← Administration" and the home's list is the
 * navigation (T5: no custom mobile dropdown). The search sits on top, `/` focusing it.
 * @module pages/Settings/AdminNav
 */
import clsx from 'clsx'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { adminTabPath } from './adminPaths'
import { visibleGroups } from './adminTabs'
import type { AdminGroupId, AdminTabId } from './adminTabs'
import { TAB_ICONS, groupLabelKey, tabLabelKey } from './adminTabLabels'
import SettingsSearch from './SettingsSearch'

const ITEM = 'flex items-center gap-2.5 rounded-md border border-transparent px-3 py-2 text-sm font-medium transition-colors'

function NavGroup({ id, tabs, active }: Readonly<{ id: AdminGroupId; tabs: readonly AdminTabId[]; active: AdminTabId }>) {
  const { t } = useTranslation('settings')
  const labelId = useId()
  return (
    <div>
      <h2 id={labelId} className="px-3 pb-1 pt-4 text-[0.6875rem] font-semibold uppercase tracking-[.08em] text-muted-strong">
        {t(groupLabelKey(id))}
      </h2>
      <ul aria-labelledby={labelId}>
        {tabs.map((tab) => {
          const Icon = TAB_ICONS[tab]
          const current = tab === active
          return (
            <li key={tab}>
              <Link to={adminTabPath(tab)} aria-current={current ? 'page' : undefined}
                className={clsx(ITEM, current ? 'nav-active' : 'text-muted hover:bg-bg-hover hover:text-text')}>
                <Icon size={16} className="flex-shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 break-words">{t(tabLabelKey(tab))}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default function AdminNav({ active, isAdmin, isPlatformAdmin }: Readonly<{
  active: AdminTabId
  isAdmin: boolean
  isPlatformAdmin: boolean
}>) {
  const { t } = useTranslation('settings')
  return (
    <nav aria-label={t('title')} className="hidden lg:block lg:sticky lg:top-4 space-y-2">
      <SettingsSearch isAdmin={isAdmin} isPlatformAdmin={isPlatformAdmin} />
      {visibleGroups(isAdmin, isPlatformAdmin).map((group) => (
        <NavGroup key={group.id} id={group.id} tabs={group.tabs} active={active} />
      ))}
    </nav>
  )
}
