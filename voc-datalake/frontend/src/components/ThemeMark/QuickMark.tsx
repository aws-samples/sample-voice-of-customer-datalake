/**
 * @fileoverview The Quick mark: a four-point spark inspired by Quick, outlined in
 * the brand gradient (violet → purple → magenta, the `--mark-quick-*` tokens of
 * styles/theme-marks.css, never recoloured by a palette). On a filled surface (the
 * assistant's round launcher) it is drawn in `currentColor` instead, so it keeps its
 * contrast on the accent fill. The thinking pose spins the spark (`animate-mark-spin`,
 * still under reduced motion) while the assistant works.
 * @module components/ThemeMark/QuickMark
 */
import { useId } from 'react'
import clsx from 'clsx'
import MarkSvg from './MarkSvg'
import type { MarkProps, StaticMarkProps } from './MarkSvg'

/** The spark outline, centred on (0, 0) within ±32.8 units. */
const QUICK_SPARK = [
  'M32.717-.129C32.686-2.67 30.186-3.263 30.186-3.263L11.447-10.57',
  'S4.82-27.415 4.261-28.703C3.355-30.789 2.109-31.856.479-31.77-1.35-31.672-2.277-30.88-2.974-28.716',
  'C-3.486-27.126-9.948-10.663-9.948-10.663L-29.437-2.895S-31.518-2.209-31.532-.005',
  'C-31.545 2.172-30.365 2.636-29.135 3.243-26.173 4.706-9.908 10.796-9.908 10.796',
  'S-5.842 21.806-3.041 28.557C-2.274 30.404-1.686 32.191.451 32.208 2.124 32.221 3.181 31.95 4.419 28.516',
  'C6.337 23.197 11.511 10.756 11.511 10.756S25.779 4.934 29.577 3.635C32.16 2.752 32.737 1.483 32.717-.129Z',
].join('')

/** Room for the 6-unit stroke around the ±32.8 outline. */
const VIEW_BOX = '-36 -36 72 72'

function QuickSpark({ className, onFill = false, thinking }: Readonly<StaticMarkProps & { thinking: boolean }>) {
  // useId() can hold ':' (`:r0:`); keep the id selector- and sanitiser-safe.
  const gradient = `${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-spark`
  return (
    <MarkSvg theme="quick" viewBox={VIEW_BOX} className={className}>
      {onFill ? null : (
        <defs>
          <linearGradient id={gradient} x1="-32" y1="-32" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop offset="0" style={{ stopColor: 'var(--mark-quick-from)' }} />
            <stop offset="0.55" style={{ stopColor: 'var(--mark-quick-via)' }} />
            <stop offset="1" style={{ stopColor: 'var(--mark-quick-to)' }} />
          </linearGradient>
        </defs>
      )}
      <path
        d={QUICK_SPARK}
        stroke={onFill ? 'currentColor' : `url(#${gradient})`}
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
        data-spark=""
        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        className={clsx(thinking && 'animate-mark-spin motion-reduce:animate-none')}
      />
    </MarkSvg>
  )
}

export default function QuickMark({ className, onFill }: Readonly<StaticMarkProps>) {
  return <QuickSpark className={className} onFill={onFill} thinking={false} />
}

/** The busy indicator: the spark spins. */
export function QuickMarkThinking({ className }: Readonly<MarkProps>) {
  return <QuickSpark className={className} thinking />
}
