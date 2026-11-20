/**
 * @fileoverview Administration (was Settings) — admin-only operational configuration at `/admin` (`/settings`
 * redirects here). 7.59.00: main's tabbed layout again, with everything voc-multiplayer added since put in the tab it
 * belongs to (adminTabs.ts; the mapping in docs/account-vs-admin.md):
 *
 * - the header: "Administration", its one line, the workspace the app is in, and the search (SettingsSearch.tsx;
 *   `/` focuses it);
 * - the tab row (from `md`: a WAI-ARIA tablist that scrolls sideways when it does not fit, IconTabs; below `md`: a
 *   select), each tab with a count badge when something on it needs attention (useAdminAttention.ts);
 * - the open tab's panel: its one line, on General the "Needs attention" strip, on a tab with sections the section
 *   switch (SectionSwitch.tsx), then the section. The page scrolls; nothing in it scrolls on its own but wide tables.
 *
 * Every card saves itself (its own Save and "Saved"); its unsaved-changes guard asks before its section (General's
 * brand and theme: the tab) is left.
 *
 * @module pages/Settings
 */
import { useEffect, useId } from 'react'
import type { ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { IconTabs } from '../../components/IconTabs/IconTabs'
import { useConfigStore } from '../../store/configStore'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import AdminSectionContent from './AdminSectionContent'
import { AttentionStrip } from './AdminAttention'
import { useAdminAttention } from './useAdminAttention'
import type { AdminAttention } from './useAdminAttention'
import SettingsSearch, { SETTINGS_SEARCH_ID } from './SettingsSearch'
import { SectionSwitch } from './SectionSwitch'
import { adminPath } from './adminPaths'
import type { AdminPlace } from './adminPaths'
import { visibleSections, visibleTabs } from './adminTabs'
import type { AdminTabId, AdminViewer } from './adminTabs'
import {
  SECTION_ICONS, SECTION_PANEL_ID, TAB_ICONS, TAB_PANEL_ID, sectionLabelKey, sectionTabId, tabButtonId, tabHintKey,
  tabLabelKey,
} from './adminTabLabels'
import { useAdminLocation, useAdminViewer, useCardFocus } from './useAdminLocation'
import { useApiEndpointField } from './useSettingsSync'

/** Whether a key pressed in `target` is typing (an input, a text area, an editable region), not a shortcut. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/** `/` focuses the search (Administration only: the listener goes with the page). ⌘K stays untouched. */
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

/** "In workspace X": its own settings are Workspaces → This workspace (for whoever sees that section). */
function WorkspaceLine({ viewer }: Readonly<{ viewer: AdminViewer }>) {
  const workspace = useCurrentWorkspace()
  if (workspace === null || !visibleSections('workspaces', viewer).includes('settings')) return null
  return (
    <p className="mt-2 text-sm text-text">
      <Trans i18nKey="header.inWorkspace" ns="settings" values={{ name: workspace.name }}
        components={{ settings: <Link to={adminPath({ tab: 'workspaces', section: 'settings' })} className="link" /> }} />
    </p>
  )
}

function Header({ viewer }: Readonly<{ viewer: AdminViewer }>) {
  const { t } = useTranslation('settings')
  return (
    <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('title')}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">{t('subtitle')}</p>
        <WorkspaceLine viewer={viewer} />
      </div>
      <SettingsSearch viewer={viewer} className="w-full md:w-72 md:flex-shrink-0" />
    </header>
  )
}

/** A tab's label in the row: its name, and a count badge (said in words to a screen reader) when it needs attention. */
function TabLabel({ tab, count }: Readonly<{ tab: AdminTabId; count: number }>) {
  const { t } = useTranslation('settings')
  return (
    <>
      <span>{t(tabLabelKey(tab))}</span>
      {count > 0 && (
        <>
          <span aria-hidden="true" className="badge badge-warn px-1.5 py-0 font-mono text-[11px] leading-4">{count}</span>
          <span className="sr-only">{`, ${t('attention.badge', { count })}`}</span>
        </>
      )}
    </>
  )
}

