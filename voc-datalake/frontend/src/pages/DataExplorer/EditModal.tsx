/**
 * @fileoverview Edit Modal component for Data Explorer.
 * @module pages/DataExplorer/EditModal
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { FileJson, Database, Loader2, Save, Link2, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'
import DialogClose from '../../components/DialogClose/DialogClose'
import ModalShell from '../../components/ModalShell/ModalShell'

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

/** `key` is renamed `s3Key` here: React reserves `key`, so it cannot be a prop. */
interface EditModalProps extends Omit<EditModalState, 'key'> {
  readonly s3Key?: string
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

function getTitle(mode: EditMode, type: EditType, t: TFunction<'dataExplorer'>): string {
  if (mode === 'create') return t('editModal.createNewFile')
  if (mode === 'edit') return type === 's3' ? t('editModal.editS3File') : t('editModal.editFeedback')
  return type === 's3' ? t('editModal.viewS3File') : t('editModal.viewFeedback')
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
      <div className="flex items-center justify-center p-4 bg-bg-hover rounded-lg min-h-[300px] sm:min-h-[400px]">
        <img
          src={mediaUrl}
          alt={fileKey ?? 'Preview'}
          className="max-w-full max-h-[50vh] sm:max-h-[60vh] object-contain rounded-sm shadow-lg"
        />
      </div>
    )
  }

  if (fileType === 'pdf') {
    return (
      <div className="w-full h-[50vh] sm:h-[60vh] bg-bg-hover rounded-lg overflow-hidden">
        <iframe src={mediaUrl} className="w-full h-full border-0" title={fileKey ?? 'PDF Preview'} />
      </div>
    )
  }

  return null
}

export default function EditModal({
  mode, type, data, s3Key: fileKey, feedbackId, s3RawUri, contentType, isPresignedUrl, onClose, onSave, saving, error
}: EditModalProps) {
  const { t } = useTranslation('dataExplorer')
  const titleId = useId()
  const initialContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  const [content, setContent] = useState(initialContent)
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [jsonError, setJsonError] = useState<string | null>(null)

  const fileType = getFileType(isPresignedUrl, contentType, fileKey)
  const isMediaFile = fileType === 'image' || fileType === 'pdf'
  const isReadOnly = mode === 'view' || isMediaFile
  const title = getTitle(mode, type, t)
  // Escape / backdrop close only while nothing would be lost.
  const dismissable = !saving && content === initialContent

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
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} dismissable={dismissable} panelClassName="max-w-4xl max-h-[95vh] sm:max-h-[90vh]">
        <ModalHeader titleId={titleId} type={type} title={title} fileType={fileType} onClose={onClose} />
        <ModalMetadata type={type} fileKey={fileKey} feedbackId={feedbackId} s3RawUri={s3RawUri} contentType={contentType} />

        <div className="dialog-body">
          {isMediaFile ? (
            <MediaContent fileType={fileType} mediaUrl={typeof data === 'string' ? data : ''} fileKey={fileKey} />
          ) : (
            <>
              <textarea
                aria-label={t('editModal.content')}
                value={content}
                onChange={(e) => handleContentChange(e.target.value)}
                readOnly={isReadOnly}
                className={clsx(
                  'input w-full h-full min-h-[300px] sm:min-h-[400px] font-mono text-xs p-3 sm:p-4 resize-none',
                  isReadOnly && 'bg-bg-accent text-text',
                  jsonError && 'border-danger'
                )}
                spellCheck={false}
              />
              {jsonError && (
                <p className="text-xs text-danger mt-2 flex items-center gap-1">
                  <AlertTriangle size={14} className="flex-shrink-0" /> {t('editModal.invalidJson', { error: jsonError })}
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
    </ModalShell>
  )
}

interface ModalHeaderProps {
  readonly titleId: string
  readonly type: 's3' | 'dynamodb'
  readonly title: string
  readonly fileType: FileType
  readonly onClose: () => void
}

function ModalHeader({ titleId, type, title, fileType, onClose }: ModalHeaderProps) {
  return (
    <div className="dialog-header justify-between">
      <div className="flex items-center gap-3 min-w-0">
        <span className="w-9 h-9 rounded-lg bg-bg-hover text-muted flex items-center justify-center flex-shrink-0" aria-hidden="true">
          {type === 's3' ? <FileJson size={18} /> : <Database size={18} />}
        </span>
        <h2 id={titleId} className="dialog-title truncate">{title}</h2>
        {fileType !== 'text' && (
          <span className="badge badge-muted uppercase flex-shrink-0">{fileType}</span>
        )}
      </div>
      <DialogClose onClick={onClose} className="flex-shrink-0" />
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

const metaCode = 'font-mono bg-bg-hover text-text-strong px-1.5 py-0.5 rounded-sm truncate'

const present = (v: string | undefined): v is string => v != null && v !== ''

function MetaItem({ label, value, icon }: Readonly<{ label: string; value: string; icon?: React.ReactNode }>) {
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      {icon}{label} <code className={metaCode} title={value}>{value}</code>
    </span>
  )
}

function ModalMetadata({ type, fileKey, feedbackId, s3RawUri, contentType }: ModalMetadataProps) {
  const { t } = useTranslation('dataExplorer')
  const items = [
    type === 's3' && present(fileKey) ? { label: t('editModal.key'), value: fileKey } : null,
    type === 'dynamodb' && present(feedbackId) ? { label: t('editModal.id'), value: feedbackId } : null,
    present(s3RawUri) ? { label: 'S3', value: s3RawUri, icon: <Link2 size={12} className="flex-shrink-0" aria-hidden="true" /> } : null,
    present(contentType) ? { label: t('editModal.type'), value: contentType } : null,
  ].filter((item) => item !== null)
  // Render nothing rather than an empty strip (create mode used to show a blank bar).
  if (items.length === 0) return null
  return (
    <div className="px-5 py-2 bg-bg-accent border-b border-border text-xs text-muted flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4 min-w-0">
      {items.map((item) => <MetaItem key={item.label} {...item} />)}
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
  const { t } = useTranslation('dataExplorer')
  const saveLabel = mode === 'create' ? t('editModal.create') : t('editModal.save')

  return (
    <div className="dialog-footer flex-col items-stretch sm:flex-row sm:items-center sm:justify-between gap-3">
      <div className="flex items-center gap-4">
        {/* Raw → processed sync only: raw data is immutable, so a processed-record
            edit never writes back to S3. */}
        {type === 's3' && !isReadOnly && !isMediaFile && (
          <label className="flex items-center gap-2 text-sm min-h-9">
            <input
              type="checkbox"
              checked={syncEnabled}
              onChange={(e) => onSyncChange(e.target.checked)}
              className="rounded-sm accent-accent"
            />
            <span className="text-text">{t('editModal.syncToDynamo')}</span>
          </label>
        )}
      </div>
      <div className="flex items-center gap-2 justify-end">
        {error && <span role="alert" className="text-xs text-danger">{error}</span>}
        <button onClick={onClose} className="btn btn-secondary">
          {isReadOnly ? t('editModal.close') : t('editModal.cancel')}
        </button>
        {!isReadOnly && !isMediaFile && (
          <button
            onClick={onSave}
            disabled={saving || !!jsonError}
            className="btn btn-primary"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {saveLabel}
          </button>
        )}
      </div>
    </div>
  )
}
