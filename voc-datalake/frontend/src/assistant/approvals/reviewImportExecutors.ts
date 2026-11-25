/**
 * @fileoverview REST executor of `import_reviews`: the approved rows go to the
 * existing admin-only `POST /scrapers/manual/json-upload` route through
 * `scrapersApi.uploadJsonFeedback` (the user's own Cognito token), each with a
 * de-duplication id derived from the row itself (`reviewImportId`), so the same
 * reviews imported twice are stored once. A row without a date is dated at the
 * approval time, as the card says. Rows the strict redaction left out are named by their
 * place in the approved list (`redaction_unavailable`, 7.71.04), so the model can say which.
 *
 * @module assistant/approvals/reviewImportExecutors
 */
import { z } from 'zod'
import { scrapersApi } from '../../api/scrapersApi'
import type { RedactionUnavailable } from '../../api/redactionUnavailable'
import { invalidateKeys, keysFor } from './invalidation'
import { DEFAULT_IMPORT_SOURCE_ID } from '@stream/assistant/tools/client/review-import-schemas'
import { jsonUploadItems } from './reviewImportSchemas'
import type { WriteToolExecutionContext } from '../types'
import type { ImportReviewsArgs } from './reviewImportSchemas'

/** The route's answer, read leniently (wire-shape rule): a missing count reads as unknown, not as a number. */
const uploadResultSchema = z.object({
  imported_count: z.number().int().nonnegative().catch(0),
  errors: z.array(z.unknown()).catch([]),
})

/** The summary's sentence on the rows the redaction left out, '' for none. */
function leftOutText(left: RedactionUnavailable | undefined): string {
  if (left === undefined) return ''
  const were = left.count === 1 ? 'was' : 'were'
  return ` ${String(left.count)} ${were} left out because the personal data could not be checked for redaction `
    + `(approved rows ${left.rows.join(', ')}); import just those again.`
}

export async function importReviews(args: ImportReviewsArgs, ctx: WriteToolExecutionContext) {
  const items = await jsonUploadItems(args, new Date().toISOString())
  const answer = await scrapersApi.uploadJsonFeedback(items, args.source_id, undefined, { sourceLabel: args.source_name })
  const res = uploadResultSchema.parse(answer)
  void invalidateKeys(ctx.queryClient, keysFor.feedbackCategory())
  const sourceId = args.source_id ?? DEFAULT_IMPORT_SOURCE_ID
  const failed = res.errors.length
  const failures = failed === 0 ? '' : ` ${String(failed)} could not be queued.`
  const left = answer.redaction_unavailable
  return {
    summary: `Queued ${String(res.imported_count)} of ${String(items.length)} reviews from "${args.source_name}" `
      + `(source ${sourceId}) for import; they appear after enrichment, usually within minutes.${failures}${leftOutText(left)}`,
    data: { imported_count: res.imported_count, total_items: items.length, source_id: sourceId, ...(left === undefined ? {} : { redaction_unavailable: left }) },
  }
}
