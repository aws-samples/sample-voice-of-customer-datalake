/**
 * @fileoverview The Account page's tab bar: the design-system tabs track
 * (`tabs-rail` / `tabs-track` / `tab`, as on Company, Memory and the project
 * pages), one tab per `?tab=<id>`. A switch replaces the query, like the
 * other pages' tabs, so each tab is a deep link without filling the history;
 * only `tab` changes, so an open review modal (`?review=`) survives.
 * @module pages/Account/AccountNav
 */
import clsx from 'clsx'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { KeyRound, SlidersHorizontal, Sunrise, Target, UserRound } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { withOwnedParams } from '../../utils/searchParams'
import type { AccountTabId } from './accountSections'

/**
 * The tabs, in order: each tab's icon and its `common:account.tabs.*` label
 * key, spelled out so the i18n audit sees every key.
 */
const TABS: readonly (readonly [AccountTabId, LucideIcon, string])[] = [
  ['profile', UserRound, 'account.tabs.profile'],
  ['preferences', SlidersHorizontal, 'account.tabs.preferences'],
  ['briefing', Sunrise, 'account.tabs.briefing'],
  ['objectives', Target, 'account.tabs.objectives'],
  ['access', KeyRound, 'account.tabs.access'],
]

export default function AccountNav({ active }: Readonly<{ active: AccountTabId }>) {
  const { t } = useTranslation('common')
  const [, setSearchParams] = useSearchParams()
  return (
    <div className="tabs-rail overflow-x-auto">
      <div className="tabs-track" role="tablist" aria-label={t('account.tabsLabel')}>
        {TABS.map(([id, Icon, labelKey]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === active}
            onClick={() => { setSearchParams((current) => withOwnedParams(current, ['tab'], new URLSearchParams({ tab: id })), { replace: true }) }}
            className={clsx('tab', id === active && 'tab-active')}
          >
            <Icon size={14} aria-hidden="true" /> {t(labelKey)}
          </button>
        ))}
      </div>
    </div>
  )
}
