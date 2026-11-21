/**
 * @fileoverview The questions of an imported form's inferred definition (lambda/shared/import_survey.py
 * `infer_form`), read for the Confirm step's preview and First insights' NPS: any entry that does not parse is left
 * out (the server validated the definition; this is only what the wizard shows).
 *
 * @module pages/Scrapers/ImportWizard/inferredQuestions
 */
import { z } from 'zod'
import type { InferredForm } from '../../../api/importWizardSchema'

const QUESTION_TYPES = ['single_select', 'multi_select', 'open_text', 'rating', 'nps', 'csat', 'ces', 'statement',
  'consent', 'contact_info', 'matrix'] as const
const questionSchema = z.object({
  id: z.string(),
  type: z.enum(QUESTION_TYPES),
  headline: z.record(z.string(), z.string()).catch({}),
  long: z.boolean().optional(),
  options: z.array(z.unknown()).optional(),
  rows: z.array(z.unknown()).optional(),
  columns: z.array(z.unknown()).optional(),
})
export type InferredQuestion = z.infer<typeof questionSchema>

export function inferredQuestions(form: InferredForm): InferredQuestion[] {
  const raw = form.definition.questions
  return Array.isArray(raw) ? raw.flatMap((entry) => {
    const parsed = questionSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  }) : []
}
