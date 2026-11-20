/**
 * @fileoverview Administration's search (7.54.00; 7.59.00 in the page's header): a WAI-ARIA combobox (APG "list
 * autocomplete") over settingsIndex.ts.
 *
 * - Typing lists the matching places in a listbox ("Radar in Sources"); the count is announced in a polite status
 *   ("3 settings found", or "No setting matches …").
 * - ArrowDown / ArrowUp move the active option (`aria-activedescendant`, focus stays in the input), Enter or a click
 *   opens its address: the tab and section, and a card is then scrolled into view and focused (Settings.tsx); Escape
 *   clears the query.
 * - `/` focuses it on Administration (Settings.tsx `useSlashFocus`); ⌘K is left alone.
 *
 * @module pages/Settings/SettingsSearch
 */
import clsx from 'clsx'
import { useId, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import { searchSettings, settingsIndex } from './settingsIndex'
import type { ResolvedEntry } from './settingsIndex'
import type { AdminViewer } from './adminTabs'

/** The input's id: `/` focuses it. */
export const SETTINGS_SEARCH_ID = 'admin-settings-search'

function useResolvedIndex(viewer: AdminViewer): ResolvedEntry[] {
  const { t } = useTranslation('settings')
  const { isAdmin, isPlatformAdmin, inWorkspace, agentsShown } = viewer
  return useMemo(() => settingsIndex({ isAdmin, isPlatformAdmin, inWorkspace, agentsShown }).map((entry) => ({
    entry, title: t(entry.titleKey), place: entry.placeKey === null ? null : t(entry.placeKey),
    terms: entry.termsKey === null ? '' : t(entry.termsKey),
  })), [t, isAdmin, isPlatformAdmin, inWorkspace, agentsShown])
}

/** The polite announcement of what the list holds (nothing while the query is empty). */
function countText(t: (key: string, options?: Record<string, unknown>) => string, query: string, count: number): string {
  if (query.trim() === '') return ''
  return count === 0 ? t('search.empty', { q: query.trim() }) : t('search.count', { count })
}

export default function SettingsSearch({ viewer, className }: Readonly<{
  viewer: AdminViewer
  className?: string
}>) {
  const { t } = useTranslation('settings')
  const navigate = useNavigate()
  const index = useResolvedIndex(viewer)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const listId = useId()
  const results = searchSettings(index, query)
  const expanded = open && results.length > 0
  const optionId = (position: number) => `${listId}-${position}`

  const choose = (resolved: ResolvedEntry | undefined) => {
    if (resolved === undefined) return
    setQuery('')
    setOpen(false)
    void navigate(resolved.entry.path)
  }
  const step = (by: number) => {
    setOpen(true)
    setActive((current) => (results.length === 0 ? 0 : (current + by + results.length) % results.length))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const handlers: Readonly<Record<string, () => void>> = {
      ArrowDown: () => step(expanded ? 1 : 0),
      ArrowUp: () => step(-1),
      Enter: () => { if (expanded) choose(results[active]) },
      Escape: () => { setQuery(''); setOpen(false) },
    }
    const handler = handlers[event.key]
    if (handler === undefined) return
    event.preventDefault()
    handler()
  }

  return (
    <div className={clsx('relative', className)}>
      <label htmlFor={SETTINGS_SEARCH_ID} className="sr-only">{t('search.label')}</label>
      <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
      <input
        id={SETTINGS_SEARCH_ID}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded ? optionId(active) : undefined}
        value={query}
        placeholder={t('search.placeholder')}
        onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true) }}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="input pl-8 pr-8"
      />
      <kbd aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-sm border border-border px-1.5 font-mono text-[11px] text-muted">/</kbd>
      <ul id={listId} role="listbox" aria-label={t('search.label')} hidden={!expanded}
        className="menu absolute left-0 right-0 z-20 mt-1 max-h-80 overflow-y-auto">
        {results.map((resolved, position) => (
          <li
            key={resolved.entry.id}
            id={optionId(position)}
            role="option"
            aria-selected={position === active}
            // mousedown, not click: the input's blur would close the list before a click landed.
            onMouseDown={(event) => { event.preventDefault(); choose(resolved) }}
            onMouseEnter={() => setActive(position)}
            className={clsx('menu-item cursor-pointer', position === active && 'bg-bg-hover')}
          >
            {resolved.place === null ? resolved.title : t('search.result', { title: resolved.title, tab: resolved.place })}
          </li>
        ))}
      </ul>
      {/* Seen, not heard twice: the status below says it. */}
      {open && query.trim() !== '' && results.length === 0 ? (
        <p aria-hidden="true" className="menu absolute left-0 right-0 z-20 mt-1 px-3 py-2 text-sm text-muted">
          {t('search.empty', { q: query.trim() })}
        </p>
      ) : null}
      <p role="status" className="sr-only">{countText(t, query, results.length)}</p>
    </div>
  )
}
