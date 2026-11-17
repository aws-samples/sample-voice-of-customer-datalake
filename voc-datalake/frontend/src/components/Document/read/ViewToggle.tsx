/**
 * @fileoverview Rendered · Source: how a text (or a diff) shows, one pressed at a time (`tabs-track`,
 * `aria-pressed`). Switching keeps the focus on the toggle.
 *
 * @module components/Document/read/ViewToggle
 */
import { useTranslation } from 'react-i18next'
import PressedChoices from '../../PressedChoices/PressedChoices'

export type TextView = 'rendered' | 'source'

const VIEWS: readonly TextView[] = ['rendered', 'source']

export default function ViewToggle({ value, onChange }: Readonly<{ value: TextView; onChange: (view: TextView) => void }>) {
  const { t } = useTranslation('documents')
  return (
    <PressedChoices label={t('view.label')} choices={VIEWS} value={value} onChange={onChange}
      display={(view) => t(`view.${view}`)} className="tabs-track w-fit" pressedClassName="tab tab-active" idleClassName="tab" />
  )
}
