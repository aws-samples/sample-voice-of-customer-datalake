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
import { api } from '../api/client'
import type { S3ImportFile, S3ImportSource } from '../api/client'
import clsx from 'clsx'
import { format } from 'date-fns'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    
    const source = selectedSource || 'default'
    
    for (const file of Array.from(files)) {
      if (!file.name.match(/\.(csv|json|jsonl)$/i)) {
        setUploadError(`Unsupported file type: ${file.name}. Only CSV, JSON, and JSONL files are supported.`)
        setTimeout(() => setUploadError(null), 5000)
        continue
      }
      
      setUploadingFiles(prev => new Set(prev).add(file.name))
      
      try {
        const urlResponse = await api.getS3UploadUrl(file.name, source, file.type || 'application/octet-stream')
        
        if (!urlResponse.success || !urlResponse.upload_url) {
          throw new Error(urlResponse.message || 'Failed to get upload URL')
        }
        
        await fetch(urlResponse.upload_url, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': file.type || 'application/octet-stream' }
        })
        
        setUploadSuccess(file.name)
        setTimeout(() => setUploadSuccess(null), 3000)
        queryClient.invalidateQueries({ queryKey: ['s3-import-files'] })
      } catch (err) {
        if (import.meta.env.DEV) {
          console.error('Upload failed:', err)
        }
        setUploadError(`Failed to upload ${file.name}: ${err instanceof Error ? err.message : 'Unknown error'}`)
        setTimeout(() => setUploadError(null), 5000)
      } finally {
        setUploadingFiles(prev => {
          const next = new Set(prev)
          next.delete(file.name)
          return next
        })
      }
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
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-500">
          Bucket: <code className="bg-gray-100 px-2 py-0.5 rounded">{bucket}</code>
        </div>
        <button onClick={() => refetchFiles()} className="btn btn-secondary text-sm flex items-center gap-1">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Source selector and creator */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <FolderOpen size={18} className="text-gray-400" />
          <select
            value={selectedSource}
            onChange={(e) => setSelectedSource(e.target.value)}
            className="input py-1.5 text-sm min-w-[150px]"
          >
            <option value="">All Sources</option>
            {sources.map((s: S3ImportSource) => (
              <option key={s.name} value={s.name}>{s.display_name}</option>
            ))}
          </select>
        </div>
        
        {showNewSource ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newSourceName}
              onChange={(e) => setNewSourceName(e.target.value)}
              placeholder="Source name..."
              className="input py-1.5 text-sm w-40"
              autoFocus
            />
            <button
              onClick={() => newSourceName && createSourceMutation.mutate(newSourceName)}
              disabled={!newSourceName || createSourceMutation.isPending}
              className="btn btn-primary py-1.5 text-sm"
            >
              {createSourceMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : 'Create'}
            </button>
            <button onClick={() => setShowNewSource(false)} className="btn btn-secondary py-1.5 text-sm">
              Cancel
            </button>
          </div>
        ) : (
          <button onClick={() => setShowNewSource(true)} className="btn btn-secondary py-1.5 text-sm flex items-center gap-1">
            <FolderPlus size={14} /> New Source
          </button>
        )}
      </div>

      {/* Upload area */}
      <div
        className={clsx(
          'border-2 border-dashed rounded-lg p-6 text-center transition-colors',
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
          <div className="flex items-center justify-center gap-2 text-blue-600">
            <Loader2 size={20} className="animate-spin" />
            <span>Uploading {uploadingFiles.size} file(s)...</span>
          </div>
        ) : uploadSuccess ? (
          <div className="flex items-center justify-center gap-2 text-green-600">
            <CheckCircle2 size={20} />
            <span>Uploaded {uploadSuccess}</span>
          </div>
        ) : uploadError ? (
          <div className="flex items-center justify-center gap-2 text-red-600">
            <AlertCircle size={20} />
            <span className="text-sm">{uploadError}</span>
          </div>
        ) : (
          <>
            <Upload size={24} className="mx-auto mb-2 text-gray-400" />
            <p className="text-gray-600">Drop files here or click to upload</p>
            <p className="text-xs text-gray-400 mt-1">Supports CSV, JSON, JSONL</p>
            {selectedSource && (
              <p className="text-xs text-blue-600 mt-1">Uploading to: {selectedSource}</p>
            )}
          </>
        )}
      </div>

      {/* File list */}
      <div className="border rounded-lg overflow-hidden">
        <div className="bg-gray-50 px-4 py-2 border-b text-sm font-medium text-gray-700">
          Files ({files.length})
        </div>
        
        {loadingFiles ? (
          <div className="p-8 text-center text-gray-500">
            <Loader2 className="mx-auto animate-spin" size={24} />
          </div>
        ) : files.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <FileText className="mx-auto mb-2" size={24} />
            <p>No files found</p>
          </div>
        ) : (
          <div className="divide-y">
            {files.map((file: S3ImportFile) => (
              <div key={file.key} className="flex items-center justify-between px-4 py-3 hover:bg-gray-50">
                <div className="flex items-center gap-3 min-w-0">
                  <FileText size={18} className={file.status === 'processed' ? 'text-green-500' : 'text-blue-500'} />
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{file.filename}</p>
                    <p className="text-xs text-gray-500">
                      {file.source} • {formatFileSize(file.size)} • {format(new Date(file.last_modified), 'MMM d, yyyy HH:mm')}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={clsx(
                    'text-xs px-2 py-0.5 rounded',
                    file.status === 'processed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                  )}>
                    {file.status === 'processed' ? 'Processed' : 'Pending'}
                  </span>
                  <button
                    onClick={() => deleteFileMutation.mutate(file.key)}
                    disabled={deleteFileMutation.isPending}
                    className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"
                    title="Delete file"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
