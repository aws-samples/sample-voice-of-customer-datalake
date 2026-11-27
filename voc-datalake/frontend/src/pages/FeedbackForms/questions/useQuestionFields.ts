/**
 * @fileoverview What a question's own fields read from the draft: the form's primary language (`lng`), the one its
 * texts are edited in, and the problems located on that question (each field shows its own under it).
 *
 * @module pages/FeedbackForms/questions/useQuestionFields
 */
import { useDraft } from '../builder/formDraftContext'
import { problemsAt } from '../model/validateForm'
import type { FormLanguage } from '../model/formsV2'
import type { FormProblem } from '../model/validateForm'

export function useQuestionFields(questionId: string): { lng: FormLanguage; problems: FormProblem[] } {
  const draft = useDraft()
  return { lng: draft.form.language, problems: problemsAt(draft.problems, 'question', questionId) }
}
