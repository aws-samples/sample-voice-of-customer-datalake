/**
 * @fileoverview The Quick mark, after the Quick design system's brand tile: a
 * 64-unit tile with 16-unit corners in the brand gradient, a white four-point
 * spark top right and, for voice of the customer, a white speech bubble (3.6-unit
 * stroke) where the original has an envelope. The tile is never recoloured, in
 * either mode: its colours are the `--mark-quick-*` tokens of
 * styles/theme-marks.css, not the active palette. The thinking pose breathes the
 * spark (`animate-mark-breathe`, still under reduced motion).
 * @module components/ThemeMark/QuickMark
 */
import { useId } from 'react'
import MarkSvg from './MarkSvg'
import type { MarkProps } from './MarkSvg'

const GLYPH = 'var(--mark-quick-glyph)'
const BUBBLE = 'M19 20H39A6 6 0 0 1 45 26V35A6 6 0 0 1 39 41H27L19 47V41A6 6 0 0 1 13 35V26A6 6 0 0 1 19 20Z'
const SPARK = 'M49 11.5c.9 3.9 2.7 5.7 6.5 6.5-3.8.8-5.6 2.6-6.5 6.5-.9-3.9-2.7-5.7-6.5-6.5 3.8-.8 5.6-2.6 6.5-6.5Z'
const DOTS = [21.5, 29, 36.5] as const

function QuickTile({ className, thinking }: Readonly<MarkProps & { thinking: boolean }>) {
  const tile = `${useId()}-tile`
  return (
    <MarkSvg theme="quick" viewBox="0 0 64 64" className={className}>
      <defs>
        <linearGradient id={tile} x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--mark-quick-from)' }} />
          <stop offset="0.55" style={{ stopColor: 'var(--mark-quick-via)' }} />
          <stop offset="1" style={{ stopColor: 'var(--mark-quick-to)' }} />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill={`url(#${tile})`} />
      <path d={BUBBLE} stroke={GLYPH} strokeWidth={3.6} strokeLinejoin="round" />
      {DOTS.map((cx) => <circle key={cx} cx={cx} cy={30.5} r={2.6} fill={GLYPH} />)}
      <path
        d={SPARK}
        fill={GLYPH}
        data-spark=""
        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        className={thinking ? 'animate-mark-breathe motion-reduce:animate-none' : undefined}
      />
    </MarkSvg>
  )
}

export default function QuickMark({ className }: Readonly<MarkProps>) {
  return <QuickTile className={className} thinking={false} />
}

/** The busy indicator: the tile holds still while its spark breathes. */
export function QuickMarkThinking({ className }: Readonly<MarkProps>) {
  return <QuickTile className={className} thinking />
}
