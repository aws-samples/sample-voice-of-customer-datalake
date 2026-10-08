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

import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Upload, FolderPlus, Trash2, FileText, Loader2,
  CheckCircle2, AlertCircle, RefreshCw, FolderOpen
} from 'lucide-react'
import { api } from '../../api/client'
import type { S3ImportFile, S3ImportSource } from '../../api/types'
import clsx from 'clsx'
import { formatFileSize } from '../../utils/file'

const SUPPORTED_FILE_REGEX = /\.(csv|json|jsonl)$/i
const FALLBACK_CONTENT_TYPE = 'application/octet-stream'

/** Last-modified time in the UI language (medium date, short time). */
function formatModified(iso: string, language: string): string {
  return new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })
}

function UploadingState({ count }: Readonly<{ count: number }>) {
  const { t } = useTranslation('components')
  return (
    <div className="flex items-center justify-center gap-2 text-accent-text">
      <Loader2 size={20} className="animate-spin" aria-hidden />
      <span className="text-sm sm:text-base">{t('s3Import.uploading', { count })}</span>
    </div>
  )
}

function SuccessState({ filename }: Readonly<{ filename: string }>) {
  const { t } = useTranslation('components')
  return (
    <div className="flex items-center justify-center gap-2 text-ok">
      <CheckCircle2 size={20} aria-hidden />
      <span className="text-sm sm:text-base">{t('s3Import.uploaded', { filename })}</span>
    </div>
  )
}

function ErrorState({ message }: Readonly<{ message: string }>) {
  return (
    <div className="flex items-center justify-center gap-2 text-danger">
      <AlertCircle size={20} aria-hidden />
      <span className="text-xs sm:text-sm">{message}</span>
    </div>
  )
}

function IdleState({ selectedSource }: Readonly<{ selectedSource: string }>) {
  const { t } = useTranslation('components')
  return (
    <>
      <Upload size={24} className="mx-auto mb-2 text-muted" aria-hidden />
      <p className="text-text text-sm sm:text-base">{t('s3Import.dropFiles')}</p>
      <p className="text-xs text-muted mt-1">{t('s3Import.supportedFormats')}</p>
      {selectedSource !== '' && <p className="text-xs text-accent-text mt-1">{t('s3Import.uploadingTo', { source: selectedSource })}</p>}
    </>
  )
}

function UploadStateDisplay({ uploadSuccess, uploadError, selectedSource }: Readonly<{ uploadSuccess: string | null; uploadError: string | null; selectedSource: string }>) {
  if (uploadSuccess !== null) return <SuccessState filename={uploadSuccess} />
  if (uploadError !== null) return <ErrorState message={uploadError} />
  return <IdleState selectedSource={selectedSource} />
}

