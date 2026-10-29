/**
 * @fileoverview Reprocess one imported S3 file (issue #144, docs/s3-import.md).
 *
 * `POST /s3-import/reprocess {key}` re-runs the file through the s3_import ingestor
 * and answers 202 with the run; `GET /s3-import/reprocess/{run_id}` polls it. The run
 * is the platform's ordinary source-run record (`SOURCE_RUN#s3_import`). Duplicates
 * are skipped by the pipeline, so only rows missing from the data lake are imported
 * again; re-enriching stored rows is category reprocess, not this.
 *
 * Both answers are parsed at this boundary: an answer without a `run` throws (the
 * query shows its error), and a run whose status is malformed reads as `unknown`,
 * which the UI treats as settled rather than polling forever.
 *
 * @module api/s3ImportReprocessApi
 */
import { z } from 'zod'
import { post } from './requestKit'
import { fetchApi } from './client'

/** Query-key root of a polled run (api/queryPolicies.ts, api/feedbackDataWatch.ts). */
export const S3_IMPORT_REPROCESS_ROOT = 's3-import-reprocess'

const S3ImportRunSchema = z.object({
  run_id: z.string().min(1),
  key: z.string().catch(''),
  status: z.string().catch('unknown'),
  items_found: z.number().catch(0),
  errors: z.array(z.string()).catch([]),
})
export type S3ImportRun = z.output<typeof S3ImportRunSchema>

const RunEnvelopeSchema = z.object({ run: S3ImportRunSchema })

/** Only `running` can still change; every other status (completed, error, unknown) is settled. */
export function isRunSettled(run: S3ImportRun): boolean {
  return run.status !== 'running'
}

function parseRun(raw: unknown): S3ImportRun {
  const parsed = RunEnvelopeSchema.safeParse(raw)
  if (!parsed.success) throw new Error('Unexpected reprocess run response')
  return parsed.data.run
}

export async function reprocessS3ImportFile(key: string): Promise<S3ImportRun> {
  return parseRun(await fetchApi<unknown>('/s3-import/reprocess', post({ key })))
}

export async function getS3ImportReprocessRun(runId: string): Promise<S3ImportRun> {
  return parseRun(await fetchApi<unknown>(`/s3-import/reprocess/${encodeURIComponent(runId)}`))
}
