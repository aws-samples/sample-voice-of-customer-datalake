/**
 * @fileoverview The review-type chips of Problem Analysis: "Problems only" (the default),
 * "All types", then one toggle per `feedback_type` value with its count in the window.
 * Reviews with no type yet are always shown, and a line says how many there are
 * (`feedbackTypes.ts`).
 * @module pages/ProblemAnalysis/ProblemTypeChips
 */
import clsx from 'clsx'
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Tags } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  FEEDBACK_TYPES, PROBLEM_TYPES, UNTYPED_COUNT_KEY,
  feedbackTypeLabelKey, isAllTypes, isProblemsOnly, toggleType,
} from './feedbackTypes'
import type { TypeSelection } from './feedbackTypes'

interface ProblemTypeChipsProps {
  readonly value: TypeSelection
  readonly onChange: (value: TypeSelection) => void
  /** Reviews per type in the window the server read (`type_counts`). */
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

export function ProblemTypeChips({ value, onChange, counts }: ProblemTypeChipsProps) {
  const { t, i18n } = useTranslation(['problemAnalysis', 'common'])
  const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language])
  const untyped = counts[UNTYPED_COUNT_KEY] ?? 0
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('types.label')}>
        <Tags size={16} className="hidden sm:block text-muted flex-shrink-0 mr-1" aria-hidden="true" />
        <Chip pressed={isProblemsOnly(value)} onClick={() => onChange(PROBLEM_TYPES)} title={t('types.problemsOnlyHint')}>
          {t('types.problemsOnly')}
        </Chip>
        <Chip pressed={isAllTypes(value)} onClick={() => onChange(FEEDBACK_TYPES)}>{t('types.allTypes')}</Chip>
        <span className="w-px h-5 bg-border mx-1" aria-hidden="true" />
        {FEEDBACK_TYPES.map((type) => {
          const count = counts[type]
          return (
            <Chip key={type} pressed={value.includes(type)} onClick={() => onChange(toggleType(value, type))}>
              <span>{t(feedbackTypeLabelKey(type))}</span>
              {count !== undefined && <span className="tabular-nums text-muted">{number.format(count)}</span>}
            </Chip>
          )
        })}
      </div>
      {untyped > 0 && (
        <p className="text-xs text-muted" title={t('types.untypedHint')}>{t('types.untyped', { n: untyped })}</p>
      )}
    </div>
  )
}
