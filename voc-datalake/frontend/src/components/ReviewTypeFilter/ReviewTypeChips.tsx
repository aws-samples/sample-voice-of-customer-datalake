/**
 * @fileoverview The review-type pills of Problem Analysis and Categories: "Problems only"
 * (a preset), "All types" (no type filter), then one pill per `feedback_type` value with its
 * count in the window. Reviews with no type yet are always shown, and a line says how many
 * there are (`reviewTypeSelection.ts`).
 * @module components/ReviewTypeFilter/ReviewTypeChips
 */
import clsx from 'clsx'
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Tags } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  ALL_TYPES, FEEDBACK_TYPES, PROBLEM_TYPES, UNTYPED_COUNT_KEY,
  feedbackTypeLabelKey, isAllTypes, isProblemsOnly, pressedTypes, toggleType,
} from './reviewTypeSelection'
import type { TypeSelection } from './reviewTypeSelection'

interface ReviewTypeChipsProps {
  readonly value: TypeSelection
  readonly onChange: (value: TypeSelection) => void
  /** Reviews per type in the window, plus `untyped`; a type with no entry shows no number. */
  readonly counts: Readonly<Record<string, number>>
}

function Chip({ pressed, onClick, title, children }: Readonly<{
  pressed: boolean; onClick: () => void; title?: string; children: ReactNode
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      title={title}
      className={clsx(
        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-colors active:scale-95 focus-ring',
        pressed ? 'bg-accent-subtle text-accent-text ring-1 ring-inset ring-accent/40' : 'bg-bg-hover text-text hover:bg-border',
      )}
    >
      {children}
    </button>
  )
}

export function ReviewTypeChips({ value, onChange, counts }: ReviewTypeChipsProps) {
  const { t, i18n } = useTranslation('common')
  const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language])
  const untyped = counts[UNTYPED_COUNT_KEY] ?? 0
  const pressed = pressedTypes(value)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('reviewTypeFilter.label')}>
        <Tags size={16} className="hidden sm:block text-muted flex-shrink-0 mr-1" aria-hidden="true" />
        <Chip pressed={isProblemsOnly(pressed)} onClick={() => onChange(PROBLEM_TYPES)} title={t('reviewTypeFilter.problemsOnlyHint')}>
          {t('reviewTypeFilter.problemsOnly')}
        </Chip>
        <Chip pressed={isAllTypes(pressed)} onClick={() => onChange(ALL_TYPES)}>{t('reviewTypeFilter.allTypes')}</Chip>
        <span className="w-px h-5 bg-border mx-1" aria-hidden="true" />
        {FEEDBACK_TYPES.map((type) => {
          const count = counts[type]
          return (
            <Chip key={type} pressed={pressed.includes(type)} onClick={() => onChange(toggleType(value, type))}>
              <span>{t(feedbackTypeLabelKey(type))}</span>
              {count !== undefined && <span className="tabular-nums text-muted">{number.format(count)}</span>}
            </Chip>
          )
        })}
      </div>
      {untyped > 0 && (
        <p className="text-xs text-muted" title={t('reviewTypeFilter.untypedHint')}>{t('reviewTypeFilter.untyped', { n: untyped })}</p>
      )}
    </div>
  )
}
