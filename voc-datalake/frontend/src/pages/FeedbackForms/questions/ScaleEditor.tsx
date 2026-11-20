/**
 * @fileoverview Rating, NPS, CSAT and CES (UX §4.2): a rating's scale (stars, numbers, faces) and points (faces come
 * in 3 to 5), the fixed scales' groups as text, the optional end labels, and NPS's "Ask detractors and promoters
 * different questions" while it has no rules (two long-text follow-ups after it, with Undo), and on every one "Ask why
 * when the score is low" while it has no rules (7.63.00, AskWhyButton). Once the form has a real
 * response a rating it had keeps its points (D9: its answers are read on them), so no other range, nor Faces on more
 * than 5 points, is offered; the reason says so.
 *
 * @module pages/FeedbackForms/questions/ScaleEditor
 */
import { useTranslation } from 'react-i18next'
import { GitBranch } from 'lucide-react'
import type { RatingQuestion, RatingRange, RatingScale, ScoreQuestion } from '../model/formsV2'
import { RATING_RANGES } from '../model/formsV2'
import { textIn, withText } from '../model/i18nText'
import { answeredVersion, useDraft } from '../builder/formDraftContext'
import Segmented from '../ui/Segmented'
import { useAnnounce } from './statusLineContext'
import { withNpsFollowUps } from './npsHelper'
import { TextField } from './fields'
import { fieldProblems } from './fieldHelpers'
import { useQuestionFields } from './useEditorDraft'
import AskWhyButton from './AskWhyButton'

type Scaled = RatingQuestion | ScoreQuestion

const FACES_MAX = 5

/** Why a range can't be chosen: an answered rating's points are its stored ones (`lockedRange`); Faces take 3 to 5. */
function rangeReason(t: (key: string) => string, range: RatingRange, faces: boolean, lockedRange: number | null): string | undefined {
  if (lockedRange !== null && range !== lockedRange) return t('scale.rangeLocked')
  return faces && range > FACES_MAX ? t('scale.facesRange') : undefined
}

function RatingFields({ question, onChange }: Readonly<{ question: RatingQuestion; onChange: (q: Scaled) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const stored = answeredVersion(draft, question.id)
  const lockedRange = stored?.type === 'rating' ? stored.range : null
  const faces = question.scale === 'smiley'
  const setScale = (scale: RatingScale) => onChange({ ...question, scale, range: scale === 'smiley' && question.range > FACES_MAX ? FACES_MAX : question.range })
  // (Faces on more than 5 points would change an answered rating's points)
  const facesLocked = lockedRange !== null && lockedRange > FACES_MAX
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-text">{t('scale.scale')}</p>
        <Segmented label={t('scale.scale')} value={question.scale} onChange={setScale}
          choices={(['star', 'number', 'smiley'] as const).map((value) => ({
            value, label: t(`scale.scales.${value}`), disabledReason: value === 'smiley' && facesLocked ? t('scale.rangeLocked') : undefined,
          }))} />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-text">{t('scale.points')}</p>
        <Segmented label={t('scale.points')} value={String(question.range)}
          onChange={(value) => {
            const range = RATING_RANGES.find((r) => String(r) === value)
            if (range !== undefined) onChange({ ...question, range })
          }}
          choices={RATING_RANGES.map((range: RatingRange) => ({
            value: String(range), label: String(range), disabledReason: rangeReason(t, range, faces, lockedRange),
          }))} />
        {lockedRange !== null && <p className="text-[12px] text-muted">{t('scale.rangeLocked')}</p>}
        {faces && lockedRange === null && <p className="text-[12px] text-muted">{t('scale.facesRange')}</p>}
      </div>
    </div>
  )
}

function FixedScale({ question }: Readonly<{ question: ScoreQuestion }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const announce = useAnnounce()
  if (question.type !== 'nps') return <p className="text-[13px] text-text">{t(`scale.fixed.${question.type}`)}</p>
  const hasRules = (question.logic ?? []).length > 0
  const help = () => {
    const before = draft.form
    draft.update((form) => withNpsFollowUps(form, question.id, draft.retiredIds))
    announce({ message: t('scale.npsHelper.done'), undo: () => draft.update(() => before) })
  }
  return (
    <div className="space-y-2">
      <p className="text-[13px] text-text">{t('scale.fixed.nps')}</p>
      <p className="text-[12px] text-muted">{t('scale.npsGroups')}</p>
      {!hasRules && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={help}>
          <GitBranch size={14} aria-hidden="true" />{t('scale.npsHelper.button')}
        </button>
      )}
    </div>
  )
}

export default function ScaleEditor({ question, onChange }: Readonly<{ question: Scaled; onChange: (q: Scaled) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const { lng, problems } = useQuestionFields(question.id)
  return (
    <div className="space-y-3">
      {question.type === 'rating' ? <RatingFields question={question} onChange={onChange} /> : <FixedScale question={question} />}
      <AskWhyButton question={question} />
      <div className="grid gap-2 sm:grid-cols-2">
        <TextField label={t('scale.lowEnd')} value={textIn(question.lower_label, lng)} problems={fieldProblems(problems, 'lower_label')}
          onChange={(value) => onChange({ ...question, lower_label: withText(question.lower_label, lng, value) })} />
        <TextField label={t('scale.highEnd')} value={textIn(question.upper_label, lng)} problems={fieldProblems(problems, 'upper_label')}
          onChange={(value) => onChange({ ...question, upper_label: withText(question.upper_label, lng, value) })} />
      </div>
    </div>
  )
}
