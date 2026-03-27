/**
 * @fileoverview Edit Modal component for Data Explorer.
 * @module pages/DataExplorer/EditModal
 */

import clsx from 'clsx'
import {
  FileJson, Database, X, Loader2, Save, Link2, AlertTriangle,
} from 'lucide-react'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface EditModalState {
  readonly isOpen: boolean
  readonly mode: 'create' | 'edit' | 'view'
  readonly type: 's3' | 'dynamodb'
  readonly data: unknown
  readonly key?: string
  readonly feedbackId?: string
  readonly s3RawUri?: string
  readonly contentType?: string
  readonly isPresignedUrl?: boolean
}

type EditMode = EditModalState['mode']
type EditType = EditModalState['type']

interface EditModalProps extends Readonly<EditModalState> {
  readonly onClose: () => void
  readonly onSave: (content: unknown, syncOption?: boolean) => void
  readonly saving: boolean
  readonly error?: string
}

type FileType = 'image' | 'pdf' | 'text'

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'])

function getExtension(key: string | undefined): string {
  return key?.split('.').pop()?.toLowerCase() ?? ''
}

function getFileType(isPresignedUrl: boolean | undefined, contentType: string | undefined, key: string | undefined): FileType {
  if (isPresignedUrl !== true) return 'text'
  const ct = contentType?.toLowerCase() ?? ''
  const ext = getExtension(key)
  if (ct.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (ct === 'application/pdf' || ext === 'pdf') return 'pdf'
  return 'text'
}

function getTitle(mode: EditMode, type: EditType, t: (key: string) => string): string {
  if (mode === 'create') return t('editModal.createNewFile')
  const titleMap: Record<string, string> = {
    's3-edit': 'editModal.editS3File',
    's3-view': 'editModal.viewS3File',
    'dynamodb-edit': 'editModal.editFeedback',
    'dynamodb-view': 'editModal.viewFeedback',
  }
  const key = `${type}-${mode}`
  return t(titleMap[key] ?? 'editModal.viewS3File')
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

function MediaContent({
  fileType, mediaUrl, fileKey,
}: MediaContentProps) {
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

function attemptSave(content: string, syncEnabled: boolean, onSave: (content: unknown, sync?: boolean) => void, setJsonError: (e: string | null) => void) {
  const validationError = validateJson(content)
  if (validationError != null && validationError !== '') {
    setJsonError(validationError)
    return
  }
  try {
    onSave(JSON.parse(content), syncEnabled)
  } catch {
    onSave(content, syncEnabled)
  }
}

function deriveEditState(fileType: FileType, mode: EditMode) {
  const isMediaFile = fileType === 'image' || fileType === 'pdf'
  return {
    isMediaFile,
    isReadOnly: mode === 'view' || isMediaFile,
  }
}

export default function EditModal({
  mode, type, data, key: fileKey, feedbackId, s3RawUri, contentType, isPresignedUrl, onClose, onSave, saving, error,
}: Readonly<EditModalProps>) {
  const { t } = useTranslation('dataExplorer')
  const initialContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  const [content, setContent] = useState(initialContent)
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [jsonError, setJsonError] = useState<string | null>(null)

  const fileType = getFileType(isPresignedUrl, contentType, fileKey)
  const {
    isMediaFile, isReadOnly,
  } = deriveEditState(fileType, mode)
  const title = getTitle(mode, type, t)

  const handleContentChange = (text: string) => {
    setContent(text)
    setJsonError(validateJson(text))
  }

  const handleSave = () => {
    attemptSave(content, syncEnabled, onSave, setJsonError)
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
                  jsonError != null && jsonError !== '' ? 'border-red-300' : 'border-gray-200',
                )}
                spellCheck={false}
              />
              {jsonError != null && jsonError !== '' ? <p className="text-xs text-red-600 mt-2 flex items-center gap-1">
                <AlertTriangle size={14} /> {t('editModal.invalidJson', { error: jsonError })}
              </p> : null}
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

function ModalHeader({
  type, title, fileType, onClose,
}: ModalHeaderProps) {
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

function isNonEmpty(value: string | undefined): value is string {
  return value != null && value !== ''
}

function buildMetadataItems(props: ModalMetadataProps, t: (key: string) => string) {
  const items: Array<{
    key: string;
    content: React.ReactNode
  }> = []
  const idLabel = props.type === 's3' ? t('editModal.key') : t('editModal.id')
  const idValue = props.type === 's3' ? props.fileKey : props.feedbackId
  if (isNonEmpty(idValue)) {
    items.push({
      key: 'id',
      content: <span className="truncate">{idLabel}: <code className="bg-gray-200 px-1 rounded">{idValue}</code></span>,
    })
  }
  if (isNonEmpty(props.s3RawUri)) {
    items.push({
      key: 's3Uri',
      content: <span className="flex items-center gap-1 truncate"><Link2 size={12} className="flex-shrink-0" /> S3: <code className="bg-gray-200 px-1 rounded text-xs truncate">{props.s3RawUri}</code></span>,
    })
  }
  if (isNonEmpty(props.contentType)) {
    items.push({
      key: 'contentType',
      content: <span className="truncate">{t('editModal.type')}: <code className="bg-gray-200 px-1 rounded">{props.contentType}</code></span>,
    })
  }
  return items
}

function ModalMetadata(props: ModalMetadataProps) {
  const { t } = useTranslation('dataExplorer')
  const items = buildMetadataItems(props, t)
  return (
    <div className="px-3 sm:px-4 py-2 bg-gray-50 border-b text-xs text-gray-600 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 overflow-x-auto">
      {items.map((item) => <React.Fragment key={item.key}>{item.content}</React.Fragment>)}
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

function SyncCheckbox({
  syncEnabled, onSyncChange, syncLabel,
}: Readonly<{
  syncEnabled: boolean;
  onSyncChange: (v: boolean) => void;
  syncLabel: string
}>) {
  return (
    <label className="flex items-center gap-2 text-xs sm:text-sm">
      <input
        type="checkbox"
        checked={syncEnabled}
        onChange={(e) => onSyncChange(e.target.checked)}
        className="rounded border-gray-300 text-blue-600"
      />
      <span className="text-gray-700">{syncLabel}</span>
    </label>
  )
}

function SaveButton({
  onSave, saving, jsonError, saveLabel,
}: Readonly<{
  onSave: () => void;
  saving: boolean;
  jsonError: string | null;
  saveLabel: string
}>) {
  return (
    <button
      onClick={onSave}
      disabled={saving || (jsonError != null && jsonError !== '')}
      className="btn btn-primary flex items-center gap-2 text-sm"
    >
      {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
      {saveLabel}
    </button>
  )
}

function ModalFooter({
  type, mode, isReadOnly, isMediaFile, syncEnabled, onSyncChange, onClose, onSave, saving, jsonError, error,
}: ModalFooterProps) {
  const { t } = useTranslation('dataExplorer')
  const syncLabel = type === 's3' ? t('editModal.syncToDynamo') : t('editModal.syncToS3')
  const saveLabel = mode === 'create' ? t('editModal.create') : t('editModal.save')
  const showEditControls = !isReadOnly && !isMediaFile
  const closeLabel = isMediaFile ? t('editModal.close') : t('editModal.cancel')

  return (
    <div className="px-3 sm:px-4 py-3 border-t bg-gray-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="flex items-center gap-4">
        {showEditControls ? <SyncCheckbox syncEnabled={syncEnabled} onSyncChange={onSyncChange} syncLabel={syncLabel} /> : null}
      </div>
      <div className="flex items-center gap-2 justify-end">
        {isNonEmpty(error) ? <span className="text-xs text-red-600">{error}</span> : null}
        <button onClick={onClose} className="btn btn-secondary text-sm">{closeLabel}</button>
        {showEditControls ? <SaveButton onSave={onSave} saving={saving} jsonError={jsonError} saveLabel={saveLabel} /> : null}
      </div>
    </div>
  )
}