function FileListContent({ loadingFiles, files, onDelete }: Readonly<{ loadingFiles: boolean; files: S3ImportFile[]; onDelete: (key: string) => void }>) {
  const { t, i18n } = useTranslation('components')
  if (loadingFiles) {
    return (
      <div className="p-8 text-center text-muted">
        <Loader2 className="mx-auto animate-spin" size={24} aria-hidden />
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="p-8 text-center text-muted">
        <FileText className="mx-auto mb-2" size={24} aria-hidden />
        <p>{t('s3Import.noFiles')}</p>
      </div>
    )
  }

  return (
    <div className="divide-y">
      {files.map((file) => (
        <div key={file.key} className="flex flex-col sm:flex-row sm:items-center justify-between px-3 sm:px-4 py-3 hover:bg-bg-hover gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <FileText size={18} className={clsx('flex-shrink-0', file.status === 'processed' ? 'text-ok' : 'text-info')} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm truncate">{file.filename}</p>
              <p className="text-xs text-muted truncate">
                {file.source} • {formatFileSize(file.size)} • {formatModified(file.last_modified, i18n.language)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 justify-end sm:justify-start ml-6 sm:ml-0">
            <span className={clsx('text-xs px-2 py-0.5 rounded-sm whitespace-nowrap', file.status === 'processed' ? 'bg-ok-subtle text-ok' : 'bg-warn-subtle text-warn')}>
              {file.status === 'processed' ? t('s3Import.processed') : t('s3Import.pending')}
            </span>
            <button
              type="button"
              onClick={() => onDelete(file.key)}
              className="p-2 sm:p-1.5 text-muted hover:text-danger hover:bg-danger-subtle rounded-sm"
              title={t('s3Import.deleteFile')}
              aria-label={t('s3Import.deleteFile')}
            >
              <Trash2 size={16} aria-hidden />
            </button>
          </div>
        </div>
      ))}
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
    queryFn: () => api.getS3ImportSources(),
  })

  const { data: filesData, isLoading: loadingFiles, refetch: refetchFiles } = useQuery({
    queryKey: ['s3-import-files', selectedSource],
    queryFn: () => api.getS3ImportFiles({ source: selectedSource === '' ? undefined : selectedSource }),
  })

  const createSourceMutation = useMutation({
    mutationFn: (name: string) => api.createS3ImportSource(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['s3-import-sources'] })
      setNewSourceName('')
      setShowNewSource(false)
    },
  })

  const deleteFileMutation = useMutation({
    mutationFn: (key: string) => api.deleteS3ImportFile(key),
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
    setUploadingFiles(prev => new Set(prev).add(filename))
  }

  const removeUploadingFile = (filename: string) => {
    setUploadingFiles(prev => {
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

    // `File.type` is '' (not undefined) when the browser cannot tell.
    const contentType = file.type === '' ? FALLBACK_CONTENT_TYPE : file.type
    const result = await api.getS3UploadUrl(file.name, source, contentType)
      .then(async (urlResponse) => {
        const uploadUrl = urlResponse.upload_url ?? ''
        if (!urlResponse.success || uploadUrl === '') {
          throw new Error(urlResponse.error === undefined || urlResponse.error === '' ? t('s3Import.uploadUrlFailed') : urlResponse.error)
        }
        await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': contentType } })
        return true
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : t('s3Import.unknownError')
        showTemporaryError(t('s3Import.uploadFailed', { filename: file.name, error }))
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

    const source = selectedSource || 'default'

    for (const file of Array.from(files)) {
      await uploadSingleFile(file, source)
    }

    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const sources = sourcesData?.sources ?? []
  const files = filesData?.files ?? []
  const bucket = sourcesData?.bucket

  if (!bucket) {
    return (
      <div className="text-center py-8 text-muted">
        <AlertCircle className="mx-auto mb-2" size={24} aria-hidden />
        <p>{t('s3Import.notConfigured')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header with bucket info */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="text-sm text-muted truncate">
          {t('s3Import.bucket')} <code className="bg-bg-hover text-text font-mono px-2 py-0.5 rounded-sm text-xs">{bucket}</code>
        </div>
        <button
          type="button"
          onClick={() => {
            void refetchFiles()
          }}
          className="btn btn-secondary text-sm flex items-center justify-center gap-1 w-full sm:w-auto"
        >
          <RefreshCw size={14} aria-hidden /> {t('s3Import.refresh')}
        </button>
      </div>

      {/* Source selector and creator */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <FolderOpen size={18} className="text-muted flex-shrink-0" aria-hidden />
          <select
            value={selectedSource}
            onChange={(e) => setSelectedSource(e.target.value)}
            className="select py-2 sm:py-1.5 flex-1 sm:min-w-[150px]"
            aria-label={t('s3Import.allSources')}
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
              aria-label={t('s3Import.sourcePlaceholder')}
              className="input py-2 sm:py-1.5 text-sm flex-1 sm:w-40"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  if (newSourceName !== '') createSourceMutation.mutate(newSourceName)
                }}
                disabled={newSourceName === '' || createSourceMutation.isPending}
                aria-label={t('s3Import.create')}
                className="btn btn-primary py-2 sm:py-1.5 text-sm flex-1 sm:flex-none"
              >
                {createSourceMutation.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : t('s3Import.create')}
              </button>
              <button type="button" onClick={() => setShowNewSource(false)} className="btn btn-secondary py-2 sm:py-1.5 text-sm flex-1 sm:flex-none">
                {t('s3Import.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setShowNewSource(true)} className="btn btn-secondary py-2 sm:py-1.5 text-sm flex items-center justify-center gap-1 w-full sm:w-auto">
            <FolderPlus size={14} aria-hidden /> {t('s3Import.newSource')}
          </button>
        )}
      </div>

      {/* Upload area */}
      <div
        className={clsx(
          'border-2 border-dashed rounded-lg p-4 sm:p-6 text-center transition-colors',
          'hover:border-accent hover:bg-accent-subtle/50 cursor-pointer',
          uploadingFiles.size > 0 ? 'border-accent bg-accent-subtle' : 'border-border-strong'
        )}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void handleFileUpload(e.dataTransfer.files)
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.json,.jsonl"
          aria-label={t('s3Import.dropFiles')}
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
      </div>

      {/* File list */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="bg-bg-accent px-4 py-2 border-b border-border text-sm font-medium text-text-strong">
          {t('s3Import.filesCount', { count: files.length })}
        </div>
        <FileListContent loadingFiles={loadingFiles} files={files} onDelete={(key) => deleteFileMutation.mutate(key)} />
      </div>
    </div>
  )
}
