/**
 * @fileoverview The one header every data-source dialog on the Scrapers page
 * uses: a toned icon tile, the dialog title (the ModalShell's accessible name,
 * via `titleId`), an optional one-line description and the Dismiss button.
 *
 * The dialogs used to hand-roll this five different ways (bare icon, toned tile,
 * emoji tile, no icon, h3 vs span titles), so the same kind of dialog looked
 * different depending on which tile opened it.
 * @module pages/Scrapers/SourceDialogHeader
 */

import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import DialogClose from '../../components/DialogClose/DialogClose'
import type { Tone } from '../../theme/tones'

export type SourceTone = Extract<Tone, 'accent' | 'aim' | 'info' | 'ok' | 'warn' | 'muted'>

/** Icon-tile classes per tone. Consumers use `ToneTile`, so this stays private. */
const TONE_TILE: Record<SourceTone, string> = {
  accent: 'bg-accent-subtle text-accent-text',
  aim: 'bg-aim-subtle text-aim',
  info: 'bg-info-subtle text-info',
  ok: 'bg-ok-subtle text-ok',
  warn: 'bg-warn-subtle text-warn',
  muted: 'bg-bg-hover text-muted',
}

export function ToneTile({ icon: Icon, tone, size = 'md' }: Readonly<{
  icon: LucideIcon
  tone: SourceTone
  size?: 'sm' | 'md'
}>) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'rounded-lg flex items-center justify-center flex-shrink-0',
        size === 'sm' ? 'w-8 h-8' : 'w-9 h-9',
        TONE_TILE[tone],
      )}
    >
      <Icon size={size === 'sm' ? 16 : 18} />
    </span>
  )
}

export default function SourceDialogHeader({
  titleId, title, description, icon, tone, onClose, closeDisabled,
}: Readonly<{
  titleId: string
  title: string
  description?: string
  icon: LucideIcon
  tone: SourceTone
  onClose: () => void
  closeDisabled?: boolean
}>) {
  return (
    <div className="dialog-header justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <ToneTile icon={icon} tone={tone} />
        <div className="min-w-0">
          <h2 id={titleId} className="dialog-title truncate" title={title}>{title}</h2>
          {description != null && description !== '' ? <p className="dialog-description line-clamp-2">{description}</p> : null}
        </div>
      </div>
      <DialogClose onClick={onClose} disabled={closeDisabled} className="flex-shrink-0" />
    </div>
  )
}
