/**
 * @fileoverview Score slider component for prioritization scoring.
 * @module pages/Prioritization/ScoreSlider
 */

import clsx from 'clsx'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { getScoreColor } from './prioritizationUtils'

/**
 * Where an unscored slider's handle rests. A range input must hold SOME
 * position — `min={1}` cannot represent "no value" — so the handle sits in the
 * middle while the badge and `aria-valuetext` say "not scored". The position is
 * presentation only: it is never written anywhere until the reader drags, at
 * which point `onChange` reports the dragged value and the axis becomes real.
 */
const UNSCORED_HANDLE_POSITION = 3

interface ScoreSliderProps {
  readonly label: string
  /** The stored axis value, where 0 means UNSCORED (the API's own contract). */
  readonly value: number
  readonly onChange: (v: number) => void
  readonly description?: string
  readonly lowLabel?: string
  readonly highLabel?: string
  readonly inverted?: boolean
}

/**
 * One axis of the caller's own ballot.
 *
 * An axis nobody scored (value 0) renders as UNSCORED — a dash in the badge, a
 * muted handle, and `aria-valuetext` saying so — rather than as a 3. Painting a
 * 3 was #343: the editor asserted a mid-range value the record did not hold,
 * indistinguishable from a stored 3, so a reviewer could never discover on
 * screen that three quarters of their ballot was recorded as nothing. The dash
 * cannot be misread as a score, which is the same rule the team summary's em
 * dash follows one level up.
 */
export default function ScoreSlider({
  label, value, onChange, description, lowLabel = '1', highLabel = '5', inverted = false,
}: ScoreSliderProps) {
  const { t } = useTranslation('prioritization')
  const unscored = value === 0
  const position = unscored ? UNSCORED_HANDLE_POSITION : value
  // Was the press that is now ending a press ON THIS CONTROL? `pointerup` also
  // fires when a pointer that went down elsewhere is released over the input,
  // and that stray release must not cast a vote. A ref, not state: it changes
  // nothing on screen.
  const pressedHere = useRef(false)
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <label className="text-sm font-medium text-gray-700">{label}</label>
        {unscored ? (
          /* The dash is decorative (the same treatment as the team summary's);
             the state itself is announced on the input via aria-valuetext, which
             is where a screen reader is listening. */
          <span className="text-sm font-bold px-2 py-0.5 rounded bg-gray-100 text-gray-600" aria-hidden="true">—</span>
        ) : (
          <span className={clsx('text-sm font-bold px-2 py-0.5 rounded', getScoreColor(inverted ? 6 - value : value))}>{value}</span>
        )}
      </div>
      {description != null && description !== '' ? <p className="text-xs text-gray-500">{description}</p> : null}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400 w-16">{lowLabel}</span>
        <input
          type="range"
          min={1}
          max={5}
          value={position}
          aria-valuetext={unscored ? t('scores.notScored') : undefined}
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerDown={() => { pressedHere.current = true }}
          /* A reader who wants EXACTLY the resting position: clicking the track
             at 3 leaves the value unchanged, so `onChange` never fires and the
             axis would stay unscored with no way to say "3" short of wiggling.
             Releasing a press that STARTED on an unscored slider commits the
             value the control holds at release — read off the DOM, not off this
             render's props, because on a click-at-5 the `change` event fires
             first and a stale closure would rewrite that deliberate 5 back to
             the resting 3 if the re-render has not flushed. `pressedHere` keeps
             a pointer that went down elsewhere and was released over the input
             from casting a vote nobody aimed at it. (Keyboard readers are
             covered by onChange itself: the first arrow key scores the axis.) */
          onPointerUp={(e) => {
            const pressed = pressedHere.current
            pressedHere.current = false
            if (unscored && pressed) onChange(Number(e.currentTarget.value))
          }}
          className={clsx(
            'flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer',
            unscored ? 'accent-gray-400' : 'accent-blue-600',
          )}
        />
        <span className="text-xs text-gray-400 w-16 text-right">{highLabel}</span>
      </div>
    </div>
  )
}
