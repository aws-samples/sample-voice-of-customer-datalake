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
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { 
  Upload, FolderPlus, Trash2, FileText, Loader2, 
  CheckCircle2, AlertCircle, RefreshCw, FolderOpen
} from 'lucide-react'
import { api } from '../../api/client'
import type { S3ImportFile, S3ImportSource } from '../../api/client'
import clsx from 'clsx'
import { format } from 'date-fns'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const SUPPORTED_FILE_REGEX = /\.(csv|json|jsonl)$/i

function UploadingState({ count }: Readonly<{ count: number }>) {
  return (
    <div className="flex items-center justify-center gap-2 text-blue-600">
      <Loader2 size={20} className="animate-spin" />
      <span className="text-sm sm:text-base">Uploading {count} file(s)...</span>
    </div>
  )
}

function SuccessState({ message }: Readonly<{ message: string }>) {
  return (
    <div className="flex items-center justify-center gap-2 text-green-600">
      <CheckCircle2 size={20} />
      <span className="text-sm sm:text-base">Uploaded {message}</span>
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
  return (
    <>
      <Upload size={24} className="mx-auto mb-2 text-gray-400" />
      <p className="text-gray-600 text-sm sm:text-base">Drop files here or click to upload</p>
      <p className="text-xs text-gray-400 mt-1">Supports CSV, JSON, JSONL</p>
      {selectedSource && <p className="text-xs text-blue-600 mt-1">Uploading to: {selectedSource}</p>}
    </>
  )
}

function UploadStateDisplay({ uploadSuccess, uploadError, selectedSource }: Readonly<{ uploadSuccess: string | null; uploadError: string | null; selectedSource: string }>) {
  if (uploadSuccess) return <SuccessState message={uploadSuccess} />
  if (uploadError) return <ErrorState message={uploadError} />
  return <IdleState selectedSource={selectedSource} />
}

function FileListContent({ loadingFiles, files, onDelete }: Readonly<{ loadingFiles: boolean; files: S3ImportFile[]; onDelete: (key: string) => void }>) {
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
        <p>No files found</p>
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
              {file.status === 'processed' ? 'Processed' : 'Pending'}
            </span>
            <button onClick={() => onDelete(file.key)} className="p-2 sm:p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded" title="Delete file">
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function S3ImportExplorer() {
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
    queryFn: () => api.getS3ImportFiles({ source: selectedSource || undefined }),
  })

  const createSourceMutation = useMutation({
    mutationFn: (name: string) => api.createS3ImportSource(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['s3-import-sources'] })
      setNewSourceName('')
      setShowNewSource(false)
    },
  })

  const deleteFileMutation = useMutation({
    mutationFn: (key: string) => api.deleteS3ImportFile(key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['s3-import-files'] })
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
      showTemporaryError(`Unsupported file type: ${file.name}. Only CSV, JSON, and JSONL files are supported.`)
      return false
    }

    addUploadingFile(file.name)

    const contentType = file.type || 'application/octet-stream'
    const result = await api.getS3UploadUrl(file.name, source, contentType)
      .then(async (urlResponse) => {
        if (!urlResponse.success || !urlResponse.upload_url) {
          throw new Error(urlResponse.message || 'Failed to get upload URL')
        }
        await fetch(urlResponse.upload_url, { method: 'PUT', body: file, headers: { 'Content-Type': contentType } })
        return true
      })
      .catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error'
        showTemporaryError(`Failed to upload ${file.name}: ${errorMessage}`)
        return false
      })

    removeUploadingFile(file.name)
    if (result) {
      showTemporarySuccess(file.name)
      queryClient.invalidateQueries({ queryKey: ['s3-import-files'] })
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

  const sources = sourcesData?.sources || []
  const files = filesData?.files || []
  const bucket = sourcesData?.bucket

  if (!bucket) {
    return (
      <div className="text-center py-8 text-gray-500">
        <AlertCircle className="mx-auto mb-2" size={24} />
        <p>S3 Import bucket not configured</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header with bucket info */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="text-sm text-gray-500 truncate">
          Bucket: <code className="bg-gray-100 px-2 py-0.5 rounded text-xs">{bucket}</code>
        </div>
        <button onClick={() => refetchFiles()} className="btn btn-secondary text-sm flex items-center justify-center gap-1 w-full sm:w-auto">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Source selector and creator */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <FolderOpen size={18} className="text-gray-400 flex-shrink-0" />
          <select
            value={selectedSource}
            onChange={(e) => setSelectedSource(e.target.value)}
            className="input py-2 sm:py-1.5 text-sm flex-1 sm:min-w-[150px]"
          >
            <option value="">All Sources</option>
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
              placeholder="Source name..."
              className="input py-2 sm:py-1.5 text-sm flex-1 sm:w-40"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={() => newSourceName && createSourceMutation.mutate(newSourceName)}
                disabled={!newSourceName || createSourceMutation.isPending}
                className="btn btn-primary py-2 sm:py-1.5 text-sm flex-1 sm:flex-none"
              >
                {createSourceMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : 'Create'}
              </button>
              <button onClick={() => setShowNewSource(false)} className="btn btn-secondary py-2 sm:py-1.5 text-sm flex-1 sm:flex-none">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowNewSource(true)} className="btn btn-secondary py-2 sm:py-1.5 text-sm flex items-center justify-center gap-1 w-full sm:w-auto">
            <FolderPlus size={14} /> New Source
          </button>
        )}
      </div>

      {/* Upload area */}
      <div
        className={clsx(
          'border-2 border-dashed rounded-lg p-4 sm:p-6 text-center transition-colors',
          'hover:border-blue-400 hover:bg-blue-50/50 cursor-pointer',
          uploadingFiles.size > 0 ? 'border-blue-400 bg-blue-50' : 'border-gray-300'
        )}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleFileUpload(e.dataTransfer.files) }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.json,.jsonl"
          multiple
          className="hidden"
          onChange={(e) => handleFileUpload(e.target.files)}
        />
        
        {uploadingFiles.size > 0 ? (
          <UploadingState count={uploadingFiles.size} />
        ) : (
          <UploadStateDisplay uploadSuccess={uploadSuccess} uploadError={uploadError} selectedSource={selectedSource} />
        )}
      </div>

      {/* File list */}
      <div className="border rounded-lg overflow-hidden">
        <div className="bg-gray-50 px-4 py-2 border-b text-sm font-medium text-gray-700">
          Files ({files.length})
        </div>
        <FileListContent loadingFiles={loadingFiles} files={files} onDelete={(key) => deleteFileMutation.mutate(key)} />
      </div>
    </div>
  )
}
