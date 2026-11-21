/**
 * @fileoverview A feedback form's collected figures: the submission count and
 * the average rating.
 *
 * One place for what the Prioritization evidence panel (and, before 7.04.00, the
 * form card and the submissions dialog) built by hand: counts are grouped in
 * the app language ("26,622", de "26.622") and the average carries one decimal
 * with the locale's mark ("4.5", pl "4,5"). Not loaded and "no ratings" both
 * read as an em dash, never as 0 — a 0 would look like unanimously bad feedback.
 *
 * Two icon-chip figures, rendered as siblings so the caller's grid lays them out
 * next to its own controls.
 *
 * The labels come from the caller, already translated in its own namespace (the
 * submissions label pluralised on the count, "1 Submission").
 *
 * `busy` (the figures are being read): each value is a pulsing placeholder and the
 * figure is `aria-busy`, so a count still on its way never reads as a number —
 * not even the 0 a cached copy from before the latest submission would show.
 *
 * @module components/FormStatsFigures
 */
import { MessageSquare, Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReactElement, ReactNode } from 'react'
import type { FormStats } from '../../api/feedbackFormStatsSchema'
import { formatCount, formatDecimal } from '../../utils/numberFormat'

const DASH = '—'

interface FormStatsLabels {
  readonly submissions: string
  readonly avgRating: string
}

interface FormStatsFiguresProps {
  /** Null / undefined while loading or when the read gave nothing usable. */
  readonly stats: FormStats | null | undefined
  readonly labels: FormStatsLabels
  /** The figures are being (re)read: show placeholders, not the values. */
  readonly busy?: boolean
}

/** A value, or its placeholder while the figures are read. */
function FigureValue({ value, busy }: Readonly<{ value: string; busy: boolean }>): ReactElement {
  return busy ? <span className="skeleton inline-block h-6 w-10 align-middle" aria-hidden="true" /> : <>{value}</>
}

/** The two figures as display strings in `language`. */
function formStatsText(stats: FormStats | null | undefined, language: string) {
  return {
    submissions: stats ? formatCount(stats.total_submissions, language) : DASH,
    avgRating: typeof stats?.avg_rating === 'number' ? formatDecimal(stats.avg_rating, language, 1) : DASH,
  }
}

function CompactFigure({ icon, value, label, busy }: Readonly<{ icon: ReactNode; value: string; label: string; busy: boolean }>): ReactElement {
  return (
    <div className="flex items-center gap-2" aria-busy={busy}>
      {icon}
      <div>
        <p className="text-lg font-bold font-mono text-text-strong"><FigureValue value={value} busy={busy} /></p>
        <p className="text-xs text-muted">{label}</p>
      </div>
    </div>
  )
}

export default function FormStatsFigures({ stats, labels, busy = false }: FormStatsFiguresProps): ReactElement {
  const { i18n } = useTranslation()
  const text = formStatsText(stats, i18n.language)
  // The star keeps the rating colour the stars themselves are drawn in: it IS a rating.
  return (
    <>
      <CompactFigure
        icon={<div className="p-1.5 bg-accent-subtle rounded-md"><MessageSquare size={14} className="text-accent-text" aria-hidden="true" /></div>}
        value={text.submissions}
        label={labels.submissions}
        busy={busy}
      />
      <CompactFigure
        icon={<div className="p-1.5 bg-warn-subtle rounded-md"><Star size={14} className="text-warn" aria-hidden="true" /></div>}
        value={text.avgRating}
        label={labels.avgRating}
        busy={busy}
      />
    </>
  )
}
