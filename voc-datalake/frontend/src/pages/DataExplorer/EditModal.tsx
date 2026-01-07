/**
 * @fileoverview Edit Modal component for Data Explorer.
 * @module pages/DataExplorer/EditModal
 */

import { useState } from 'react'
import { FileJson, Database, X, Loader2, Save, Link2, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'

export interface EditModalState {
  isOpen: boolean
  mode: 'create' | 'edit' | 'view'
  type: 's3' | 'dynamodb'
  data: unknown
  key?: string
  feedbackId?: string
  s3RawUri?: string
  contentType?: string
  isPresignedUrl?: boolean
}

type EditMode = EditModalState['mode']
type EditType = EditModalState['type']

interface EditModalProps extends EditModalState {
  readonly onClose: () => void
  readonly onSave: (content: unknown, syncOption?: boolean) => void
  readonly saving: boolean
  readonly error?: string
}

type FileType = 'image' | 'pdf' | 'text'

function getFileType(isPresignedUrl: boolean | undefined, contentType: string | undefined, key: string | undefined): FileType {
  if (!isPresignedUrl) return 'text'

  const ct = contentType?.toLowerCase() ?? ''
  const ext = key?.split('.').pop()?.toLowerCase() ?? ''

  if (ct.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
    return 'image'
  }
  if (ct === 'application/pdf' || ext === 'pdf') {
    return 'pdf'
  }
  return 'text'
}

function getTitle(mode: EditMode, type: EditType): string {
  if (mode === 'create') return 'Create New File'
  const target = type === 's3' ? 'S3 File' : 'Feedback'
  return mode === 'edit' ? `Edit ${target}` : `View ${target}`
}

function validateJson(text: string): string | null {
  try {
    JSON.parse(text)
    return null
  } catch (e) {
    if (e instanceof Error) return e.message
    return 'Invalid JSON'
  }
}

interface MediaContentProps {
  readonly fileType: FileType
  readonly mediaUrl: string
  readonly fileKey?: string
}

function MediaContent({ fileType, mediaUrl, fileKey }: MediaContentProps) {
  if (fileType === 'image') {
    return (
      <div className="flex items-center justify-center p-4 bg-gray-100 rounded-lg min-h-[300px] sm:min-h-[400px]">
        <img
          src={mediaUrl}
          alt={fileKey ?? 'Preview'}
          className="max-w-full max-h-[50vh] sm:max-h-[60vh] object-contain rounded shadow-lg"
        />
      </div>
    )
  }

  if (fileType === 'pdf') {
    return (
      <div className="w-full h-[50vh] sm:h-[60vh] bg-gray-100 rounded-lg overflow-hidden">
        <iframe src={mediaUrl} className="w-full h-full border-0" title={fileKey ?? 'PDF Preview'} />
      </div>
    )
  }

  return null
}

export default function EditModal({
  mode, type, data, key: fileKey, feedbackId, s3RawUri, contentType, isPresignedUrl, onClose, onSave, saving, error
}: EditModalProps) {
  const initialContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  const [content, setContent] = useState(initialContent)
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [jsonError, setJsonError] = useState<string | null>(null)

  const fileType = getFileType(isPresignedUrl, contentType, fileKey)
  const isMediaFile = fileType === 'image' || fileType === 'pdf'
  const isReadOnly = mode === 'view' || isMediaFile
  const title = getTitle(mode, type)

  const handleContentChange = (text: string) => {
    setContent(text)
    setJsonError(validateJson(text))
  }

  const handleSave = () => {
    const validationError = validateJson(content)
    if (validationError) {
      setJsonError(validationError)
      return
    }
    try {
      onSave(JSON.parse(content), syncEnabled)
    } catch {
      onSave(content, syncEnabled)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[95vh] sm:max-h-[90vh] flex flex-col">
        <ModalHeader type={type} title={title} fileType={fileType} onClose={onClose} />
        <ModalMetadata type={type} fileKey={fileKey} feedbackId={feedbackId} s3RawUri={s3RawUri} contentType={contentType} />

        <div className="flex-1 overflow-auto p-3 sm:p-4">
          {isMediaFile ? (
            <MediaContent fileType={fileType} mediaUrl={typeof data === 'string' ? data : ''} fileKey={fileKey} />
          ) : (
            <>
              <textarea
                value={content}
                onChange={(e) => handleContentChange(e.target.value)}
                readOnly={isReadOnly}
                className={clsx(
                  'w-full h-full min-h-[300px] sm:min-h-[400px] font-mono text-xs p-3 sm:p-4 rounded-lg border resize-none',
                  isReadOnly ? 'bg-gray-50 text-gray-700' : 'bg-white',
                  jsonError ? 'border-red-300' : 'border-gray-200'
                )}
                spellCheck={false}
              />
              {jsonError && (
                <p className="text-xs text-red-600 mt-2 flex items-center gap-1">
                  <AlertTriangle size={14} /> Invalid JSON: {jsonError}
                </p>
              )}
            </>
          )}
        </div>

        <ModalFooter
          type={type}
          mode={mode}
          isReadOnly={isReadOnly}
          isMediaFile={isMediaFile}
          syncEnabled={syncEnabled}
          onSyncChange={setSyncEnabled}
          onClose={onClose}
          onSave={handleSave}
          saving={saving}
          jsonError={jsonError}
          error={error}
        />
      </div>
    </div>
  )
}

interface ModalHeaderProps {
  readonly type: 's3' | 'dynamodb'
  readonly title: string
  readonly fileType: FileType
  readonly onClose: () => void
}

function ModalHeader({ type, title, fileType, onClose }: ModalHeaderProps) {
  return (
    <div className="flex items-center justify-between px-3 sm:px-4 py-3 border-b">
      <div className="flex items-center gap-2 min-w-0">
        {type === 's3' ? (
          <FileJson size={18} className="text-blue-500 flex-shrink-0" />
        ) : (
          <Database size={18} className="text-green-500 flex-shrink-0" />
        )}
        <span className="font-medium text-sm sm:text-base truncate">{title}</span>
        {fileType !== 'text' && (
          <span className="text-xs px-2 py-0.5 bg-gray-100 rounded text-gray-600 uppercase flex-shrink-0">{fileType}</span>
        )}
      </div>
      <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded flex-shrink-0"><X size={20} /></button>
    </div>
  )
}

interface ModalMetadataProps {
  readonly type: 's3' | 'dynamodb'
  readonly fileKey?: string
  readonly feedbackId?: string
  readonly s3RawUri?: string
  readonly contentType?: string
}

function ModalMetadata({ type, fileKey, feedbackId, s3RawUri, contentType }: ModalMetadataProps) {
  return (
    <div className="px-3 sm:px-4 py-2 bg-gray-50 border-b text-xs text-gray-600 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 overflow-x-auto">
      {type === 's3' && fileKey && (
        <span className="truncate">Key: <code className="bg-gray-200 px-1 rounded">{fileKey}</code></span>
      )}
      {type === 'dynamodb' && feedbackId && (
        <span className="truncate">ID: <code className="bg-gray-200 px-1 rounded">{feedbackId}</code></span>
      )}
      {s3RawUri && (
        <span className="flex items-center gap-1 truncate">
          <Link2 size={12} className="flex-shrink-0" /> S3: <code className="bg-gray-200 px-1 rounded text-xs truncate">{s3RawUri}</code>
        </span>
      )}
      {contentType && (
        <span className="truncate">Type: <code className="bg-gray-200 px-1 rounded">{contentType}</code></span>
      )}
    </div>
  )
}

interface ModalFooterProps {
  readonly type: 's3' | 'dynamodb'
  readonly mode: 'create' | 'edit' | 'view'
  readonly isReadOnly: boolean
  readonly isMediaFile: boolean
  readonly syncEnabled: boolean
  readonly onSyncChange: (enabled: boolean) => void
  readonly onClose: () => void
  readonly onSave: () => void
  readonly saving: boolean
  readonly jsonError: string | null
  readonly error?: string
}

function ModalFooter({
  type, mode, isReadOnly, isMediaFile, syncEnabled, onSyncChange, onClose, onSave, saving, jsonError, error
}: ModalFooterProps) {
  const syncLabel = type === 's3' ? 'Also update DynamoDB' : 'Also update S3'
  const saveLabel = mode === 'create' ? 'Create' : 'Save'

  return (
    <div className="px-3 sm:px-4 py-3 border-t bg-gray-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="flex items-center gap-4">
        {!isReadOnly && !isMediaFile && (
          <label className="flex items-center gap-2 text-xs sm:text-sm">
            <input
              type="checkbox"
              checked={syncEnabled}
              onChange={(e) => onSyncChange(e.target.checked)}
              className="rounded border-gray-300 text-blue-600"
            />
            <span className="text-gray-700">{syncLabel}</span>
          </label>
        )}
      </div>
      <div className="flex items-center gap-2 justify-end">
        {error && <span className="text-xs text-red-600">{error}</span>}
        <button onClick={onClose} className="btn btn-secondary text-sm">
          {isMediaFile ? 'Close' : 'Cancel'}
        </button>
        {!isReadOnly && !isMediaFile && (
          <button
            onClick={onSave}
            disabled={saving || !!jsonError}
            className="btn btn-primary flex items-center gap-2 text-sm"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {saveLabel}
          </button>
        )}
      </div>
    </div>
  )
}
