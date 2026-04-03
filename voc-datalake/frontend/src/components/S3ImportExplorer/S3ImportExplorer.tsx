/**
 * @fileoverview S3 import file explorer component.
 *
 * Features:
 * - Browse S3 import bucket by source
 * - Create new import sources
 * - Upload CSV, JSON, JSONL files via presigned URLs
 * - View file status (pending/processed)
 * - Delete files
 *
 * @module components/S3ImportExplorer
 */

import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import clsx from 'clsx'
import { format } from 'date-fns'
import {
  Upload, FolderPlus, Trash2, FileText, Loader2,
  CheckCircle2, AlertCircle, RefreshCw, FolderOpen,
} from 'lucide-react'
import {
  useState, useRef,
} from 'react'
import { useTranslation } from 'react-i18next'
import { dataExplorerApi } from '../../api/dataExplorerApi'
import { formatFileSize } from '../../utils/file'
import type {
  S3ImportFile, S3ImportSource,
} from '../../api/types'

const SUPPORTED_FILE_REGEX = /\.(csv|json|jsonl)$/i

function UploadingState({ count }: Readonly<{ count: number }>) {
  const { t } = useTranslation('components')
  return (
    <div className="flex items-center justify-center gap-2 text-blue-600">
      <Loader2 size={20} className="animate-spin" />
      <span className="text-sm sm:text-base">{t('s3Import.uploading', { count })}</span>
    </div>
  )
}

function SuccessState({ message }: Readonly<{ message: string }>) {
  const { t } = useTranslation('components')
  return (
    <div className="flex items-center justify-center gap-2 text-green-600">
      <CheckCircle2 size={20} />
      <span className="text-sm sm:text-base">{t('s3Import.uploaded', { filename: message })}</span>
    </div>
  )
}

function ErrorState({ message }: Readonly<{ message: string }>) {
  return (
    <div className="flex items-center justify-center gap-2 text-red-600">
      <AlertCircle size={20} />
      <span className="text-xs sm:text-sm">{message}</span>
    </div>
  )
}

function IdleState({ selectedSource }: Readonly<{ selectedSource: string }>) {
  const { t } = useTranslation('components')
  return (
    <>
      <Upload size={24} className="mx-auto mb-2 text-gray-400" />
      <p className="text-gray-600 text-sm sm:text-base">{t('s3Import.dropFiles')}</p>
      <p className="text-xs text-gray-400 mt-1">{t('s3Import.supportedFormats')}</p>
      {selectedSource === '' ? null : <p className="text-xs text-blue-600 mt-1">{t('s3Import.uploadingTo', { source: selectedSource })}</p>}
    </>
  )
}

function UploadStateDisplay({
  uploadSuccess, uploadError, selectedSource,
}: Readonly<{
  uploadSuccess: string | null;
  uploadError: string | null;
  selectedSource: string
}>) {
  if (uploadSuccess != null && uploadSuccess !== '') return <SuccessState message={uploadSuccess} />
  if (uploadError != null && uploadError !== '') return <ErrorState message={uploadError} />
  return <IdleState selectedSource={selectedSource} />
}

