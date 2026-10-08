/**
 * @fileoverview Assistant panel header: title, page-context chip, new chat,
 * sessions, export, mode toggles and close.
 *
 * @module assistant/components/PanelHeader
 */
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import {
  Download, History, LocateFixed, Maximize2, Minimize2, PanelRightOpen, Plus,
} from 'lucide-react'
import DialogClose from '../../components/DialogClose/DialogClose'
import KiroGhost from '../../components/KiroGhost/KiroGhost'
import NotifyToggle from '../notifications/NotifyToggle'
import type { ReactNode } from 'react'
import type { PageContext } from '../contract'
import type { PanelMode } from '../store/assistantStore'

export type PanelVariant = 'floating' | 'page'

interface PanelHeaderProps {
  page: PageContext
  variant: PanelVariant
  mode: PanelMode
  /** The panel shows the permanent conversation sidebar from `lg` up. */
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

function IconButton({ label, onClick, children, disabled, className }: Readonly<{
  label: string
  onClick: () => void
  children: ReactNode
  disabled?: boolean
  className?: string
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
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
  const pageName = t(`pages.${page.kind}`)
  const label = page.title !== undefined ? `${pageName}: ${page.title}` : pageName
  return (
    <span className="badge badge-accent inline-block max-w-full truncate" title={label}>
      {t('panel.using', { context: label })}
    </span>
  )
}

function ModeButtons({ mode, onMode }: Readonly<{ mode: PanelMode; onMode: (mode: PanelMode) => void }>) {
  const { t } = useTranslation('assistant')
  return (
    <>
      {/* Below `sm` both floating modes render as the same full-width sheet
          (AssistantPanel NARROW_SHEET), so Expand would do nothing there. */}
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
          <IconButton label={t('panel.fullscreen')} onClick={() => onMode('fullscreen')}>
            <Maximize2 size={16} aria-hidden />
          </IconButton>
        )}
    </>
  )
}

export default function PanelHeader({
  page, variant, mode, hasSidebar, canExport, onNewChat, onToggleSessions, onExport, onMode, onClose, onResetPosition,
}: Readonly<PanelHeaderProps>) {
  const { t } = useTranslation('assistant')
  // With the sidebar on screen its own New / list controls replace these two.
  const sidebarDuplicate = hasSidebar ? 'lg:hidden' : undefined
  return (
    <header className="chrome-glass flex flex-shrink-0 items-start gap-2 border-b border-border px-3 py-2">
      <KiroGhost className="mt-0.5 h-5 w-5 flex-shrink-0 text-accent-text" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold tracking-tight text-text-strong" id="assistant-panel-title">{t('panel.title')}</h2>
        <ContextChip page={page} />
      </div>
      <div className="flex flex-shrink-0 items-center">
        <IconButton label={t('panel.newChat')} onClick={onNewChat} className={sidebarDuplicate}>
          <Plus size={16} aria-hidden />
        </IconButton>
        <IconButton label={t('panel.sessions')} onClick={onToggleSessions} className={sidebarDuplicate}>
          <History size={16} aria-hidden />
        </IconButton>
        <IconButton label={t('panel.export')} onClick={onExport} disabled={!canExport}>
          <Download size={16} aria-hidden />
        </IconButton>
        <NotifyToggle />
        {onResetPosition !== undefined && (
          <IconButton label={t('launcher.resetPosition')} onClick={onResetPosition}>
            <LocateFixed size={16} aria-hidden />
          </IconButton>
        )}
        {variant === 'floating' && <ModeButtons mode={mode} onMode={onMode} />}
        {variant === 'floating' && <DialogClose onClick={onClose} label={t('panel.close')} />}
      </div>
    </header>
  )
}
