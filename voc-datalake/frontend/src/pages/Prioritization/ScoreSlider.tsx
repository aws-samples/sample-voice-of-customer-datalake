/**
 * @fileoverview Score slider component for prioritization scoring.
 * @module pages/Prioritization/ScoreSlider
 */

import clsx from 'clsx'
import { X } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { getScoreColor } from './teamScore'

/** The top of every axis (1 … 5). */
const SCORE_MAX = 5
/** The lowest score. */
const SCORE_MIN = 1
/** The API's own "unscored" value, and the slider's dedicated "Not scored" stop. */
const UNSCORED = 0

interface ScoreSliderProps {
  readonly label: string
  /** The axis value on screen (saved, or the reader's unsaved choice), where 0 means UNSCORED. */
  readonly value: number
  readonly onChange: (v: number) => void
  /**
   * Whether this reviewer's SAVED ballot leaves the axis unscored. Only then does the
   * slider offer its "Not scored" stop and the Clear button: a save cannot un-score a
   * stored axis (the API reads 0 as "leave unchanged"), so offering either over a
   * stored score would show "Not scored" for a value the save then keeps.
   */
  readonly canBeUnscored: boolean
  readonly description?: string
  readonly lowLabel?: string
  readonly highLabel?: string
  readonly inverted?: boolean
}

/** The badge beside the label: the value, or a visible "Not scored". */
function ValueBadge({ value, inverted }: { readonly value: number; readonly inverted: boolean }) {
  const { t } = useTranslation('prioritization')
  if (value === UNSCORED) {
    return <span className="text-xs font-medium px-2 py-0.5 rounded-sm bg-bg-hover text-text">{t('scores.notScored')}</span>
  }
  return <span className={clsx('text-sm font-bold px-2 py-0.5 rounded-sm', getScoreColor(inverted ? SCORE_MIN + SCORE_MAX - value : value))}>{value}</span>
}

/** Returns an unsaved choice to "Not scored"; named after the axis for assistive technology. */
function ClearButton({ label, onClear }: { readonly label: string; readonly onClear: () => void }) {
  const { t } = useTranslation('prioritization')
  return (
    <button
      type="button"
      onClick={onClear}
      aria-label={t('scores.clearAxis', { name: label })}
      className="btn btn-ghost btn-sm inline-flex items-center gap-1"
    >
      <X size={12} aria-hidden="true" />
      {t('scores.clear')}
    </button>
  )
}

/**
 * One axis of the caller's own ballot.
 *
 * "Not scored" is its OWN position, distinct from every score (decision, 5.35): a
 * native range cannot be empty, and resting an unscored handle on 3 meant choosing 3
 * changed nothing — no `change` event, so the axis stayed unscored and announced
 * "Not scored" while the handle sat on 3. With an unscored stop below 1, the first
 * interaction of any kind (a click or drag on any number, an arrow key, Home/End)
 * is a real change, and `aria-valuetext` always names the real value. Clear returns
 * an unsaved choice to "Not scored" in one press; Home does the same from the keyboard.
 */
export default function ScoreSlider({
  label, value, onChange, canBeUnscored, description, lowLabel = '1', highLabel = '5', inverted = false,
}: ScoreSliderProps) {
  const { t } = useTranslation('prioritization')
  const inputId = useId()
  const labelId = useId()
  const descriptionId = useId()
  const hasDescription = description != null && description !== ''
  const unscored = value === UNSCORED
  const minimum = canBeUnscored ? UNSCORED : SCORE_MIN
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center gap-2">
        <label id={labelId} htmlFor={inputId} className="text-sm font-medium text-text">{label}</label>
        <div className="flex items-center gap-2">
          {canBeUnscored && !unscored ? <ClearButton label={label} onClear={() => onChange(UNSCORED)} /> : null}
          <ValueBadge value={value} inverted={inverted} />
        </div>
      </div>
      {hasDescription ? <p id={descriptionId} className="text-xs text-muted">{description}</p> : null}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted w-16">{lowLabel}</span>
        <input
          id={inputId}
          type="range"
          min={minimum}
          max={SCORE_MAX}
          step={1}
          value={Math.max(minimum, value)}
          /* Named by the visible label explicitly, not only through `htmlFor`, so
             every accessibility tree (and audit) reads the axis name off the slider. */
          aria-labelledby={labelId}
          aria-label={label}
          aria-describedby={hasDescription ? descriptionId : undefined}
          aria-valuetext={unscored ? t('scores.notScored') : t('scores.valueOfMax', { value, max: SCORE_MAX })}
          onChange={(e) => onChange(Number(e.target.value))}
          className={clsx('range flex-1 w-auto', unscored && 'range-unscored')}
        />
        <span className="text-xs text-muted w-16 text-right">{highLabel}</span>
      </div>
    </div>
  )
}
