/**
 * @fileoverview "Ask why when the score is low" (7.63.00, model/askWhy.ts): the score editors' preset. It adds an
 * optional open text after the score that only a low score reaches, its headline recalling the score in the form's
 * language, with Undo. Shown while the question has no rules of its own.
 *
 * @module pages/FeedbackForms/questions/AskWhyButton
 */
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { MessageCircleQuestionMark } from 'lucide-react'
import type { RatingQuestion, ScoreQuestion } from '../model/formsV2'
import { canAskWhy, lowScoreThreshold, withAskWhy } from '../model/askWhy'
import { useDraft } from '../builder/formDraftContext'
import { useAnnounce } from './statusLineContext'

export default function AskWhyButton({ question }: Readonly<{ question: RatingQuestion | ScoreQuestion }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const announce = useAnnounce()
  if (!canAskWhy(question)) return null
  const threshold = lowScoreThreshold(question)
  const lng = draft.form.language
  // (in the form's language, as the NPS helper writes its follow-ups; the placeholder is the score's own)
  const headline = (placeholder: string) => i18n.t('feedbackForms:scale.askWhy.headline', { lng, recall: placeholder })
  const add = () => {
    const before = draft.form
    const made = withAskWhy(before, question.id, headline, draft.retiredIds)
    if (made === null) return
    draft.update(() => made)
    announce({ message: t('scale.askWhy.done'), undo: () => draft.update(() => before) })
  }
  return (
    <div className="space-y-1">
      <button type="button" className="btn btn-secondary btn-sm" onClick={add}>
        <MessageCircleQuestionMark size={14} aria-hidden="true" />{t('scale.askWhy.button')}
      </button>
      <p className="text-[12px] text-muted">{t('scale.askWhy.hint', { threshold })}</p>
    </div>
  )
}
