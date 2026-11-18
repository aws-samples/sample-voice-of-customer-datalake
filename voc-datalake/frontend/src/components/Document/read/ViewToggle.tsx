/**
 * @fileoverview Rendered · Source: how a text (or a diff) shows, one pressed at a time (`tabs-track`,
 * `aria-pressed`). Switching keeps the focus on the toggle.
 *
 * @module components/Document/read/ViewToggle
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import PressedChoices from '../../PressedChoices/PressedChoices'
import type { ReactNode } from 'react'

export type TextView = 'rendered' | 'source'

const VIEWS: readonly TextView[] = ['rendered', 'source']

function ViewToggle({ value, onChange }: Readonly<{ value: TextView; onChange: (view: TextView) => void }>) {
  const { t } = useTranslation('documents')
  return (
    <PressedChoices label={t('view.label')} choices={VIEWS} value={value} onChange={onChange}
      display={(view) => t(`view.${view}`)} className="tabs-track w-fit" pressedClassName="tab tab-active" idleClassName="tab" />
  )
}

/** A text (or a diff) under its toggle: `rendered` first, `source` once Source is pressed. */
export function TextViews({ rendered, source }: Readonly<{ rendered: ReactNode; source: ReactNode }>) {
  const [view, setView] = useState<TextView>('rendered')
  return (
    <div className="space-y-3">
      <ViewToggle value={view} onChange={setView} />
      {view === 'rendered' ? rendered : source}
    </div>
  )
}
