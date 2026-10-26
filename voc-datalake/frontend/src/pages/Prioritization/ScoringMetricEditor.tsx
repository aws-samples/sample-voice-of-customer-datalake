/**
 * @fileoverview One metric in the Scoring setup editor: its name, description, weight
 * (with its live share), direction, the words for 1 and 5, and the row actions — move up,
 * move down, archive. Every icon-only button has a visible tooltip and an accessible name.
 * @module pages/Prioritization/ScoringMetricEditor
 */
import clsx from 'clsx'
import { Archive, ArrowDown, ArrowUp } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { DRAFT_LIMITS } from './scoringDraft'
import type { DraftAxis, DraftEdit } from './scoringDraft'
import type { AxisDirection } from '../../api/prioritizationAxes'
import type { ReactElement } from 'react'

const DIRECTIONS: readonly AxisDirection[] = ['higher_better', 'lower_better']

function DirectionToggle({ value, onChange, labelId }: {
  readonly value: AxisDirection
  readonly onChange: (direction: AxisDirection) => void
  readonly labelId: string
}): ReactElement {
  const { t } = useTranslation('prioritization')
  return (
    <div role="group" aria-labelledby={labelId} className="tabs-track w-fit">
      {DIRECTIONS.map((direction) => (
        <button
          key={direction}
          type="button"
          aria-pressed={value === direction}
          onClick={() => onChange(direction)}
          className={clsx('tab', value === direction && 'tab-active')}
        >
          {direction === 'higher_better' ? t('setup.higherBetter') : t('setup.lowerBetter')}
        </button>
      ))}
    </div>
  )
}

function TextField({ label, value, maxLength, placeholder, onChange }: {
  readonly label: string
  readonly value: string
  readonly maxLength: number
  readonly placeholder?: string
  readonly onChange: (value: string) => void
}): ReactElement {
  const id = useId()
  return (
    <div className="space-y-1 min-w-0">
      <label htmlFor={id} className="text-xs font-medium text-text">{label}</label>
      <input id={id} type="text" className="input" value={value} maxLength={maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

function WeightField({ name, weight, share, onChange }: {
  readonly name: string
  readonly weight: number
  readonly share: number
  readonly onChange: (weight: number) => void
}): ReactElement {
  const { t } = useTranslation('prioritization')
  const labelId = useId()
  const numberId = useId()
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <label id={labelId} htmlFor={numberId} className="text-xs font-medium text-text">{t('setup.weight')}</label>
        {/* The share is what the weight MEANS: its part of the priority score. */}
        <span className="text-xs text-muted">{t('setup.share', { share })}</span>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range" min={0} max={DRAFT_LIMITS.weight} step={5} value={weight}
          aria-label={t('setup.weightOf', { name })}
          aria-valuetext={t('setup.share', { share })}
          onChange={(e) => onChange(Number(e.target.value))}
          className="range flex-1 w-auto"
        />
        <input
          id={numberId} type="number" inputMode="numeric" min={0} max={DRAFT_LIMITS.weight} value={weight}
          aria-labelledby={labelId}
          onChange={(e) => onChange(Number(e.target.value))}
          className="input w-20 text-right font-mono"
        />
      </div>
    </div>
  )
}

export interface MetricActions {
  readonly onEdit: (key: string, edit: DraftEdit) => void
  readonly onMove: (key: string, delta: -1 | 1) => void
  readonly onArchive: (key: string) => void
}

export function ScoringMetricEditor({ axis, index, count, share, actions, defaultName }: {
  readonly axis: DraftAxis
  /** Position among the ACTIVE metrics, for the move buttons and the heading. */
  readonly index: number
  readonly count: number
  readonly share: number
  readonly actions: MetricActions
  /** The translated name a built-in shows when its name field is emptied. */
  readonly defaultName: string
}): ReactElement {
  const { t } = useTranslation('prioritization')
  const directionLabelId = useId()
  const name = axis.label.trim() === '' ? (defaultName || t('setup.untitled')) : axis.label
  const edit = (change: DraftEdit) => actions.onEdit(axis.key, change)
  return (
    <li className="rounded-lg border border-border bg-card p-3 sm:p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-strong min-w-0 break-words">
          <span className="font-mono text-muted mr-2">{index + 1}.</span>{name}
        </h3>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button type="button" className="icon-btn" disabled={index === 0} onClick={() => actions.onMove(axis.key, -1)} aria-label={t('setup.moveUp', { name })} title={t('setup.moveUp', { name })}>
            <ArrowUp size={16} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn" disabled={index === count - 1} onClick={() => actions.onMove(axis.key, 1)} aria-label={t('setup.moveDown', { name })} title={t('setup.moveDown', { name })}>
            <ArrowDown size={16} aria-hidden="true" />
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.onArchive(axis.key)} aria-label={t('setup.archiveMetric', { name })} title={t('setup.archiveHint')}>
            <Archive size={14} aria-hidden="true" /><span className="hidden sm:inline">{t('setup.archive')}</span>
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField label={t('setup.name')} value={axis.label} maxLength={DRAFT_LIMITS.label} placeholder={defaultName} onChange={(label) => edit({ label })} />
        <TextField label={t('setup.descriptionLabel')} value={axis.description} maxLength={DRAFT_LIMITS.description} onChange={(description) => edit({ description })} />
      </div>
      <WeightField name={name} weight={axis.weight} share={share} onChange={(weight) => edit({ weight })} />
      <div className="space-y-1">
        <p id={directionLabelId} className="text-xs font-medium text-text">{t('setup.direction')}</p>
        <DirectionToggle value={axis.direction} onChange={(direction) => edit({ direction })} labelId={directionLabelId} />
        <p className="text-xs text-muted">{axis.direction === 'lower_better' ? t('setup.lowerBetterHint') : t('setup.higherBetterHint')}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <TextField label={t('setup.lowLabel')} value={axis.lowLabel} maxLength={DRAFT_LIMITS.scaleLabel} onChange={(lowLabel) => edit({ lowLabel })} />
        <TextField label={t('setup.highLabel')} value={axis.highLabel} maxLength={DRAFT_LIMITS.scaleLabel} onChange={(highLabel) => edit({ highLabel })} />
      </div>
    </li>
  )
}
