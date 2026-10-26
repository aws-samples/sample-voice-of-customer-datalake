/**
 * @fileoverview A feedback form's collected figures: the submission count and
 * the average rating (and, in the panel, how many submissions were rated).
 *
 * One place for what the Feedback Forms card, the Prioritization evidence panel
 * and the submissions dialog each used to build by hand: counts are grouped in
 * the app language ("26,622", de "26.622") and the average carries one decimal
 * with the locale's mark ("4.5", pl "4,5"). Not loaded and "no ratings" both
 * read as an em dash, never as 0 — a 0 would look like unanimously bad feedback.
 *
 * - `compact`: two icon-chip figures, rendered as siblings so the caller's grid
 *   lays them out next to its own controls.
 * - `panel`: three centred figures in their own band (the dialog header).
 *
 * The labels come from the caller, already translated in its own namespace.
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
  /** The panel's third figure, the rated-submission count. */
  readonly rated?: string
}

interface FormStatsFiguresProps {
  readonly variant: 'compact' | 'panel'
  /** Null / undefined while loading or when the read gave nothing usable. */
  readonly stats: FormStats | null | undefined
  readonly labels: FormStatsLabels
}

/** The three figures as display strings in `language`. */
function formStatsText(stats: FormStats | null | undefined, language: string) {
  return {
    submissions: stats ? formatCount(stats.total_submissions, language) : DASH,
    avgRating: typeof stats?.avg_rating === 'number' ? formatDecimal(stats.avg_rating, language, 1) : DASH,
    rated: stats ? formatCount(stats.rating_count, language) : DASH,
  }
}

function CompactFigure({ icon, value, label }: Readonly<{ icon: ReactNode; value: string; label: string }>): ReactElement {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <div>
        <p className="text-lg font-bold font-mono text-text-strong">{value}</p>
        <p className="text-xs text-muted">{label}</p>
      </div>
    </div>
  )
}

function PanelFigure({ value, label }: Readonly<{ value: string; label: string }>): ReactElement {
  return (
    <div className="text-center">
      <p className="text-2xl font-bold font-mono text-text-strong">{value}</p>
      <p className="text-xs font-medium uppercase tracking-[.04em] text-muted">{label}</p>
    </div>
  )
}

export default function FormStatsFigures({ variant, stats, labels }: FormStatsFiguresProps): ReactElement {
  const { i18n } = useTranslation()
  const text = formStatsText(stats, i18n.language)
  if (variant === 'panel') {
    return (
      <div className="grid grid-cols-3 gap-2 sm:gap-4 px-4 py-3 sm:p-4 bg-bg-accent border-b border-border">
        <PanelFigure value={text.submissions} label={labels.submissions} />
        <PanelFigure value={text.avgRating} label={labels.avgRating} />
        {labels.rated === undefined ? null : <PanelFigure value={text.rated} label={labels.rated} />}
      </div>
    )
  }
  // The star keeps the rating colour the stars themselves are drawn in: it IS a rating.
  return (
    <>
      <CompactFigure
        icon={<div className="p-1.5 bg-accent-subtle rounded-md"><MessageSquare size={14} className="text-accent-text" aria-hidden="true" /></div>}
        value={text.submissions}
        label={labels.submissions}
      />
      <CompactFigure
        icon={<div className="p-1.5 bg-warn-subtle rounded-md"><Star size={14} className="text-warn" aria-hidden="true" /></div>}
        value={text.avgRating}
        label={labels.avgRating}
      />
    </>
  )
}
