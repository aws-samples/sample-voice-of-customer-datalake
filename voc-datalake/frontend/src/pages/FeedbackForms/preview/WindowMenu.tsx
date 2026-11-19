/**
 * @fileoverview "Open in window ▾" (audit §1.4 B): the preview window at one of its sizes, a phone (390 × 844), the
 * phone rotated, a tablet, a desktop, or what the iframe snippet gives a site (1280 × 480). A menu, so the window
 * opens in the click on its item itself (pop-up rules), at that size.
 *
 * @module pages/FeedbackForms/preview/WindowMenu
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, ChevronDown } from 'lucide-react'
import { RowActionsMenu } from '../../../components/RowActionsMenu/RowActionsMenu'
import type { RowMenuEntry } from '../../../components/RowActionsMenu/rowMenuEntries'
import { WINDOW_PRESETS, WINDOW_PRESET_IDS } from './previewChannel'
import type { WindowPreset } from './previewChannel'

export default function WindowMenu({ onOpen }: Readonly<{ onOpen: (preset: WindowPreset) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const entries = useMemo<RowMenuEntry[]>(() => WINDOW_PRESET_IDS.map((id) => {
    const { width, height } = WINDOW_PRESETS[id]
    return { kind: 'action', id, label: t('previewWindow.sizeOption', { name: t(`previewWindow.presets.${id}`), width, height }), onSelect: () => onOpen(id) }
  }), [t, onOpen])
  return (
    <RowActionsMenu label={t('preview.openWindow')} entries={entries} className="btn btn-ghost btn-sm"
      face={<><AppWindow size={14} aria-hidden="true" />{t('preview.openWindow')}<ChevronDown size={14} aria-hidden="true" /></>} />
  )
}
