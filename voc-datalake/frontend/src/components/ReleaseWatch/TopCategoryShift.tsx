/**
 * @fileoverview The ranked categories before and after one release (`top_categories`
 * from `lambda/shared/release_watch.py`), each opening Categories filtered by it.
 * An after-row is marked "New" when it was not in the top list before, and "Up from N"
 * when its count rose: in words, not by colour alone. Counts are compared as sent, like
 * the server's complaint deltas.
 * @module components/ReleaseWatch/TopCategoryShift
 */
import { ArrowUpRight, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import type { ReleaseSide } from '../../api/releaseWatchSchema'

/** The most a side lists; the server sends at most three (`TOP_CATEGORIES`). */
const SHOWN = 3

type Ranked = ReleaseSide['top_categories'][number]

/** What changed for one after-row: absent before, grew (with the earlier count), or neither. */
type Shift = { kind: 'new' } | { kind: 'grew'; from: number } | null

function shiftOf(row: Ranked, before: readonly Ranked[]): Shift {
  const earlier = before.find((b) => b.name === row.name)
  if (earlier === undefined) return { kind: 'new' }
  return row.count > earlier.count ? { kind: 'grew', from: earlier.count } : null
}

function categoriesHref(category: string): string {
  return `/categories?${new URLSearchParams({ category }).toString()}`
}

function ShiftBadge({ shift }: Readonly<{ shift: Shift }>) {
  const { t } = useTranslation('decisions')
  if (shift === null) return null
  if (shift.kind === 'new') {
    return (
      <span className="badge badge-accent inline-flex items-center gap-1">
        <Sparkles size={12} aria-hidden />{t('releaseWatch.topCategories.new')}
      </span>
    )
  }
  return (
    <span className="badge badge-warn inline-flex items-center gap-1">
      <ArrowUpRight size={12} aria-hidden />{t('releaseWatch.topCategories.grew', { count: shift.from })}
    </span>
  )
}

function RankedList({ rows, label, before }: Readonly<{ rows: readonly Ranked[]; label: string; before?: readonly Ranked[] }>) {
  const { t } = useTranslation('decisions')
  const labels = useDisplayLabels()
  // An empty cell keeps the after-list in its column when only the after side has rows.
  if (rows.length === 0) return <div />
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">{label}</p>
      <ol aria-label={label} className="mt-1 space-y-1 text-sm">
        {rows.slice(0, SHOWN).map((row) => (
          <li key={row.name} className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            <Link to={categoriesHref(row.name)} className="link break-words">{labels.category(row.name)}</Link>
            <span className="font-mono text-muted">
              {t('releaseWatch.topCategories.count', { count: row.count })}
            </span>
            {before !== undefined && <ShiftBadge shift={shiftOf(row, before)} />}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** Nothing at all when neither side has a ranked category. */
export default function TopCategoryShift({ before, after }: Readonly<{ before: ReleaseSide; after: ReleaseSide }>) {
  const { t } = useTranslation('decisions')
  if (before.top_categories.length === 0 && after.top_categories.length === 0) return null
  const shown = before.top_categories.slice(0, SHOWN)
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <RankedList rows={shown} label={t('releaseWatch.topCategories.before')} />
      <RankedList rows={after.top_categories} label={t('releaseWatch.topCategories.after')} before={shown} />
    </div>
  )
}
