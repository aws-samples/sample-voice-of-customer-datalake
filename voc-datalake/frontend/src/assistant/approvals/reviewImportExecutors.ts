/**
 * @fileoverview REST executor of `import_reviews`: the approved rows go to the
 * existing admin-only `POST /scrapers/manual/json-upload` route through
 * `scrapersApi.uploadJsonFeedback` (the user's own Cognito token), each with a
 * de-duplication id derived from the row itself (`reviewImportId`), so the same
 * reviews imported twice are stored once. A row without a date is dated at the
 * approval time, as the card says.
 *
 * @module assistant/approvals/reviewImportExecutors
 */
import { z } from 'zod'
import { scrapersApi } from '../../api/scrapersApi'
import { invalidateKeys, keysFor } from './invalidation'
import { DEFAULT_IMPORT_SOURCE_ID, jsonUploadItems } from './reviewImportSchemas'
import type { WriteToolExecutionContext } from '../types'
import type { ImportReviewsArgs } from './reviewImportSchemas'

/** The route's answer, read leniently (wire-shape rule): a missing count reads as unknown, not as a number. */
const uploadResultSchema = z.object({
  imported_count: z.number().int().nonnegative().catch(0),
  errors: z.array(z.unknown()).catch([]),
})

export async function importReviews(args: ImportReviewsArgs, ctx: WriteToolExecutionContext) {
  const items = await jsonUploadItems(args, new Date().toISOString())
  const res = uploadResultSchema.parse(await scrapersApi.uploadJsonFeedback(items, args.source_id))
  void invalidateKeys(ctx.queryClient, keysFor.feedbackCategory())
  const sourceId = args.source_id ?? DEFAULT_IMPORT_SOURCE_ID
  const failed = res.errors.length
  const failures = failed === 0 ? '' : ` ${String(failed)} could not be queued.`
  return {
    summary: `Queued ${String(res.imported_count)} of ${String(items.length)} reviews from "${args.source_name}" `
      + `(source ${sourceId}) for import; they appear after enrichment, usually within minutes.${failures}`,
    data: { imported_count: res.imported_count, total_items: items.length, source_id: sourceId },
  }
}
