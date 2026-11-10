/**
 * @fileoverview The form half of the anonymous ballot page: the configured metrics to rate,
 * an optional note, an optional display name, submit.
 *
 * Split from `Vote.tsx` so the page owns the session's STATE (open, closed,
 * expired, full, done) and this owns the FORM. They fail differently — one is
 * about a room, the other about one phone — and `max-lines` is 600.
 *
 * Native `<input type="range">` sliders, like `ScoreSlider` on the prioritization
 * page, because a range input is the one rating control every mobile browser
 * already handles: it is touch-sized, it is announced by a screen reader with its
 * value, and it needs no gesture library on a page a stranger opens once.
 *
 * @module pages/Vote/BallotForm
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MAX_BALLOT_DISPLAY_NAME_LENGTH, MAX_BALLOT_NOTE_LENGTH } from './ballotBounds'
import type { AnonymousBallot } from '../../api/votingSessionsApi'
import type { ScoringAxis } from '../../api/prioritizationAxes'
import { axisText } from '../Prioritization/axisText'
import type { ReactElement } from 'react'

/**
 * Where every slider starts.
 *
 * The MIDDLE of the range, deliberately, and every axis alike: a submitter is a
 * person in a room with no stored ballot to restore, so there is nothing to
 * default to except a neutral position. This is a REAL 3 that the submit sends
 * — every axis goes in the body, so an unmoved slider casts a genuine neutral
 * vote — which is different from the signed-in page's unscored state, where a
 * slider showing no value sends nothing and the axis stays unrecorded
 * (`ScoreSlider`, #343). A room glancing at a phone gets a position to accept
 * or move; a reviewer at a desk gets an honest "you have not scored this".
 */
const NEUTRAL = 3

/** Every configured metric starts at the neutral middle. */
const initialValues = (axes: readonly ScoringAxis[]): Record<string, number> => (
  Object.fromEntries(axes.map((axis) => [axis.id, NEUTRAL]))
)

function BallotSlider({
  label, hint, lowLabel, highLabel, value, onChange,
}: {
  readonly label: string
  readonly hint: string
  /** What 1 and 5 mean, so "5" on a lower-is-better metric (Effort) is not misread. */
  readonly lowLabel: string
  readonly highLabel: string
  readonly value: number
  readonly onChange: (next: number) => void
}): ReactElement {
  const inputId = useId()
  const labelId = useId()
  const hintId = useId()
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <label id={labelId} htmlFor={inputId} className="font-medium text-text-strong">{label}</label>
        <span className="text-lg font-bold font-mono text-accent-text tabular-nums">{value}</span>
      </div>
      {hint === '' ? null : <p id={hintId} className="text-sm text-muted">{hint}</p>}
      {/* `h-8` rather than the default track height: this is operated with a thumb
          on a phone held at arm's length, and the hit area is the whole control. */}
      <input
        id={inputId}
        type="range"
        min={1}
        max={5}
        step={1}
        value={value}
        aria-labelledby={labelId}
        aria-describedby={hint === '' ? undefined : hintId}
        onChange={(e) => onChange(Number(e.target.value))}
        className="range"
      />
      <div className="flex justify-between text-xs text-muted" aria-hidden="true">
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
    </div>
  )
}

/**
 * The ballot, and the button that casts it.
 *
 * @param onSubmit hands the composed ballot to the page, which owns the request
 *   and the result. Everything the SESSION can refuse belongs there.
 * @param isSubmitting disables the button while a submission is in flight, so a
 *   double tap on a slow phone cannot mint a second ballot and spend a second
 *   slot of the session's cap.
 */
export default function BallotForm({
  axes, onSubmit, isSubmitting,
}: {
  /** The ACTIVE metrics of the workspace scoring setup, from the public config. */
  readonly axes: readonly ScoringAxis[]
  readonly onSubmit: (ballot: AnonymousBallot) => void
  readonly isSubmitting: boolean
}): ReactElement {
  const { t } = useTranslation('prioritization')
  const [values, setValues] = useState<Record<string, number>>(() => initialValues(axes))
  const [notes, setNotes] = useState('')
  const [displayName, setDisplayName] = useState('')
  const notesId = useId()
  const nameId = useId()
  const nameHintId = useId()

  return (
    <form
      className="card p-4 sm:p-5 space-y-6"
      onSubmit={(e) => {
        e.preventDefault()
        // Every axis is sent, because every slider has a position the submitter
        // could see and could have moved. Omitting the untouched ones would be a
        // guess about which of four visible numbers they meant, and the API reads
        // an absent axis as "say nothing" — so an unmoved slider showing 3 would
        // silently not count.
        onSubmit({
          // Only the metrics on screen, each under its id — never a stale one.
          ...Object.fromEntries(axes.map((axis) => [axis.id, values[axis.id] ?? NEUTRAL])),
          // Trimmed to nothing rather than sent as blanks: the API stores what it
          // is given, and '' is not a note or a name.
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
        })
      }}
    >
      {/* One slider per configured metric. Built-in names and hints come from the
          catalogues through namespace-qualified keys (`axisText`), so i18n-check sees
          them; a custom metric shows the name an admin gave it. */}
      {axes.map((axis) => {
        const text = axisText(axis, t, 'ballot')
        return (
          <BallotSlider
            key={axis.id}
            label={text.name}
            hint={text.description}
            lowLabel={text.lowLabel}
            highLabel={text.highLabel}
            value={values[axis.id] ?? NEUTRAL}
            onChange={(next) => setValues((prev) => ({ ...prev, [axis.id]: next }))}
          />
        )
      })}

      <div className="space-y-1">
        <label htmlFor={notesId} className="font-medium text-text-strong">{t('ballot.notes.label')}</label>
        {/* Bounded by the same number the API refuses past, so this page cannot
            compose a body that comes back 400 with a reason it could not show.
            `maxLength` counts UTF-16 code units where the API counts code points,
            which makes it the STRICTER of the two for astral characters — safe in
            this direction: it can only stop typing that the API would have
            accepted, never allow a body it would refuse. */}
        <textarea
          id={notesId}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={MAX_BALLOT_NOTE_LENGTH}
          placeholder={t('ballot.notes.placeholder')}
          className="input"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor={nameId} className="font-medium text-text-strong">{t('ballot.displayName.label')}</label>
        {/* Says plainly that this is the ONE field that could identify the
            submitter, and that leaving it blank is the normal thing to do. A
            room's vote is anonymous; an optional name is a courtesy, not the
            price of voting. */}
        <p id={nameHintId} className="text-sm text-muted">{t('ballot.displayName.hint')}</p>
        <input
          id={nameId}
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={MAX_BALLOT_DISPLAY_NAME_LENGTH}
          aria-describedby={nameHintId}
          autoComplete="off"
          className="input"
        />
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="btn btn-primary w-full py-3"
      >
        {isSubmitting ? t('ballot.submit.pending') : t('ballot.submit.label')}
      </button>
    </form>
  )
}
