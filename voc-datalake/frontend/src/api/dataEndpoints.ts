/**
 * @fileoverview Data endpoint groups of the API client: the S3 import file
 * explorer and the admin Data Explorer. Spread into `api` by `./client`; see
 * `./requestKit` for why these are factories.
 */
import { del, post, put, type FetchApi } from './requestKit'
import type { FeedbackItem, S3ImportFile, S3ImportSource } from './types'
import type { RequestScope } from './baseUrl'

const DEFAULT_UPLOAD_CONTENT_TYPE = 'application/octet-stream'

/**
 * `/s3-import/*` — the drop bucket the S3 import plugin ingests from. The API acts in the workspace `X-Workspace-Id`
 * names (its own `ws/{ws}/` folder, for its admins) and, without the header, in the deployment's (7.86.00). Every
 * call takes the scope of the card it serves (workspace/configScope.ts): `'workspace'`, the default, names the
 * current workspace (none outside one); `'deployment'` never names one, so a platform admin's deployment view reaches
 * the deployment's files from inside a workspace too.
 */
export function s3ImportEndpoints(fetchApi: FetchApi) {
  return {
    getS3ImportSources: (scope: RequestScope = 'workspace') =>
      fetchApi<{ sources: S3ImportSource[]; bucket: string | null }>('/s3-import/sources', { method: 'GET' }, scope),

    createS3ImportSource: (name: string, scope: RequestScope = 'workspace') =>
      fetchApi<{ success: boolean; source?: S3ImportSource; message?: string }>('/s3-import/sources', post({ name }), scope),

    getS3ImportFiles: (params?: { source?: string; include_processed?: boolean }, scope: RequestScope = 'workspace') => {
      const searchParams = new URLSearchParams()
      if (params?.source) searchParams.set('source', params.source)
      if (params?.include_processed) searchParams.set('include_processed', 'true')
      return fetchApi<{ files: S3ImportFile[]; bucket: string | null }>(`/s3-import/files?${searchParams}`, { method: 'GET' }, scope)
    },

    /** Create-only: 409 when the key already holds a file. The PUT must send `upload_headers` exactly
     *  (they are signed into the URL; `If-None-Match: *` makes S3 refuse an overwrite). */
    getS3UploadUrl: (filename: string, source: string, contentType?: string, scope: RequestScope = 'workspace') =>
      fetchApi<{ success: boolean; upload_url?: string; key?: string; error?: string; upload_headers?: Record<string, string> }>('/s3-import/upload-url', post({
          filename,
          source,
          // An empty string is "not given" too, so this is not `??`.
          content_type: contentType === undefined || contentType === '' ? DEFAULT_UPLOAD_CONTENT_TYPE : contentType,
        }), scope),

    deleteS3ImportFile: (key: string, scope: RequestScope = 'workspace') =>
      fetchApi<{ success: boolean; message?: string }>(`/s3-import/file/${encodeURIComponent(key)}`, del(), scope),
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
      fetchApi<{ success: boolean; message?: string; synced?: boolean }>('/data-explorer/s3', put({ key, content, sync_to_dynamo: syncToDynamo, bucket })),

    // DynamoDB processed-record edits: no S3 sync and no delete route.
    // `updated_at`: the stamp the record was opened with ('' = never stamped), checked by the API (409).
    saveDataExplorerFeedback: (feedbackId: string, data: Partial<FeedbackItem> & { updated_at?: string }) =>
      fetchApi<{ success: boolean; message?: string }>('/data-explorer/feedback', put({ feedback_id: feedbackId, data })),
  }
}
