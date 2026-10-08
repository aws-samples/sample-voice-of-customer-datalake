/**
 * @fileoverview Data endpoint groups of the API client: the S3 import file
 * explorer and the admin Data Explorer. Spread into `api` by `./client`; see
 * `./requestKit` for why these are factories.
 */
import type { FetchApi } from './requestKit'
import type { FeedbackItem, S3ImportFile, S3ImportSource } from './types'

const DEFAULT_UPLOAD_CONTENT_TYPE = 'application/octet-stream'

/** `/s3-import/*` — the drop bucket the S3 import plugin ingests from. */
export function s3ImportEndpoints(fetchApi: FetchApi) {
  return {
    getS3ImportSources: () => fetchApi<{ sources: S3ImportSource[]; bucket: string | null }>('/s3-import/sources'),

    createS3ImportSource: (name: string) =>
      fetchApi<{ success: boolean; source?: S3ImportSource; message?: string }>('/s3-import/sources', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),

    getS3ImportFiles: (params?: { source?: string; include_processed?: boolean }) => {
      const searchParams = new URLSearchParams()
      if (params?.source) searchParams.set('source', params.source)
      if (params?.include_processed) searchParams.set('include_processed', 'true')
      return fetchApi<{ files: S3ImportFile[]; bucket: string | null }>(`/s3-import/files?${searchParams}`)
    },

    getS3UploadUrl: (filename: string, source: string, contentType?: string) =>
      fetchApi<{ success: boolean; upload_url?: string; key?: string; error?: string }>('/s3-import/upload-url', {
        method: 'POST',
        body: JSON.stringify({
          filename,
          source,
          // An empty string is "not given" too, so this is not `??`.
          content_type: contentType === undefined || contentType === '' ? DEFAULT_UPLOAD_CONTENT_TYPE : contentType,
        }),
      }),

    deleteS3ImportFile: (key: string) =>
      fetchApi<{ success: boolean; message?: string }>(`/s3-import/file/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      }),
  }
}

/**
 * `/data-explorer/*` — admin-only browser over the raw bucket and processed
 * records. Raw data is immutable and nothing is ever deleted, so there is no
 * delete call here.
 */
export function dataExplorerEndpoints(fetchApi: FetchApi) {
  return {
    getDataExplorerBuckets: () =>
      fetchApi<{ buckets: Array<{ id: string; name: string; label: string; description: string }> }>('/data-explorer/buckets'),

    getDataExplorerS3: (prefix?: string, bucket?: string) => {
      const params = new URLSearchParams()
      if (prefix) params.set('prefix', prefix)
      if (bucket) params.set('bucket', bucket)
      return fetchApi<{
        objects: Array<{ key: string; fullKey?: string; size: number; lastModified: string; isFolder: boolean }>
        bucket: string
        bucketId: string
        bucketLabel: string
        prefix: string
      }>(`/data-explorer/s3?${params}`)
    },

    getDataExplorerS3Preview: (key: string, bucket?: string) => {
      const params = new URLSearchParams()
      params.set('key', key)
      if (bucket) params.set('bucket', bucket)
      return fetchApi<{ content: unknown; size: number; contentType: string; key: string; isPresignedUrl?: boolean }>(`/data-explorer/s3/preview?${params}`)
    },

    saveDataExplorerS3: (key: string, content: string, syncToDynamo?: boolean, bucket?: string) =>
      fetchApi<{ success: boolean; message?: string; synced?: boolean }>('/data-explorer/s3', {
        method: 'PUT',
        body: JSON.stringify({ key, content, sync_to_dynamo: syncToDynamo, bucket }),
      }),

    // DynamoDB processed-record edits: no S3 sync and no delete route.
    saveDataExplorerFeedback: (feedbackId: string, data: Partial<FeedbackItem>) =>
      fetchApi<{ success: boolean; message?: string }>('/data-explorer/feedback', {
        method: 'PUT',
        body: JSON.stringify({ feedback_id: feedbackId, data }),
      }),
  }
}
