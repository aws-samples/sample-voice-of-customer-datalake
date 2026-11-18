/**
 * @fileoverview Rating, NPS, CSAT and CES (UX §4.2): a rating's scale (stars, numbers, faces) and points (faces come
 * in 3 to 5), the fixed scales' groups as text, the optional end labels, and NPS's "Ask detractors and promoters
 * different questions" while it has no rules (two long-text follow-ups after it, with Undo).
 *
 * @module pages/FeedbackForms/questions/ScaleEditor
 */
import { useTranslation } from 'react-i18next'
import { GitBranch } from 'lucide-react'
import type { RatingQuestion, RatingRange, RatingScale, ScoreQuestion } from '../model/formsV2'
import { RATING_RANGES } from '../model/formsV2'
import { textIn, withText } from '../model/i18nText'
import { useDraft } from '../builder/formDraftContext'
import Segmented from '../ui/Segmented'
import { useAnnounce } from './statusLineContext'
import { withNpsFollowUps } from './npsHelper'
import { TextField } from './fields'

type Scaled = RatingQuestion | ScoreQuestion

const FACES_MAX = 5

function RatingFields({ question, onChange }: Readonly<{ question: RatingQuestion; onChange: (q: Scaled) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const faces = question.scale === 'smiley'
  const setScale = (scale: RatingScale) => onChange({ ...question, scale, range: scale === 'smiley' && question.range > FACES_MAX ? FACES_MAX : question.range })
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-text">{t('scale.scale')}</p>
        <Segmented label={t('scale.scale')} value={question.scale} onChange={setScale}
          choices={(['star', 'number', 'smiley'] as const).map((value) => ({ value, label: t(`scale.scales.${value}`) }))} />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-text">{t('scale.points')}</p>
        <Segmented label={t('scale.points')} value={String(question.range)}
          onChange={(value) => {
            const range = RATING_RANGES.find((r) => String(r) === value)
            if (range !== undefined) onChange({ ...question, range })
          }}
          choices={RATING_RANGES.map((range: RatingRange) => ({
            value: String(range), label: String(range), disabledReason: faces && range > FACES_MAX ? t('scale.facesRange') : undefined,
          }))} />
        {faces && <p className="text-[12px] text-muted">{t('scale.facesRange')}</p>}
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
    draft.update((form) => withNpsFollowUps(form, question.id))
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
  const { form } = useDraft()
  const lng = form.language
  return (
    <div className="space-y-3">
      {question.type === 'rating' ? <RatingFields question={question} onChange={onChange} /> : <FixedScale question={question} />}
      <div className="grid gap-2 sm:grid-cols-2">
        <TextField label={t('scale.lowEnd')} value={textIn(question.lower_label, lng)}
          onChange={(value) => onChange({ ...question, lower_label: withText(question.lower_label, lng, value) })} />
        <TextField label={t('scale.highEnd')} value={textIn(question.upper_label, lng)}
          onChange={(value) => onChange({ ...question, upper_label: withText(question.upper_label, lng, value) })} />
      </div>
    </div>
  )
}
