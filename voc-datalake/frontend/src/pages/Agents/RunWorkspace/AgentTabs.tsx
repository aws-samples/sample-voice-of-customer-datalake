/**
 * @fileoverview The open sessions as tabs (7.51.00, the default; KiroCrew's SessionTabStrip, adapted in
 * agentGridModel.ts). (7.54.00, the owner: "the x is not clear it's for the tabs") One tab bar in the app's tabs
 * recipe (`tabs-track`, `tab`, `tab-active`), every tab with its own close:
 *
 * - **Each tab closes itself.** Its × sits inside the tab, after its name, with "Close <session>" as its Tooltip; on
 *   the keyboard Delete (or Backspace) closes the tab in focus, as the WAI-ARIA tabs pattern's optional Delete says,
 *   and the tab says so to a screen reader (`aria-keyshortcuts`, its description). The × is part of the tab and
 *   hidden from assistive tech: a button inside a tab is nested interactive content, and one beside it inside the
 *   tablist is a child a tablist may not hold (axe `nested-interactive`, `aria-required-children`), so nothing but
 *   tabs sits in the tablist.
 * - **The keyboard** is the pattern's, with manual activation (opening a session moves the address): one Tab stop,
 *   Left and Right move between the tabs (round), Home and End to the first and the last, Enter or Space opens one.
 * - **Overflow is visible**: the strip scrolls sideways, a fade marks the side that is cut, and two scroll buttons show
 *   while it overflows (the one whose side is all in view off); the tab shown, and a tab in focus, are scrolled into
 *   view clear of the fade (`.tab-strip`'s scroll padding; components/TabStrip, shared with the form builder's tabs).
 * - **"Open…"** at the end of the strip, a menu of every agent of the run not open yet (RowActionsMenu's text face).
 *
 * The tab panel is SessionsPane's, named by the tab shown.
 *
 * @module pages/Agents/RunWorkspace/AgentTabs
 */
import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { Bot, Loader2, Plus, Workflow, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { RowActionsMenu } from '../../../components/RowActionsMenu/RowActionsMenu'
import { StripScrollButton } from '../../../components/TabStrip/StripScrollButton'
import { revealInStrip, scrollStrip, useStripCut } from '../../../components/TabStrip/tabStrip'
import { Tooltip } from '../../../components/Tooltip/Tooltip'
import { TruncatedText } from '../../../components/Tooltip/TruncatedText'
import { useSessionName } from './useSessionLayout'
import type { KeyboardEvent, MouseEvent } from 'react'
import type { EngineeringAgent } from '../../../api/engineeringRunsApi'

interface Props {
  tabs: readonly string[]
  current: string | null
  agents: readonly EngineeringAgent[]
  orchestrator: string | null
  onOpen: (agent: string) => void
  onClose: (agent: string) => void
  /** The id of the tab panel the tabs control (SessionsPane's), and the prefix of each tab's own id. */
  panelId: string
  tabId: (agent: string) => string
}

/** The keys that move between the tabs: to the tab `by` away (round), or to an end. */
const MOVES: Readonly<Record<string, (index: number, count: number) => number>> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
}
const CLOSE_KEYS: ReadonlySet<string> = new Set(['Delete', 'Backspace'])

