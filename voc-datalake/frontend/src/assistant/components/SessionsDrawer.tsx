/**
 * @fileoverview The conversation list as an overlay drawer, for panels too
 * narrow for the permanent sidebar (the floating bubble/expanded card, and
 * `/chat` below `lg`).
 *
 * Keyboard (design audit D-OVL): focus moves into the drawer when it opens,
 * Escape closes it — without also leaving the panel's full screen — and focus
 * goes back to the "Past conversations" button.
 *
 * @module assistant/components/SessionsDrawer
 */
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import DialogClose from '../../components/DialogClose/DialogClose'
import { useOverlayFocus } from '../../hooks/useOverlayFocus'
import SessionList from './SessionList'
import { useFocusTrap } from './useFocusTrap'

interface SessionsDrawerProps {
  onOpen: (id: string) => void
  onClose: () => void
}

export default function SessionsDrawer({ onOpen, onClose }: Readonly<SessionsDrawerProps>) {
  const { t } = useTranslation('assistant')
  const ref = useRef<HTMLElement>(null)
  // Mounted only while open, so both hooks are always active here. The drawer
  // covers the whole panel, so Tab is kept inside it: leaving it put focus on
  // the panel controls hidden underneath (design audit D-OVL).
  useOverlayFocus(ref, true, { onClose })
  useFocusTrap(ref, true)
  return (
    <aside ref={ref} className="absolute inset-0 z-10 flex flex-col bg-card animate-rise" aria-label={t('sessions.title')}>
      <div className="chrome-glass flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-sm font-semibold tracking-tight text-text-strong">{t('sessions.title')}</h3>
        <DialogClose onClick={onClose} label={t('sessions.close')} />
      </div>
      <div className="flex-1 overflow-y-auto">
        <SessionList onPick={onOpen} />
      </div>
    </aside>
  )
}