/** The tabs: a tablist from `md` up (scrolling sideways when it must), a select below it. */
function TabRow({ tabs, active, attention, onSelect }: Readonly<{
  tabs: readonly AdminTabId[]; active: AdminTabId; attention: AdminAttention; onSelect: (tab: AdminTabId) => void
}>) {
  const { t } = useTranslation('settings')
  const selectId = useId()
  const optionText = (tab: AdminTabId) => {
    const count = attention.countOf(tab)
    const label = t(tabLabelKey(tab))
    return count === 0 ? label : t('attention.option', { tab: label, count })
  }
  return (
    <div className="mb-4">
      <div className="md:hidden">
        {/* (the select shows the open tab: its name is for a screen reader) */}
        <label htmlFor={selectId} className="sr-only">{t('tabsLabel')}</label>
        <select id={selectId} className="select w-full" value={active}
          onChange={(event) => { const tab = tabs.find((id) => id === event.target.value); if (tab !== undefined) onSelect(tab) }}>
          {tabs.map((tab) => <option key={tab} value={tab}>{optionText(tab)}</option>)}
        </select>
      </div>
      <div className="hidden md:block">
        <IconTabs tabs={tabs} active={active} icons={TAB_ICONS} label={t('tabsLabel')} onSelect={onSelect}
          labelOf={(tab) => <TabLabel tab={tab} count={attention.countOf(tab)} />}
          scrollLabels={{ start: t('tabsScrollStart'), end: t('tabsScrollEnd') }}
          panel={{ id: TAB_PANEL_ID, tabId: tabButtonId }} />
      </div>
    </div>
  )
}

/** A tab with sections: its switch, then the section's panel, labelled by the section's tab. */
function Sections({ place, viewer, onSelect, children }: Readonly<{
  place: AdminPlace; viewer: AdminViewer; onSelect: (section: NonNullable<AdminPlace['section']>) => void; children: ReactNode
}>) {
  const { t } = useTranslation('settings')
  const ids = visibleSections(place.tab, viewer)
  if (place.section === null || ids.length < 2) return <div className="space-y-4 sm:space-y-6">{children}</div>
  return (
    <>
      <SectionSwitch sections={ids} icons={SECTION_ICONS} labelOf={(id) => t(sectionLabelKey(id))} active={place.section}
        onSelect={onSelect} label={t(tabLabelKey(place.tab))} tabId={sectionTabId} />
      <div id={SECTION_PANEL_ID} role="tabpanel" aria-labelledby={sectionTabId(place.section)} className="space-y-4 sm:space-y-6">
        {children}
      </div>
    </>
  )
}

export default function Settings() {
  const { t } = useTranslation('settings')
  const { config, setConfig } = useConfigStore()
  const viewer = useAdminViewer()
  const { place, selectTab, selectSection } = useAdminLocation(viewer)
  // The field follows the stored endpoint and pushes a runtime config's into the store (useSettingsSync.ts).
  const { apiEndpoint, setApiEndpoint } = useApiEndpointField(config.apiEndpoint, setConfig)
  const attention = useAdminAttention(viewer.isAdmin, apiEndpoint)
  useSlashFocus()
  useCardFocus(place.card)
  const tabs = visibleTabs(viewer)

  return (
    // min-w-0: inside the shell's flex column, a wide child (the logs tables) would otherwise stretch the page past
    // 390px instead of scrolling itself.
    <div className="max-w-5xl mx-auto min-w-0 w-full">
      <Header viewer={viewer} />
      <TabRow tabs={tabs} active={place.tab} attention={attention} onSelect={selectTab} />
      <div id={TAB_PANEL_ID} role="tabpanel" aria-labelledby={tabButtonId(place.tab)} className="min-w-0">
        <p className="mb-4 max-w-prose text-sm text-muted sm:mb-6">{t(tabHintKey(place.tab))}</p>
        {place.tab === 'general' ? <AttentionStrip attention={attention} /> : null}
        <Sections place={place} viewer={viewer} onSelect={selectSection}>
          <AdminSectionContent place={place} viewer={viewer} apiEndpoint={apiEndpoint} onApiEndpointChange={setApiEndpoint} />
        </Sections>
      </div>
    </div>
  )
}
