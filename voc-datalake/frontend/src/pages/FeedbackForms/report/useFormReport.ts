/**
 * @fileoverview The Report's reads and its one write (7.63.00): the report under the Results filters and a segment,
 * the comparison with other forms, and "Summarize with AI", which reads the view's open-text answers with the person's
 * own access (up to 300, newest first: `GET …/responses`, three pages of 100), sends them to the summary job, and
 * reads the report again once it is stored.
 *
 * @module pages/FeedbackForms/report/useFormReport
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { feedbackFormsKey } from '../../../api/feedbackFormQueryKeys'
import { feedbackFormsV2Api, summaryFilters } from '../../../api/feedbackFormsV2Api'
import type { ResultsFilters } from '../../../api/feedbackFormsV2Api'
import { SUMMARY_LIMITS, summaryAnswers } from '../../../api/feedbackFormsReport'
import type { FormResponse } from '../../../api/feedbackFormsV2Results'
import type { FormV2 } from '../model/formsV2'

const PAGE = 100

/** The report's queries, under the forms list's prefix (a form's save or delete refreshes them too). */
const reportKey = (formId: string, filters: ResultsFilters, groupBy: string | null) =>
  [...feedbackFormsKey(), formId, 'report', filters, groupBy] as const
const compareKey = (formId: string, filters: ResultsFilters, withIds: readonly string[], by: string | null) =>
  [...feedbackFormsKey(), formId, 'compare', filters, withIds, by] as const

export function useFormReport(formId: string, filters: ResultsFilters, groupBy: string | null) {
  return useQuery({ queryKey: reportKey(formId, filters, groupBy), queryFn: () => feedbackFormsV2Api.getReport(formId, filters, groupBy) })
}

export function useFormComparison(formId: string, filters: ResultsFilters, withIds: readonly string[], by: string | null, enabled: boolean) {
  return useQuery({
    queryKey: compareKey(formId, filters, withIds, by), enabled,
    queryFn: () => feedbackFormsV2Api.compareForms(formId, filters, withIds, by),
  })
}

/** The view's newest responses from `cursor`, up to the summary's limit (three pages of 100). */
async function newestResponses(formId: string, filters: ResultsFilters, read: readonly FormResponse[] = [],
  cursor?: string): Promise<readonly FormResponse[]> {
  const page = await feedbackFormsV2Api.getResponses(formId, filters, { limit: PAGE, ...(cursor === undefined ? {} : { cursor }) })
  const rows = [...read, ...page.responses]
  return page.next_cursor === null || rows.length >= SUMMARY_LIMITS.answers ? rows : newestResponses(formId, filters, rows, page.next_cursor)
}

export interface SummaryView {
  readonly responses: number
  readonly lastResponseAt: string | null
}

/**
 * "Summarize with AI": resolves to the stored report's id; the report is read again. It reads real responses only,
 * whatever the view includes: a test response is no feedback item, so a summary that read one could never be shown
 * (the report withholds a summary that read a response its reader cannot see).
 */
export function useSummarizeReport(formId: string, form: FormV2, filters: ResultsFilters) {
  const client = useQueryClient()
  const real: ResultsFilters = { ...filters, includeTest: false }
  return useMutation({
    mutationFn: async (view: SummaryView) => {
      const answers = summaryAnswers(form, await newestResponses(formId, real))
      return feedbackFormsV2Api.summarizeReport(formId, { answers, filters: summaryFilters(real), responses: view.responses,
        lastResponseAt: view.lastResponseAt })
    },
    onSuccess: () => client.invalidateQueries({ queryKey: [...feedbackFormsKey(), formId, 'report'] }),
  })
}
