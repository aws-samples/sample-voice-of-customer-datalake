/**
 * @fileoverview Browser-direct upload of a file to the S3 import bucket via a
 * presigned PUT URL.
 *
 * This is the only import path that is NOT bounded by API Gateway's 10 MB
 * request-body limit or its 29 s integration timeout: the browser PUTs the file
 * straight to S3, and an S3 object-created event drives the async `s3_import`
 * ingestor (which streams and batches, so a 75 MB / 500k-row file is fine).
 *
 * Extracted into its own module so the two callers — the Data Explorer's
 * S3ImportExplorer and the auto-detect large-file branch of JsonUploadModal —
 * share one implementation rather than each inlining the get-URL-then-PUT dance.
 *
 * @module api/s3Upload
 */
import { api } from './client'

/** File extensions the S3 import ingestor can parse. */
export const SUPPORTED_IMPORT_FILE_REGEX = /\.(csv|json|jsonl)$/i

/**
 * Threshold above which a JSON import is routed to the async S3 path instead of
 * the synchronous `/scrapers/manual/json-upload` endpoint. Set at the API
 * Gateway request-body ceiling (10 MB): a body at or above it cannot complete
 * synchronously, so anything this large must go through S3. Deliberately higher
 * than the in-browser preview comfortably handles — the large-file branch never
 * reads the file into memory, so the preview limit does not apply to it.
 */
export const SYNC_JSON_UPLOAD_MAX_BYTES = 10 * 1024 * 1024

/** Outcome of {@link uploadFileToS3}. */
export interface S3UploadResult {
  readonly ok: boolean
  /** Present when `ok` is false — a message safe to show the user. */
  readonly error?: string
}

/**
 * Upload one file to the S3 import bucket under `source`.
 *
 * Two network steps: fetch a presigned PUT URL from the API, then PUT the file
 * bytes straight to S3. Returns a result object rather than throwing so callers
 * can render an inline error without a try/catch; genuinely unexpected failures
 * (network down, S3 rejects the PUT) are caught here and reported as `ok:false`.
 */
/**
 * @param sourceField optional name of the column whose per-row value becomes
 *   each row's source_platform (Phase 5). When given, it is signed into the
 *   presigned URL as object metadata, so the PUT MUST echo it as the
 *   `x-amz-meta-source-field` header — S3 rejects a PUT whose headers don't
 *   match what was signed. The ingestor then applies it per row.
 */
export async function uploadFileToS3(
  file: File, source: string, sourceField?: string,
): Promise<S3UploadResult> {
  if (!SUPPORTED_IMPORT_FILE_REGEX.test(file.name)) {
    return { ok: false, error: `Unsupported file type: ${file.name}. Only CSV, JSON, and JSONL are supported.` }
  }

  const contentType = file.type || 'application/octet-stream'
  try {
    const urlResponse = await api.getS3UploadUrl(file.name, source, contentType, sourceField)
    if (!urlResponse.success || !urlResponse.upload_url) {
      return { ok: false, error: urlResponse.error || 'Failed to get upload URL' }
    }
    const headers: Record<string, string> = { 'Content-Type': contentType }
    // Only send the metadata header when the URL was actually signed with it;
    // sending it otherwise would make S3 reject the PUT for a signature mismatch.
    if (urlResponse.source_field) {
      headers['x-amz-meta-source-field'] = urlResponse.source_field
    }
    const put = await fetch(urlResponse.upload_url, {
      method: 'PUT',
      body: file,
      headers,
    })
    if (!put.ok) {
      return { ok: false, error: `Upload failed (HTTP ${put.status})` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Upload failed' }
  }
}
