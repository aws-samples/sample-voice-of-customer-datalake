/**
 * @fileoverview The document page's rail as two tabs, "Comments | Evidence" (WAI-ARIA tabs:
 * arrow keys, Home and End move between them, the active tab is the one Tab stop). Both panels
 * stay mounted (the comment bubbles keep their place, a draft keeps its text); the hidden one is
 * `hidden`.
 *
 * @module components/DocumentCanvas/comments/RailTabs
 */
import clsx from 'clsx'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rovingIndex, TAB_KEYS } from '../../../utils/rovingIndex'
import type { KeyboardEvent, ReactNode } from 'react'

const TABS = ['comments', 'evidence'] as const
type RailTab = (typeof TABS)[number]

/** The tab a key moves to from `current`, or null for any other key. */
function tabAfterKey(key: string, current: RailTab): RailTab | null {
  const index = rovingIndex(key, TABS.indexOf(current), TABS.length, TAB_KEYS)
  return index === null ? null : (TABS[index] ?? null)
}

interface RailTabsProps {
  readonly comments: ReactNode
  readonly evidence: ReactNode
}

export default function RailTabs({ comments, evidence }: RailTabsProps) {
  const { t } = useTranslation('projectDetail')
  const id = useId()
  const [active, setActive] = useState<RailTab>('comments')
  const buttons = useRef<Partial<Record<RailTab, HTMLButtonElement | null>>>({})
  const panels: Readonly<Record<RailTab, ReactNode>> = { comments, evidence }
  const onKeyDown = (event: KeyboardEvent) => {
    const next = tabAfterKey(event.key, active)
    if (next === null) return
    event.preventDefault()
    setActive(next)
    buttons.current[next]?.focus()
  }
  return (
    <div className="min-w-0 space-y-3">
      <div className="tabs-track" role="tablist" aria-label={t('canvas.comments.tabs.label')} onKeyDown={onKeyDown}>
        {TABS.map((tab) => (
          <button key={tab} type="button" role="tab" id={`${id}-${tab}-tab`} aria-controls={`${id}-${tab}-panel`}
            aria-selected={active === tab} tabIndex={active === tab ? 0 : -1}
            ref={(element) => { buttons.current[tab] = element }}
            className={clsx('tab', active === tab && 'tab-active')} onClick={() => setActive(tab)}>
            {t(`canvas.comments.tabs.${tab}`)}
          </button>
        ))}
      </div>
      {TABS.map((tab) => (
        <div key={tab} role="tabpanel" id={`${id}-${tab}-panel`} aria-labelledby={`${id}-${tab}-tab`}
          hidden={active !== tab}>
          {panels[tab]}
        </div>
      ))}
    </div>
  )
}
