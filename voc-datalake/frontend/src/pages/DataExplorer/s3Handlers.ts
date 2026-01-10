/**
 * @fileoverview S3 file handlers for Data Explorer.
 * @module pages/DataExplorer/s3Handlers
 */

import { api } from '../../api/client'
import type { EditModalState } from './EditModal'

export async function openS3Editor(
  fullKey: string,
  mode: 'view' | 'edit',
  selectedBucket: string,
  setEditModal: (state: EditModalState) => void
): Promise<void> {
  const preview = await api.getDataExplorerS3Preview(fullKey, selectedBucket)
  setEditModal({
    isOpen: true, mode, type: 's3', data: preview.content, key: fullKey,
    contentType: preview.contentType, isPresignedUrl: preview.isPresignedUrl,
  })
}

export function openS3Creator(
  s3Path: string[],
  setEditModal: (state: EditModalState) => void
): void {
  const prefix = s3Path.length > 0 ? s3Path.join('/') + '/' : 'raw/'
  setEditModal({
    isOpen: true, mode: 'create', type: 's3',
    data: { source_platform: 'manual', text: '', created_at: new Date().toISOString() },
    key: `${prefix}${Date.now()}.json`,
  })
}

export async function downloadS3File(
  fullKey: string,
  filename: string,
  selectedBucket: string
): Promise<void> {
  const preview = await api.getDataExplorerS3Preview(fullKey, selectedBucket)
  const blob = preview.isPresignedUrl && typeof preview.content === 'string'
    ? await fetch(preview.content).then(r => r.blob())
    : new Blob(
        [typeof preview.content === 'string' ? preview.content : JSON.stringify(preview.content, null, 2)],
        { type: preview.contentType ?? 'application/json' }
      )

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
