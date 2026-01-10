/**
 * @fileoverview S3 Browser component for Data Explorer.
 * @module pages/DataExplorer/S3Browser
 */

import { FolderOpen, FileJson, ChevronRight, Eye, Pencil, Trash2, ArrowLeft, HardDrive, Image, FileText, Download, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import { safeFormatDate } from '../../utils/dateUtils'

export interface S3Object {
  key: string
  fullKey?: string
  size: number
  lastModified: string
  isFolder: boolean
}

interface S3BrowserProps {
  readonly path: string[]
  readonly data: { objects: S3Object[]; bucket: string; prefix: string } | undefined
  readonly loading: boolean
  readonly onNavigateToFolder: (folder: string) => void
  readonly onNavigateUp: () => void
  readonly onNavigateToBreadcrumb: (index: number) => void
  readonly onView: (key: string) => void
  readonly onEdit: (key: string) => void
  readonly onDelete: (key: string) => void
  readonly onDownload: (key: string, filename: string) => void
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
    return <Image size={20} className="text-purple-500" />
  }
  if (ext === 'pdf') {
    return <FileText size={20} className="text-red-500" />
  }
  return <FileJson size={20} className="text-blue-500" />
}

function isEditableFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return !['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'pdf'].includes(ext)
}

export default function S3Browser({
  path, data, loading, onNavigateToFolder, onNavigateUp, onNavigateToBreadcrumb, onView, onEdit, onDelete, onDownload
}: S3BrowserProps) {
  if (loading) {
    return <div className="p-8 text-center"><Loader2 className="mx-auto animate-spin text-gray-400" size={32} /></div>
  }

  const objects = data?.objects ?? []
  const bucket = data?.bucket ?? 'voc-raw-data'

  return (
    <div>
      <div className="bg-gray-50 px-4 py-3 border-b flex items-center gap-2 text-sm">
        <HardDrive size={16} className="text-gray-400" />
        <button onClick={() => onNavigateToBreadcrumb(-1)} className="text-blue-600 hover:underline">{bucket}</button>
        {path.map((segment, i) => (
          <span key={i} className="flex items-center gap-2">
            <ChevronRight size={14} className="text-gray-400" />
            <button
              onClick={() => onNavigateToBreadcrumb(i)}
              className={clsx(i === path.length - 1 ? 'text-gray-900 font-medium' : 'text-blue-600 hover:underline')}
            >
              {segment}
            </button>
          </span>
        ))}
      </div>

      {path.length > 0 && (
        <div className="px-4 py-2 border-b">
          <button onClick={onNavigateUp} className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900">
            <ArrowLeft size={16} /> Back
          </button>
        </div>
      )}

      {objects.length === 0 ? (
        <div className="p-8 text-center text-gray-500">
          <FolderOpen size={48} className="mx-auto mb-4 opacity-50" />
          <p>No files found</p>
        </div>
      ) : (
        <div className="divide-y">
          {objects.map((obj) => (
            <S3ObjectRow
              key={obj.key}
              obj={obj}
              onNavigateToFolder={onNavigateToFolder}
              onView={onView}
              onEdit={onEdit}
              onDelete={onDelete}
              onDownload={onDownload}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface S3ObjectRowProps {
  readonly obj: S3Object
  readonly onNavigateToFolder: (folder: string) => void
  readonly onView: (key: string) => void
  readonly onEdit: (key: string) => void
  readonly onDelete: (key: string) => void
  readonly onDownload: (key: string, filename: string) => void
}

function S3ObjectRow({ obj, onNavigateToFolder, onView, onEdit, onDelete, onDownload }: S3ObjectRowProps) {
  const fullKey = obj.fullKey ?? obj.key

  const handleClick = () => {
    if (obj.isFolder) {
      onNavigateToFolder(obj.key)
    } else {
      onView(fullKey)
    }
  }

  return (
    <div className="flex items-center justify-between px-4 py-3 hover:bg-gray-50">
      <div className="flex items-center gap-3 cursor-pointer flex-1" onClick={handleClick}>
        {obj.isFolder ? <FolderOpen size={20} className="text-yellow-500" /> : getFileIcon(obj.key)}
        <div>
          <p className="font-medium text-sm">{obj.key}</p>
          {!obj.isFolder && (
            <p className="text-xs text-gray-500">
              {formatFileSize(obj.size)} • {safeFormatDate(obj.lastModified, 'MMM d, yyyy HH:mm')}
            </p>
          )}
        </div>
      </div>
      {!obj.isFolder && (
        <div className="flex items-center gap-1">
          <button onClick={() => onView(fullKey)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded" title="View">
            <Eye size={16} />
          </button>
          <button onClick={() => onDownload(fullKey, obj.key)} className="p-1.5 text-gray-400 hover:text-purple-600 hover:bg-purple-50 rounded" title="Download">
            <Download size={16} />
          </button>
          {isEditableFile(obj.key) && (
            <button onClick={() => onEdit(fullKey)} className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded" title="Edit">
              <Pencil size={16} />
            </button>
          )}
          <button onClick={() => onDelete(fullKey)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete">
            <Trash2 size={16} />
          </button>
        </div>
      )}
    </div>
  )
}
