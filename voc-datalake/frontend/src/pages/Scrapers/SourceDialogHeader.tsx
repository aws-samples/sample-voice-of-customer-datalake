/**
 * @fileoverview The one header every data-source dialog on the Scrapers page
 * uses: an icon tile, the dialog title (the ModalShell's accessible name,
 * via `titleId`), an optional one-line description and the Dismiss button.
 *
 * The dialogs used to hand-roll this five different ways (bare icon, toned tile,
 * emoji tile, no icon, h3 vs span titles), so the same kind of dialog looked
 * different depending on which tile opened it.
 *
 * The tile is `accent` for every kind of source — a source is the page's one
 * emphasis — and the icon says which kind (labels vs status, rule 15). Until
 * 3.14.02 each kind had its own tone (paste warn, JSON info, CSV ok, synthetic
 * aim, scraper ok, app accent), which read as six states. `muted` remains for
 * the one STATE a tile carries: a paused scraper (`ScraperCard`).
 * @module pages/Scrapers/SourceDialogHeader
 */

import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import DialogClose from '../../components/DialogClose/DialogClose'
import type { Tone } from '../../theme/tones'

export type SourceTone = Extract<Tone, 'accent' | 'muted'>

/** Icon-tile classes per tone. Consumers use `ToneTile`, so this stays private. */
const TONE_TILE: Record<SourceTone, string> = {
  accent: 'bg-accent-subtle text-accent-text',
  muted: 'bg-bg-hover text-muted',
}

export function ToneTile({ icon: Icon, tone = 'accent', size = 'md' }: Readonly<{
  icon: LucideIcon
  /** `muted` only for an inactive state; a kind of source is always `accent`. */
  tone?: SourceTone
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
  titleId, title, description, icon, onClose, closeDisabled,
}: Readonly<{
  titleId: string
  title: string
  description?: string
  icon: LucideIcon
  onClose: () => void
  closeDisabled?: boolean
}>) {
  return (
    <div className="dialog-header justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <ToneTile icon={icon} />
        <div className="min-w-0">
          <h2 id={titleId} className="dialog-title truncate" title={title}>{title}</h2>
          {description != null && description !== '' ? <p className="dialog-description line-clamp-2">{description}</p> : null}
        </div>
      </div>
      <DialogClose onClick={onClose} disabled={closeDisabled} className="flex-shrink-0" />
    </div>
  )
}
