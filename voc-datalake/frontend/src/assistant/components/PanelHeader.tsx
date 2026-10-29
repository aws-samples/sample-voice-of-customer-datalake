/**
 * @fileoverview Assistant panel header: title, page-context chip, new chat,
 * sessions, mode toggles and close; the secondary actions (export, desktop
 * notifications, reset the launcher position) sit in a labelled "More actions"
 * menu, so none of them is an unlabelled icon (wave 4).
 *
 * On `/chat` (variant `page`) the app header already names the page, so the
 * panel's "Assistant" title is kept for screen readers only (one visible
 * heading, wave 4).
 *
 * @module assistant/components/PanelHeader
 */
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import {
  Bell, Download, History, LocateFixed, Maximize2, Minimize2, PanelRightOpen, Plus,
} from 'lucide-react'
import DialogClose from '../../components/DialogClose/DialogClose'
import KiroGhost from '../../components/KiroGhost/KiroGhost'
import { useNotifySetting } from '../notifications/useNotifySetting'
import MoreMenu from './MoreMenu'
import { pageLabelKey } from '../page/pageContext'
import type { ReactNode } from 'react'
import type { MoreMenuItem } from './MoreMenu'
import type { PageContext } from '../contract'
import type { PanelMode } from '../store/assistantStore'

export type PanelVariant = 'floating' | 'page'

interface PanelHeaderProps {
  /** Id of the heading the panel's dialog / region is labelled by. */
  titleId: string
  page: PageContext
  variant: PanelVariant
  mode: PanelMode
  /**
   * The panel shows the permanent conversation sidebar from `lg` up (`/chat`, full screen). Its
   * own rail button collapses it, so the header has no second Hide / Show control.
   */
  hasSidebar: boolean
  canExport: boolean
  onNewChat: () => void
  onToggleSessions: () => void
  onExport: () => void
  onMode: (mode: PanelMode) => void
  onClose: () => void
  /** Present when the launcher was dragged away from its corner: put it back. */
  onResetPosition?: () => void
}

function IconButton({ label, onClick, children, className }: Readonly<{
  label: string
  onClick: () => void
  children: ReactNode
  className?: string
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={clsx('icon-btn', className)}
    >
      {children}
    </button>
  )
}

function ContextChip({ page }: Readonly<{ page: PageContext }>) {
  const { t } = useTranslation('assistant')
  // A kind or label with no translation reads as the generic "This page", never as a raw key.
  const pageName = t(`pages.${pageLabelKey(page)}`, { defaultValue: t('pages.other') })
  const label = page.title !== undefined ? `${pageName}: ${page.title}` : pageName
  return (
    // Wraps rather than truncating (200 % zoom, long project names); the badge's pill radius softens when it wraps.
    <span className="badge badge-accent inline-block max-w-full whitespace-normal break-words [overflow-wrap:anywhere]" title={label}>
      {t('panel.using', { context: label })}
    </span>
  )
}

function ModeButtons({ mode, onMode }: Readonly<{ mode: PanelMode; onMode: (mode: PanelMode) => void }>) {
  const { t } = useTranslation('assistant')
  return (
    <>
      {/* Below `sm` both floating modes render as the same full-width sheet
          (AssistantPanel NARROW_SHEET) that already fills the screen, so Expand
          and Full screen would do nothing there. */}
      {mode === 'bubble' && (
        <IconButton label={t('panel.expand')} onClick={() => onMode('expanded')} className="max-sm:hidden">
          <PanelRightOpen size={16} aria-hidden />
        </IconButton>
      )}
      {mode === 'fullscreen'
        ? (
          <IconButton label={t('panel.exitFullscreen')} onClick={() => onMode('expanded')}>
            <Minimize2 size={16} aria-hidden />
          </IconButton>
        )
        : (
          <IconButton label={t('panel.fullscreen')} onClick={() => onMode('fullscreen')} className="max-sm:hidden">
            <Maximize2 size={16} aria-hidden />
          </IconButton>
        )}
    </>
  )
}

/** Export, notifications and (after a drag) reset position, each with a visible label. */
function useSecondaryItems(canExport: boolean, onExport: () => void, onResetPosition: (() => void) | undefined): MoreMenuItem[] {
  const { t } = useTranslation('assistant')
  const notify = useNotifySetting()
  const items: MoreMenuItem[] = [
    { key: 'export', label: t('panel.export'), icon: <Download size={14} />, onSelect: onExport, disabled: !canExport },
    {
      // A toggle that says what it does; when the browser blocks it, the label says why instead.
      key: 'notify', label: notify.unavailable ? notify.label : t('notifications.toggle.turnOn'), icon: <Bell size={14} />,
      checked: notify.on, disabled: notify.unavailable, onSelect: () => void notify.toggle(),
    },
  ]
  if (onResetPosition !== undefined) {
    items.push({ key: 'reset', label: t('launcher.resetPosition'), icon: <LocateFixed size={14} />, onSelect: onResetPosition })
  }
  return items
}

export default function PanelHeader({
  titleId, page, variant, mode, hasSidebar, canExport, onNewChat, onToggleSessions, onExport, onMode, onClose, onResetPosition,
}: Readonly<PanelHeaderProps>) {
  const { t } = useTranslation('assistant')
  // With the sidebar on screen its own New / list controls replace these two.
  const sidebarDuplicate = hasSidebar ? 'lg:hidden' : undefined
  const secondary = useSecondaryItems(canExport, onExport, onResetPosition)
  return (
    <header className="chrome-glass flex flex-shrink-0 items-start gap-2 border-b border-border px-3 py-2">
      <KiroGhost className="mt-0.5 h-5 w-5 flex-shrink-0 text-accent-text" />
      <div className="min-w-0 flex-1">
        <h2 className={clsx('text-sm font-semibold tracking-tight text-text-strong', variant === 'page' && 'sr-only')} id={titleId}>{t('panel.title')}</h2>
        <ContextChip page={page} />
      </div>
      <div className="flex flex-shrink-0 items-center">
        <IconButton label={t('panel.newChat')} onClick={onNewChat} className={sidebarDuplicate}>
          <Plus size={16} aria-hidden />
        </IconButton>
        <IconButton label={t('panel.sessions')} onClick={onToggleSessions} className={sidebarDuplicate}>
          <History size={16} aria-hidden />
        </IconButton>
        <MoreMenu label={t('panel.more')} items={secondary} />
        {variant === 'floating' && <ModeButtons mode={mode} onMode={onMode} />}
        {variant === 'floating' && <DialogClose onClick={onClose} label={t('panel.close')} />}
      </div>
    </header>
  )
}
