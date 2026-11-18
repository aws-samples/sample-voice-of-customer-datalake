/**
 * @fileoverview One row of a results chart (UX §10.2, design system › Charts): the label and the figures as text,
 * and a bar beside them that is `aria-hidden` (colour is never the only cue). One series, so `--chart-1`; a bar that
 * IS meaning (an NPS group) takes its status tone.
 *
 * @module pages/FeedbackForms/results/BarRow
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { formatCount, formatPercent } from '../../../utils/numberFormat'

export function Bar({ percent }: Readonly<{ percent: number }>) {
  return (
    <span aria-hidden="true" className="block h-2 w-full overflow-hidden rounded-full bg-bg-hover">
      <span className="block h-full rounded-full" style={{ width: `${String(Math.max(0, Math.min(100, percent)))}%`, backgroundColor: 'var(--chart-1)' }} />
    </span>
  )
}

export default function BarRow({ label, count, percent, muted = false, children }: Readonly<{
  label: ReactNode
  count: number
  /** The share, 0–100. */
  percent: number
  /** A removed option: its row in `text-muted`. */
  muted?: boolean
  /** Extra content under the row (Other's typed answers). */
  children?: ReactNode
}>) {
  const { i18n } = useTranslation()
  return (
    <li className="space-y-1">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,16rem)_1fr_auto]">
        <span className={clsx('min-w-0 break-words text-sm', muted ? 'text-muted' : 'text-text')}>{label}</span>
        <span className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto"><Bar percent={percent} /></span>
        <span className="text-right text-[12px] tabular-nums text-text">
          {formatCount(count, i18n.language)} <span className="text-muted">· {formatPercent(percent, i18n.language)}</span>
        </span>
      </div>
      {children}
    </li>
  )
}
