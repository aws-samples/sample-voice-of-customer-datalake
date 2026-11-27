/**
 * @fileoverview A form's Results as Results › Summary and the Share tab's link checks read them: one query per form
 * and filters (`GET /feedback-forms/{id}/results`), so two views of the same filters share one read.
 *
 * @module pages/FeedbackForms/results/useFormResults
 */
import { useQuery } from '@tanstack/react-query'
import { formResultsKey } from '../../../api/feedbackFormQueryKeys'
import { feedbackFormsV2Api } from '../../../api/feedbackFormsV2Api'
import type { ResultsFilters } from '../../../api/feedbackFormsV2Api'

/** Every real response, all time: what the Share tab's link checks count. */
export const ALL_REAL_RESPONSES: ResultsFilters = { days: null, language: '', ending: '', hidden: {}, includeTest: false }

export function useFormResults(formId: string, filters: ResultsFilters) {
  return useQuery({ queryKey: formResultsKey(formId, filters), queryFn: () => feedbackFormsV2Api.getResults(formId, filters) })
}
