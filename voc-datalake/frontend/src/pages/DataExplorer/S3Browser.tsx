/**
 * @fileoverview S3 Browser component for Data Explorer.
 * @module pages/DataExplorer/S3Browser
 */

import { FolderOpen, FileJson, ChevronRight, Eye, Pencil, ArrowLeft, HardDrive, Image, FileText, Download, Loader2, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { safeFormatDate } from '../../utils/dateUtils'
import { formatFileSize } from '../../utils/file'

interface S3Object {
  key: string
  fullKey?: string
  size: number
  lastModified: string
  isFolder: boolean
}

/** Row-level callbacks the browser receives and hands down to every object row. */
interface S3ObjectActions {
  readonly onNavigateToFolder: (folder: string) => void
  readonly onView: (key: string) => void
  readonly onEdit: (key: string) => void
  readonly onDownload: (key: string, filename: string) => void
}

interface S3BrowserProps extends S3ObjectActions {
  readonly path: string[]
  readonly data: { objects: S3Object[]; bucket: string; prefix: string } | undefined
  readonly loading: boolean
  readonly onNavigateUp: () => void
  readonly onNavigateToBreadcrumb: (index: number) => void
}

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico']

function extensionOf(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? ''
}

function getFileIcon(filename: string) {
  const ext = extensionOf(filename)
  if (IMAGE_EXTENSIONS.includes(ext)) {
    return <Image size={18} className="text-aim flex-shrink-0" aria-hidden="true" />
  }
  if (ext === 'pdf') {
    return <FileText size={18} className="text-danger flex-shrink-0" aria-hidden="true" />
  }
  return <FileJson size={18} className="text-info flex-shrink-0" aria-hidden="true" />
}

function isEditableFile(filename: string): boolean {
  const ext = extensionOf(filename)
  return ![...IMAGE_EXTENSIONS, 'pdf'].includes(ext)
}

/**
 * Raw ingested data is immutable: the API refuses to overwrite an existing
 * object under `raw/` (409), so the browser never offers to edit one. New files
 * can still be created there (see `openS3Creator`).
 */
function isImmutableRawKey(fullKey: string): boolean {
  return fullKey.startsWith('raw/')
}

function Crumb({ label, isCurrent, onClick }: Readonly<{ label: string; isCurrent: boolean; onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isCurrent ? 'location' : undefined}
      className={clsx('rounded-sm px-1 py-0.5 whitespace-nowrap', isCurrent ? 'text-text-strong font-medium' : 'link')}
    >
      {label}
    </button>
  )
}

function Breadcrumbs({ bucket, path, onNavigateToBreadcrumb }: Readonly<{
  bucket: string
  path: string[]
  onNavigateToBreadcrumb: (index: number) => void
}>) {
  const { t } = useTranslation('dataExplorer')
  return (
    <nav aria-label={t('s3Browser.path')} className="bg-bg-accent px-4 py-2.5 border-b border-border flex items-center gap-1.5 text-sm min-w-0 overflow-x-auto">
      <HardDrive size={16} className="text-muted flex-shrink-0" aria-hidden="true" />
      <Crumb label={bucket} isCurrent={path.length === 0} onClick={() => onNavigateToBreadcrumb(-1)} />
      {path.map((segment, i) => (
        // Segments can repeat ("2026/01/01"), so the path up to here is the identity.
        <span key={path.slice(0, i + 1).join('/')} className="flex items-center gap-1.5 flex-shrink-0">
          <ChevronRight size={14} className="text-muted" aria-hidden="true" />
          <Crumb label={segment} isCurrent={i === path.length - 1} onClick={() => onNavigateToBreadcrumb(i)} />
        </span>
      ))}
    </nav>
  )
}

function EmptyFolder() {
  const { t } = useTranslation('dataExplorer')
  return (
    <div className="px-6 py-12 text-center">
      <FolderOpen size={20} className="mx-auto mb-3 text-muted" aria-hidden="true" />
      <p className="text-sm font-medium text-text-strong">{t('s3Browser.noFiles')}</p>
      <p className="text-sm text-muted mt-1">{t('s3Browser.noFilesHint')}</p>
    </div>
  )
}

