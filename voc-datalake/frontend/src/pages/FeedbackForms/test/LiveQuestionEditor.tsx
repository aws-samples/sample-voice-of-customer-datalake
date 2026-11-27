/**
 * @fileoverview The editor of one question as the Questions tab gives it (re-read from the draft on every render), for
 * the editors' specs.
 *
 * @module pages/FeedbackForms/test/LiveQuestionEditor
 */
import { useDraft } from '../builder/formDraftContext'
import QuestionEditor from '../questions/QuestionEditor'

/** The editor of question `id`, read from the draft on every render. */
export default function LiveQuestionEditor({ id }: Readonly<{ id: string }>) {
  const { form } = useDraft()
  const index = form.questions.findIndex((q) => q.id === id)
  const question = form.questions[index]
  return question === undefined ? null : <QuestionEditor question={question} index={index} />
}
