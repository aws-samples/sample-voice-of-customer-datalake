/**
 * @fileoverview A status badge with a leading icon: `badge` + a tone class, a 12 px
 * (or 10 px) icon hidden from assistive tech, then the label (docs/kiro-design-system.md
 * rule 15: a state carries its tone AND its icon, so colour is never the only signal).
 * `spin` turns the icon into a progress spinner; without `icon` the badge shows the
 * label alone (a status whose icon appears only in some states). Other span attributes
 * (`title`, `role`, `data-*`) pass through.
 *
 * @module components/IconBadge
 */
import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import type { HTMLAttributes, ReactNode } from 'react'

export interface IconBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'className' | 'children'> {
  /** The tone class, e.g. `badge-ok` (theme/tones). */
  readonly toneClass: string
  readonly icon?: LucideIcon
  /** Icon size in px: 12 (default), 10 for the small inline flags. */
  readonly iconSize?: 10 | 12
  readonly spin?: boolean
  /** Extra layout classes for the badge (`flex-shrink-0`, `self-start`, a margin). */
  readonly className?: string
  readonly children: ReactNode
}

export function IconBadge({ toneClass, icon: Icon, iconSize = 12, spin = false, className, children, ...rest }: Readonly<IconBadgeProps>) {
  return (
    <span {...rest} className={clsx('badge inline-flex items-center gap-1', toneClass, className)}>
      {Icon === undefined ? null : <Icon size={iconSize} className={spin ? 'animate-spin' : undefined} aria-hidden="true" />}
      {children}
    </span>
  )
}
