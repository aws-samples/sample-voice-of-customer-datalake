/**
 * @fileoverview The form half of the anonymous ballot page: four things to rate,
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
import type { ReactElement } from 'react'

/**
 * Where every slider starts.
 *
 * The MIDDLE of the range, deliberately, and every axis alike: a submitter is a
 * person in a room with no stored ballot to restore, so there is nothing to
 * default to except a neutral position. It matches the value the prioritization
 * page shows for an unset axis (`score.impact === 0 ? 3 : …`), so a ballot cast
 * here without touching a slider reads the same as the signed-in page's own
 * untouched row rather than as an emphatic zero.
 */
const NEUTRAL = 3

/** The four axes a ballot scores — the same four the signed-in page scores, so an
 *  anonymous ballot enters the aggregate as one more reviewer rather than as a
 *  differently-shaped record. */
type AxisField = 'impact' | 'time_to_market' | 'strategic_fit' | 'confidence'

const INITIAL_AXES: Record<AxisField, number> = {
  impact: NEUTRAL,
  time_to_market: NEUTRAL,
  strategic_fit: NEUTRAL,
  confidence: NEUTRAL,
}

function BallotSlider({
  label, hint, value, onChange,
}: {
  readonly label: string
  readonly hint: string
  readonly value: number
  readonly onChange: (next: number) => void
}): ReactElement {
  const inputId = useId()
  const hintId = useId()
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={inputId} className="font-medium text-gray-900">{label}</label>
        <span className="text-lg font-bold text-blue-700 tabular-nums">{value}</span>
      </div>
      <p id={hintId} className="text-sm text-gray-600">{hint}</p>
      {/* `h-8` rather than the default track height: this is operated with a thumb
          on a phone held at arm's length, and the hit area is the whole control. */}
      <input
        id={inputId}
        type="range"
        min={1}
        max={5}
        step={1}
        value={value}
        aria-describedby={hintId}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-8 accent-blue-600"
      />
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
  onSubmit, isSubmitting,
}: {
  readonly onSubmit: (ballot: AnonymousBallot) => void
  readonly isSubmitting: boolean
}): ReactElement {
  const { t } = useTranslation('prioritization')
  const [axes, setAxes] = useState<Record<AxisField, number>>(INITIAL_AXES)
  const [notes, setNotes] = useState('')
  const [displayName, setDisplayName] = useState('')
  const notesId = useId()
  const nameId = useId()
  const nameHintId = useId()

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault()
        // Every axis is sent, because every slider has a position the submitter
        // could see and could have moved. Omitting the untouched ones would be a
        // guess about which of four visible numbers they meant, and the API reads
        // an absent axis as "say nothing" — so an unmoved slider showing 3 would
        // silently not count.
        onSubmit({
          ...axes,
          // Trimmed to nothing rather than sent as blanks: the API stores what it
          // is given, and '' is not a note or a name.
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
        })
      }}
    >
      {/* Four sliders written out rather than mapped over a list of key names,
          because `scripts/i18n-check.mjs` only sees a key it reads VERBATIM: keys
          held in a lookup table are reported unused and become deletion
          candidates in a cleanup pass, leaving a room looking at raw key paths.
          Same trap `SCORABLE_TYPE_META` and `unscoredLabel` document. */}
      <BallotSlider
        label={t('ballot.axes.impact')}
        hint={t('ballot.axes.impactHint')}
        value={axes.impact}
        onChange={(next) => setAxes((prev) => ({ ...prev, impact: next }))}
      />
      <BallotSlider
        label={t('ballot.axes.timeToMarket')}
        hint={t('ballot.axes.timeToMarketHint')}
        value={axes.time_to_market}
        onChange={(next) => setAxes((prev) => ({ ...prev, time_to_market: next }))}
      />
      <BallotSlider
        label={t('ballot.axes.strategicFit')}
        hint={t('ballot.axes.strategicFitHint')}
        value={axes.strategic_fit}
        onChange={(next) => setAxes((prev) => ({ ...prev, strategic_fit: next }))}
      />
      <BallotSlider
        label={t('ballot.axes.confidence')}
        hint={t('ballot.axes.confidenceHint')}
        value={axes.confidence}
        onChange={(next) => setAxes((prev) => ({ ...prev, confidence: next }))}
      />

      <div className="space-y-1">
        <label htmlFor={notesId} className="font-medium text-gray-900">{t('ballot.notes.label')}</label>
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
          className="w-full px-3 py-2 border rounded-lg"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor={nameId} className="font-medium text-gray-900">{t('ballot.displayName.label')}</label>
        {/* Says plainly that this is the ONE field that could identify the
            submitter, and that leaving it blank is the normal thing to do. A
            room's vote is anonymous; an optional name is a courtesy, not the
            price of voting. */}
        <p id={nameHintId} className="text-sm text-gray-600">{t('ballot.displayName.hint')}</p>
        <input
          id={nameId}
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={MAX_BALLOT_DISPLAY_NAME_LENGTH}
          aria-describedby={nameHintId}
          autoComplete="off"
          className="w-full px-3 py-2 border rounded-lg"
        />
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full px-4 py-3 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500"
      >
        {isSubmitting ? t('ballot.submit.pending') : t('ballot.submit.label')}
      </button>
    </form>
  )
}