export default function S3Browser({
  path, data, loading, onNavigateToFolder, onNavigateUp, onNavigateToBreadcrumb, onView, onEdit, onDownload
}: S3BrowserProps) {
  const { t } = useTranslation('dataExplorer')
  if (loading) {
    return <div className="p-8 text-center"><Loader2 className="mx-auto animate-spin text-accent" size={24} /></div>
  }

  const objects = data?.objects ?? []
  const bucket = data?.bucket != null && data.bucket !== '' ? data.bucket : 'voc-raw-data'

  return (
    <div>
      <Breadcrumbs bucket={bucket} path={path} onNavigateToBreadcrumb={onNavigateToBreadcrumb} />

      {path.length > 0 && (
        <div className="px-2 py-1.5 border-b border-border">
          <button type="button" onClick={onNavigateUp} className="btn btn-ghost btn-sm">
            <ArrowLeft size={14} /> {t('s3Browser.back')}
          </button>
        </div>
      )}

      {objects.length === 0 ? <EmptyFolder /> : (
        <ul className="divide-y divide-border">
          {objects.map((obj) => (
            <S3ObjectRow
              key={obj.fullKey ?? obj.key}
              obj={obj}
              onNavigateToFolder={onNavigateToFolder}
              onView={onView}
              onEdit={onEdit}
              onDownload={onDownload}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

interface S3ObjectRowProps extends S3ObjectActions {
  readonly obj: S3Object
}

function RowAction({ icon: Icon, label, onClick, hoverClass }: Readonly<{
  icon: LucideIcon
  label: string
  onClick: () => void
  hoverClass: string
}>) {
  return (
    <button type="button" onClick={onClick} className={clsx('icon-btn p-2', hoverClass)} title={label} aria-label={label}>
      <Icon size={16} />
    </button>
  )
}

function S3ObjectRow({ obj, onNavigateToFolder, onView, onEdit, onDownload }: S3ObjectRowProps) {
  const { t } = useTranslation('dataExplorer')
  const fullKey = obj.fullKey ?? obj.key

  // The row's primary action is a real <button>: it was a clickable <div>, which
  // a keyboard user could not reach, so folders could only be opened by mouse.
  const handleClick = () => {
    if (obj.isFolder) {
      onNavigateToFolder(obj.key)
    } else {
      onView(fullKey)
    }
  }

  return (
    <li className="flex items-center justify-between gap-2 px-2 sm:px-4 py-1.5 hover:bg-bg-hover transition-colors">
      <button type="button" onClick={handleClick} className="flex items-center gap-3 flex-1 min-w-0 text-left rounded-md px-2 py-1.5">
        {obj.isFolder ? <FolderOpen size={18} className="text-warn flex-shrink-0" aria-hidden="true" /> : getFileIcon(obj.key)}
        <span className="min-w-0">
          <span className="block font-medium text-sm text-text-strong truncate" title={obj.key}>{obj.key}</span>
          {!obj.isFolder && (
            <span className="block text-xs text-muted">
              <span className="font-mono">{formatFileSize(obj.size)}</span> • {safeFormatDate(obj.lastModified, 'MMM d, yyyy HH:mm')}
            </span>
          )}
        </span>
      </button>
      {!obj.isFolder && (
        <div className="flex items-center flex-shrink-0">
          <RowAction icon={Eye} label={t('s3Browser.view')} onClick={() => onView(fullKey)} hoverClass="hover:text-accent-text" />
          <RowAction icon={Download} label={t('s3Browser.download')} onClick={() => onDownload(fullKey, obj.key)} hoverClass="hover:text-accent-text" />
          {isEditableFile(obj.key) && !isImmutableRawKey(fullKey) && (
            <RowAction icon={Pencil} label={t('s3Browser.edit')} onClick={() => onEdit(fullKey)} hoverClass="hover:text-accent-text" />
          )}
        </div>
      )}
    </li>
  )
}