export function AgentTabs({ tabs, current, agents, orchestrator, onOpen, onClose, panelId, tabId }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const hintId = useId()
  const nameOf = useSessionName(orchestrator)
  const [strip, setStrip] = useState<HTMLDivElement | null>(null)
  const cut = useStripCut(strip)
  const overflowing = cut.start || cut.end
  const refs = useRef(new Map<string, HTMLButtonElement>())
  // A tab closed from the keyboard hands its focus to the tab now in its place (once the tabs re-render).
  const focusNext = useRef<string | null>(null)
  const others = agents.filter((agent) => !tabs.includes(agent.agent))
  const working = new Set(agents.filter((agent) => agent.status === 'working').map((agent) => agent.agent))
  const selected = current !== null && tabs.includes(current) ? current : tabs[0] ?? null

  useEffect(() => {
    const next = focusNext.current
    if (next === null) return
    focusNext.current = null
    refs.current.get(next)?.focus()
  })
  useEffect(() => {
    // (the tab shown in view: one opened from the canvas, the menu or the address may be past the cut)
    if (selected !== null) revealInStrip(strip, refs.current.get(selected))
  }, [selected, strip])

  const close = (agent: string, fromKeyboard: boolean) => {
    const index = tabs.indexOf(agent)
    const rest = tabs.filter((tab) => tab !== agent)
    onClose(agent)
    if (fromKeyboard) focusNext.current = rest[Math.min(index, rest.length - 1)] ?? null
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, agent: string) => {
    const index = tabs.indexOf(agent)
    const move = MOVES[event.key]
    if (move !== undefined && tabs.length > 0) {
      event.preventDefault()
      const next = tabs[move(index, tabs.length)]
      const tab = next === undefined ? undefined : refs.current.get(next)
      tab?.focus()
      revealInStrip(strip, tab)
      return
    }
    if (CLOSE_KEYS.has(event.key)) {
      event.preventDefault()
      close(agent, true)
    }
  }
  const onTabClick = (event: MouseEvent<HTMLButtonElement>, agent: string) => {
    // (a press on the tab's own ×: it closes, and opens nothing)
    if (event.target instanceof Element && event.target.closest('[data-tab-close]') !== null) close(agent, false)
    else onOpen(agent)
  }

  return (
    <div className="flex min-w-0 items-center gap-1 border-b border-border px-2 py-1.5">
      <span id={hintId} className="sr-only">{t('runWorkspace.sessions.closeHint')}</span>
      {overflowing && <StripScrollButton side="start" label={t('runWorkspace.sessions.scrollStart')} cut={cut.start} onPress={() => scrollStrip(strip, -1)} />}
      <div ref={setStrip} data-cut-start={cut.start} data-cut-end={cut.end}
        className="tab-strip min-w-0 flex-1">
        <div role="tablist" aria-label={t('runWorkspace.sessions.tabs')}
          className="tabs-track w-max max-w-none overflow-visible">
          {tabs.map((tab) => {
            const name = nameOf(tab)
            const shown = tab === selected
            const Icon = tab === orchestrator ? Workflow : Bot
            return (
              <button key={tab} ref={(node) => { if (node === null) refs.current.delete(tab); else refs.current.set(tab, node) }}
                type="button" role="tab" id={tabId(tab)} aria-selected={shown} aria-controls={panelId}
                tabIndex={shown ? 0 : -1} aria-keyshortcuts="Delete" aria-describedby={hintId}
                className={clsx('tab group max-w-[14rem] pr-1', shown && 'tab-active')}
                onClick={(event) => onTabClick(event, tab)} onKeyDown={(event) => onKeyDown(event, tab)}>
                <Icon size={14} aria-hidden="true" className="shrink-0" />
                <TruncatedText as="span" className="min-w-0 truncate" text={name} />
                {working.has(tab) && <Loader2 size={12} className="shrink-0 animate-spin text-accent-text" aria-label={t('runWorkspace.working')} />}
                <Tooltip kind="label" content={t('runWorkspace.sessions.close', { name })}>
                  <span data-tab-close aria-hidden="true" data-testid={`close-tab-${tab}`}
                    className={clsx('ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-bg-hover hover:text-text-strong',
                      shown ? 'text-text' : 'text-muted')}>
                    <X size={12} />
                  </span>
                </Tooltip>
              </button>
            )
          })}
        </div>
      </div>
      {overflowing && <StripScrollButton side="end" label={t('runWorkspace.sessions.scrollEnd')} cut={cut.end} onPress={() => scrollStrip(strip, 1)} />}
      {others.length > 0 && (
        <RowActionsMenu label={t('runWorkspace.sessions.openAnother')} className="btn btn-ghost btn-sm shrink-0"
          face={<><Plus size={14} aria-hidden="true" /> {t('runWorkspace.sessions.open')}</>}
          entries={others.map((agent) => ({
            kind: 'action' as const, id: agent.agent, label: nameOf(agent.agent),
            icon: agent.agent === orchestrator ? Workflow : Bot, onSelect: () => onOpen(agent.agent),
          }))} />
      )}
    </div>
  )
}
