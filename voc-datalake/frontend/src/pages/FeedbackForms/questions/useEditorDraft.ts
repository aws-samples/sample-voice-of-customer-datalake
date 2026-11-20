/**
 * @fileoverview What a card's editor (a question's, an ending's) works on: the form's draft, the builder's way to
 * another place (a rule's Fix, the Logic tab), the form as it stands and its primary language (`lng`), the one its
 * texts are edited in.
 *
 * @module pages/FeedbackForms/questions/useEditorDraft
 */
import { useBuilderUi } from '../builder/builderUi'
import { useDraft } from '../builder/formDraftContext'
import type { BuilderUi } from '../builder/builderUi'
import type { FormDraft } from '../builder/formDraftContext'
import type { FormLanguage, FormV2 } from '../model/formsV2'
import { problemsAt } from '../model/validateForm'
import type { FormProblem } from '../model/validateForm'

export function useEditorDraft(): { draft: FormDraft; go: BuilderUi['go']; form: FormV2; lng: FormLanguage } {
  const draft = useDraft()
  const { go } = useBuilderUi()
  return { draft, go, form: draft.form, lng: draft.form.language }
}

/** What a question's own fields read: the form's primary language (`lng`), the one its texts are edited in, and the
 * problems located on that question. */
export function useQuestionFields(questionId: string): { lng: FormLanguage; problems: FormProblem[] } {
  const draft = useDraft()
  return { lng: draft.form.language, problems: problemsAt(draft.problems, 'question', questionId) }
}
