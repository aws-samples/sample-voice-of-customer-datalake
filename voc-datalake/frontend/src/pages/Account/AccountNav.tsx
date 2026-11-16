/**
 * @fileoverview The Account page's tab bar: the design-system tabs track
 * (`tabs-rail` / `tabs-track` / `tab`, as on Company, Memory and the project
 * pages), one tab per path `/account/<id>`. A switch is a history entry of
 * its own (Back returns to the previous tab), and the query is kept, so an
 * open review modal (`?review=`) survives.
 * @module pages/Account/AccountNav
 */
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { KeyRound, SlidersHorizontal, Sunrise, Target, UserRound } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
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

export default function AccountNav({ active, onSelect }: Readonly<{ active: AccountTabId; onSelect: (tab: AccountTabId) => void }>) {
  const { t } = useTranslation('common')
  return (
    <div className="tabs-rail overflow-x-auto">
      <div className="tabs-track" role="tablist" aria-label={t('account.tabsLabel')}>
        {TABS.map(([id, Icon, labelKey]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === active}
            onClick={() => { onSelect(id) }}
            className={clsx('tab', id === active && 'tab-active')}
          >
            <Icon size={14} aria-hidden="true" /> {t(labelKey)}
          </button>
        ))}
      </div>
    </div>
  )
}
