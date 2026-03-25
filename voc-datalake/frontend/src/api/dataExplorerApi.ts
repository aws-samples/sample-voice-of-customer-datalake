// Data Explorer & S3 Import API - extracted from client.ts for code splitting
import { fetchApi, buildSearchParams } from './client'
import type { FeedbackItem, S3ImportSource, S3ImportFile } from './types'

export const dataExplorerApi = {
  // S3 Import
  getS3ImportSources: () =>
    fetchApi<{ success: boolean; sources: S3ImportSource[]; bucket: string | null }>('/s3-import/sources'),

  createS3ImportSource: (name: string) =>
    fetchApi<{ success: boolean; source: S3ImportSource; message: string }>('/s3-import/sources', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  getS3ImportFiles: (params?: { source?: string; include_processed?: boolean }) => {
    const searchParams = buildSearchParams(params ?? {})
    return fetchApi<{ success: boolean; files: S3ImportFile[]; count: number }>(`/s3-import/files?${searchParams}`)
  },

  getS3UploadUrl: (filename: string, source: string, contentType?: string) =>
    fetchApi<{ success: boolean; upload_url: string; key: string; expires_in: number }>('/s3-import/upload-url', {
      method: 'POST',
      body: JSON.stringify({ filename, source, content_type: contentType }),
    }),

  deleteS3ImportFile: (key: string) =>
    fetchApi<{ success: boolean }>(`/s3-import/file/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),

  // Data Explorer - S3 browser
  getDataExplorerBuckets: () =>
    fetchApi<{ buckets: Array<{ id: string; name: string; label: string; description: string }> }>('/data-explorer/buckets'),

  getDataExplorerS3: (prefix?: string, bucket?: string) => {
    const searchParams = buildSearchParams({ prefix, bucket })
    return fetchApi<{
      objects: Array<{ key: string; fullKey?: string; size: number; lastModified: string; isFolder: boolean }>
      bucket: string
      bucketId: string
      bucketLabel?: string
      prefix: string
    }>(`/data-explorer/s3?${searchParams}`)
  },

  getDataExplorerS3Preview: (key: string, bucket?: string) => {
    const searchParams = buildSearchParams({ key, bucket })
    return fetchApi<{ success: boolean; key: string; content: unknown; size: number }>(
      `/data-explorer/s3/preview?${searchParams}`,
    )
  },

  saveDataExplorerS3: (key: string, content: string, syncToDynamo?: boolean, bucket?: string) =>
    fetchApi<{ success: boolean; message: string; synced_to_dynamo?: boolean }>('/data-explorer/s3', {
      method: 'PUT',
      body: JSON.stringify({ key, content, sync_to_dynamo: syncToDynamo, bucket }),
    }),

  deleteDataExplorerS3: (key: string, bucket?: string) => {
    const searchParams = buildSearchParams({ key, bucket })
    return fetchApi<{ success: boolean; message: string }>(`/data-explorer/s3?${searchParams}`, {
      method: 'DELETE',
    })
  },

  // Data Explorer - DynamoDB feedback CRUD
  saveDataExplorerFeedback: (feedbackId: string, data: Partial<FeedbackItem>, syncToS3?: boolean) =>
    fetchApi<{ success: boolean; message: string; synced_to_s3?: boolean }>('/data-explorer/feedback', {
      method: 'PUT',
      body: JSON.stringify({ feedback_id: feedbackId, data, sync_to_s3: syncToS3 }),
    }),

  deleteDataExplorerFeedback: (feedbackId: string) => {
    const searchParams = buildSearchParams({ feedback_id: feedbackId })
    return fetchApi<{ success: boolean; message: string }>(`/data-explorer/feedback?${searchParams}`, {
      method: 'DELETE',
    })
  },
}
