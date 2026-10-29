/**
 * @fileoverview The document wizard's "Amazon's 5 Customer Questions" section (PR/FAQ only).
 *
 * The five answers stay editable at all times (a person may type first); only the AI
 * button waits for the title and description, which every answer is grounded in.
 * @module pages/ProjectDetail/DocWizardQuestions
 */
import { useTranslation } from 'react-i18next'
import AIDraftButton from '../../components/AIDraftButton/AIDraftButton'
import { AI_DRAFT_LIMITS } from '../../api/aiDraft'
import type { AiDraft } from './useDocWizardDrafts'

interface DocWizardQuestionsProps {
  readonly answers: readonly string[]
  readonly onAnswerChange: (index: number, value: string) => void
  readonly draft: AiDraft
  /** Title and description are both filled: the AI button may run. */
  readonly briefReady: boolean
  readonly onDraft: () => void
  /** Human-driven on PR/FAQs: the answers are the person's own, so no AI draft button. */
  readonly aiLocked?: boolean
}

export function DocWizardQuestions({ answers, onAnswerChange, draft, briefReady, onDraft, aiLocked = false }: DocWizardQuestionsProps) {
  const { t } = useTranslation('projectDetail')
  // Pulled from i18n so the whole wizard matches the chosen language.
  const questions = [1, 2, 3, 4, 5].map((n) => ({
    title: t(`wizards.question${n}Title`),
    description: t(`wizards.question${n}Desc`),
    placeholder: t(`wizards.question${n}Placeholder`),
  }))
  const hasText = answers.some((answer) => answer.trim() !== '')

  return (
    <div className="border-t pt-6">
      <div className="flex items-start justify-between gap-2 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <h3 className="font-medium">{t('wizards.amazonQuestions')}</h3>
          {/* A methodology name is a descriptive label, not a success: neutral (labels vs status). */}
          <span className="badge badge-muted">{t('wizards.workingBackwards', { defaultValue: 'Working Backwards' })}</span>
        </div>
        {aiLocked ? null : (
          <AIDraftButton
            subject={t('wizards.answersSubject')}
            hasText={hasText}
            busy={draft.busy}
            onClick={onDraft}
            hint={t('wizards.autofillTitle')}
            disabledReason={briefReady ? null : t('wizards.answersNeedBrief')}
            error={draft.error}
          />
        )}
      </div>
      <p className="text-sm text-muted mb-4">{t('wizards.amazonQuestionsHint')}</p>
      <div className="space-y-4">
        {questions.map((q, index) => (
          <div key={q.title} className="bg-bg-accent rounded-lg p-4">
            <div className="flex items-start gap-2 mb-2">
              <span aria-hidden="true" className="flex-shrink-0 w-6 h-6 bg-bg-hover text-text-strong rounded-full font-mono flex items-center justify-center text-xs font-medium">
                {index + 1}
              </span>
              <div className="flex-1">
                <h4 className="font-medium text-text-strong">{q.title}</h4>
                <p className="text-xs text-muted mt-0.5">{q.description}</p>
              </div>
            </div>
            <textarea
              aria-label={q.title}
              value={answers[index] ?? ''}
              onChange={(e) => onAnswerChange(index, e.target.value)}
              placeholder={q.placeholder}
              maxLength={AI_DRAFT_LIMITS.answer}
              rows={3}
              className="input mt-2"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
