/**
 * @fileoverview Administration (was Settings) — admin-only operational configuration at `/admin` (`/settings`
 * redirects here), 7.54.00: a home and nine tabs, ordered by the job an administrator comes to do and how often
 * (adminTabs.ts, docs/account-vs-admin.md):
 *
 * - the home (`/admin`, SettingsHome.tsx): search, "Needs attention", the groups, the version;
 * - Everyday: People · Data sources · Logs; Regularly: Categories · Feedback boards; Set up once: AI models · Brand &
 *   appearance; Rare: Privacy · Platform (platform admins); and Version, from the home's footer.
 *
 * A tab is one page (`/admin/<tab>`), its sections cards on it (`/admin/<tab>/<section>` focuses one), under a header
 * with "← Administration", the tab's name and its job; from `lg` up the groups are on its left (AdminNav.tsx). Every
 * card saves itself: there is no page-level Save. `/` focuses the search on these pages.
 *
 * @module pages/Settings
 */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useConfigStore } from '../../store/configStore'
import { useIsAdmin, useIsPlatformAdmin } from '../../store/authStore'
import AdminSectionContent from './AdminSectionContent'
import AdminNav from './AdminNav'
import SettingsHome from './SettingsHome'
import { SETTINGS_SEARCH_ID } from './SettingsSearch'
import { ADMIN_PATH } from './adminPaths'
import type { AdminTabId } from './adminTabs'
import { tabHintKey, tabLabelKey } from './adminTabLabels'
import { useAdminLocation, useSectionFocus } from './useAdminLocation'
import { useApiEndpointField } from './useSettingsSync'

/** Whether a key pressed in `target` is typing (an input, a text area, an editable region), not a shortcut. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/** `/` focuses the search (Administration's pages only: the listener goes with the page). ⌘K stays untouched. */
function useSlashFocus(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
      const search = document.getElementById(SETTINGS_SEARCH_ID)
      if (search === null) return
      event.preventDefault()
      search.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}

function TabHeader({ tab }: Readonly<{ tab: AdminTabId }>) {
  const { t } = useTranslation('settings')
  return (
    <header className="mb-6">
      <Link to={ADMIN_PATH} className="link inline-flex items-center gap-1 text-sm">
        <ArrowLeft size={14} aria-hidden="true" /> {t('title')}
      </Link>
      <h1 className="mt-1 text-2xl font-bold tracking-tight text-text-strong">{t(tabLabelKey(tab))}</h1>
      <p className="mt-1 max-w-prose text-sm text-muted">{t(tabHintKey(tab))}</p>
    </header>
  )
}

export default function Settings() {
  const { config, setConfig } = useConfigStore()
  const isAdmin = useIsAdmin()
  const isPlatformAdmin = useIsPlatformAdmin()
  const { place } = useAdminLocation(isAdmin, isPlatformAdmin)
  // The field follows the stored endpoint and pushes a runtime config's into the store (useSettingsSync.ts).
  const { apiEndpoint, setApiEndpoint } = useApiEndpointField(config.apiEndpoint, setConfig)
  useSlashFocus()
  useSectionFocus(place.section)

  if (place.tab === null) return <SettingsHome isAdmin={isAdmin} isPlatformAdmin={isPlatformAdmin} apiEndpoint={apiEndpoint} />
  return (
    // min-w-0: inside the shell's flex column, a wide child (the logs tab track) would otherwise stretch the page past
    // 390px instead of scrolling itself.
    <div className="max-w-6xl mx-auto min-w-0 w-full">
      <TabHeader tab={place.tab} />
      <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-8">
        <AdminNav active={place.tab} isAdmin={isAdmin} isPlatformAdmin={isPlatformAdmin} />
        <div className="min-w-0 space-y-4 sm:space-y-6">
          <AdminSectionContent tab={place.tab} section={place.section} apiEndpoint={apiEndpoint}
            onApiEndpointChange={setApiEndpoint} isAdmin={isAdmin} isPlatformAdmin={isPlatformAdmin} />
        </div>
      </div>
    </div>
  )
}