function FileListContent({
  loadingFiles, files, onDelete,
}: Readonly<{
  loadingFiles: boolean;
  files: S3ImportFile[];
  onDelete: (key: string) => void
}>) {
  const { t } = useTranslation('components')
  if (loadingFiles) {
    return (
      <div className="p-8 text-center text-gray-500">
        <Loader2 className="mx-auto animate-spin" size={24} />
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="p-8 text-center text-gray-500">
        <FileText className="mx-auto mb-2" size={24} />
        <p>{t('s3Import.noFiles')}</p>
      </div>
    )
  }

  return (
    <div className="divide-y">
      {files.map((file) => (
        <div key={file.key} className="flex flex-col sm:flex-row sm:items-center justify-between px-3 sm:px-4 py-3 hover:bg-gray-50 gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <FileText size={18} className={clsx('flex-shrink-0', file.status === 'processed' ? 'text-green-500' : 'text-blue-500')} />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm truncate">{file.filename}</p>
              <p className="text-xs text-gray-500 truncate">
                {file.source} • {formatFileSize(file.size)} • {format(new Date(file.last_modified), 'MMM d, yyyy HH:mm')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 justify-end sm:justify-start ml-6 sm:ml-0">
            <span className={clsx('text-xs px-2 py-0.5 rounded whitespace-nowrap', file.status === 'processed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700')}>
              {file.status === 'processed' ? t('s3Import.processed') : t('s3Import.pending')}
            </span>
            <button onClick={() => onDelete(file.key)} className="p-2 sm:p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded" title={t('s3Import.deleteFile')}>
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

class S3UploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'S3UploadError'
  }
}

function SourceSelector({
  selectedSource, sources, onSourceChange, showNewSource, setShowNewSource,
  newSourceName, setNewSourceName, createSourceMutation, t,
}: Readonly<{
  selectedSource: string
  sources: S3ImportSource[]
  onSourceChange: (value: string) => void
  showNewSource: boolean
  setShowNewSource: (show: boolean) => void
  newSourceName: string
  setNewSourceName: (name: string) => void
  createSourceMutation: {
    mutate: (name: string) => void;
    isPending: boolean
  }
  t: (key: string) => string
}>) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
      <div className="flex items-center gap-2 w-full sm:w-auto">
        <FolderOpen size={18} className="text-gray-400 flex-shrink-0" />
        <select
          value={selectedSource}
          onChange={(e) => onSourceChange(e.target.value)}
          className="input py-2 sm:py-1.5 text-sm flex-1 sm:min-w-[150px]"
        >
          <option value="">{t('s3Import.allSources')}</option>
          {sources.map((s: S3ImportSource) => (
            <option key={s.name} value={s.name}>{s.display_name}</option>
          ))}
        </select>
      </div>

      {showNewSource ? (
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
          <input
            type="text"
            value={newSourceName}
            onChange={(e) => setNewSourceName(e.target.value)}
            placeholder={t('s3Import.sourcePlaceholder')}
            className="input py-2 sm:py-1.5 text-sm flex-1 sm:w-40"
          />
          <div className="flex gap-2">
            <button
              onClick={() => newSourceName === '' || createSourceMutation.mutate(newSourceName)}
              disabled={newSourceName === '' || createSourceMutation.isPending}
              className="btn btn-primary py-2 sm:py-1.5 text-sm flex-1 sm:flex-none"
            >
              {createSourceMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : t('s3Import.create')}
            </button>
            <button onClick={() => setShowNewSource(false)} className="btn btn-secondary py-2 sm:py-1.5 text-sm flex-1 sm:flex-none">
              {t('s3Import.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowNewSource(true)} className="btn btn-secondary py-2 sm:py-1.5 text-sm flex items-center justify-center gap-1 w-full sm:w-auto">
          <FolderPlus size={14} /> {t('s3Import.newSource')}
        </button>
      )}
    </div>
  )
}

export default function S3ImportExplorer() {
  const { t } = useTranslation('components')
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedSource, setSelectedSource] = useState<string>('')
  const [newSourceName, setNewSourceName] = useState('')
  const [showNewSource, setShowNewSource] = useState(false)
  const [uploadingFiles, setUploadingFiles] = useState<Set<string>>(new Set())
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const { data: sourcesData } = useQuery({
    queryKey: ['s3-import-sources'],
    queryFn: () => dataExplorerApi.getS3ImportSources(),
  })

  const {
    data: filesData, isLoading: loadingFiles, refetch: refetchFiles,
  } = useQuery({
    queryKey: ['s3-import-files', selectedSource],
    queryFn: () => dataExplorerApi.getS3ImportFiles({ source: selectedSource === '' ? undefined : selectedSource }),
  })

  const createSourceMutation = useMutation({
    mutationFn: (name: string) => dataExplorerApi.createS3ImportSource(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['s3-import-sources'] })
      setNewSourceName('')
      setShowNewSource(false)
    },
  })

  const deleteFileMutation = useMutation({
    mutationFn: (key: string) => dataExplorerApi.deleteS3ImportFile(key),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['s3-import-files'] })
    },
  })

  const showTemporaryError = (message: string) => {
    setUploadError(message)
    setTimeout(() => setUploadError(null), 5000)
  }

  const showTemporarySuccess = (filename: string) => {
    setUploadSuccess(filename)
    setTimeout(() => setUploadSuccess(null), 3000)
  }

  const addUploadingFile = (filename: string) => {
    setUploadingFiles((prev) => new Set(prev).add(filename))
  }

  const removeUploadingFile = (filename: string) => {
    setUploadingFiles((prev) => {
      const next = new Set(prev)
      next.delete(filename)
      return next
    })
  }

  const uploadSingleFile = async (file: File, source: string): Promise<boolean> => {
    if (!SUPPORTED_FILE_REGEX.test(file.name)) {
      showTemporaryError(t('s3Import.unsupportedFile', { filename: file.name }))
      return false
    }

    addUploadingFile(file.name)

    const contentType = file.type === '' ? 'application/octet-stream' : file.type
    const result = await dataExplorerApi.getS3UploadUrl(file.name, source, contentType)
      .then(async (urlResponse) => {
        if (!urlResponse.success || urlResponse.upload_url === '') {
          throw new S3UploadError('Failed to get upload URL')
        }
        await fetch(urlResponse.upload_url, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': contentType },
        })
        return true
      })
      .catch((err) => {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error'
        showTemporaryError(t('s3Import.uploadFailed', {
          filename: file.name,
          error: errorMessage,
        }))
        return false
      })

    removeUploadingFile(file.name)
    if (result) {
      showTemporarySuccess(file.name)
      void queryClient.invalidateQueries({ queryKey: ['s3-import-files'] })
    }
    return result
  }

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return

    const source = selectedSource === '' ? 'default' : selectedSource

    for (const file of Array.from(files)) {
      await uploadSingleFile(file, source)
    }

    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const sources = sourcesData?.sources ?? []
  const files = filesData?.files ?? []
  const bucket = sourcesData?.bucket

  if (bucket == null || bucket === '') {
    return (
      <div className="text-center py-8 text-gray-500">
        <AlertCircle className="mx-auto mb-2" size={24} />
        <p>{t('s3Import.notConfigured')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header with bucket info */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="text-sm text-gray-500 truncate">
          {t('s3Import.bucket')} <code className="bg-gray-100 px-2 py-0.5 rounded text-xs">{bucket}</code>
        </div>
        <button
          onClick={() => {
            void refetchFiles()
          }}
          className="btn btn-secondary text-sm flex items-center justify-center gap-1 w-full sm:w-auto"
        >
          <RefreshCw size={14} /> {t('s3Import.refresh')}
        </button>
      </div>

      {/* Source selector and creator */}
      <SourceSelector
        selectedSource={selectedSource}
        sources={sources}
        onSourceChange={setSelectedSource}
        showNewSource={showNewSource}
        setShowNewSource={setShowNewSource}
        newSourceName={newSourceName}
        setNewSourceName={setNewSourceName}
        createSourceMutation={createSourceMutation}
        t={t}
      />

      {/* Upload area */}
      <button
        type="button"
        className={clsx(
          'w-full border-2 border-dashed rounded-lg p-4 sm:p-6 text-center transition-colors',
          'hover:border-blue-400 hover:bg-blue-50/50 cursor-pointer',
          uploadingFiles.size > 0 ? 'border-blue-400 bg-blue-50' : 'border-gray-300',
        )}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault(); e.stopPropagation()
        }}
        onDrop={(e) => {
          e.preventDefault(); e.stopPropagation(); void handleFileUpload(e.dataTransfer.files)
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.json,.jsonl"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleFileUpload(e.target.files)
          }}
        />

        {uploadingFiles.size > 0 ? (
          <UploadingState count={uploadingFiles.size} />
        ) : (
          <UploadStateDisplay uploadSuccess={uploadSuccess} uploadError={uploadError} selectedSource={selectedSource} />
        )}
      </button>

      {/* File list */}
      <div className="border rounded-lg overflow-hidden">
        <div className="bg-gray-50 px-4 py-2 border-b text-sm font-medium text-gray-700">
          {t('s3Import.filesCount', { count: files.length })}
        </div>
        <FileListContent loadingFiles={loadingFiles} files={files} onDelete={(key) => deleteFileMutation.mutate(key)} />
      </div>
    </div>
  )
}
