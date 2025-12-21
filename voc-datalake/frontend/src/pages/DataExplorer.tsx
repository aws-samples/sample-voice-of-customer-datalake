/**
 * @fileoverview Data Explorer page with full CRUD for S3 and DynamoDB data.
 * @module pages/DataExplorer
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Database, HardDrive, FolderOpen, FileJson, ChevronRight, ChevronDown,
  Eye, X, Loader2, RefreshCw, Search, Filter, ArrowLeft, Pencil, Trash2,
  Save, Plus, Link2, AlertTriangle, Image, FileText, Download,
} from 'lucide-react'
import { api, getDaysFromRange } from '../api/client'
import type { FeedbackItem } from '../api/client'
import { useConfigStore } from '../store/configStore'
import SentimentBadge from '../components/SentimentBadge'
import ConfirmModal from '../components/ConfirmModal'
import clsx from 'clsx'
import { format } from 'date-fns'

type ViewMode = 's3-raw' | 'dynamodb-processed' | 'dynamodb-categories'

interface S3Object {
  key: string
  fullKey?: string
  size: number
  lastModified: string
  isFolder: boolean
}

interface EditModalState {
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

export default function DataExplorer() {
  const queryClient = useQueryClient()
  const { timeRange, customDateRange, config } = useConfigStore()
  const days = getDaysFromRange(timeRange, customDateRange)
  const isConfigured = !!config.apiEndpoint

  const [viewMode, setViewMode] = useState<ViewMode>('s3-raw')
  const [s3Path, setS3Path] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<string>('')
  const [editModal, setEditModal] = useState<EditModalState | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 's3' | 'dynamodb'; key: string; id?: string } | null>(null)

  const { data: s3Data, isLoading: s3Loading, refetch: refetchS3 } = useQuery({
    queryKey: ['data-explorer-s3', s3Path.join('/')],
    queryFn: () => api.getDataExplorerS3(s3Path.join('/')),
    enabled: isConfigured && viewMode === 's3-raw',
  })

  const { data: feedbackData, isLoading: feedbackLoading, refetch: refetchFeedback } = useQuery({
    queryKey: ['data-explorer-feedback', days, sourceFilter],
    queryFn: () => api.getFeedback({ days, source: sourceFilter || undefined, limit: 100 }),
    enabled: isConfigured && viewMode === 'dynamodb-processed',
  })

  const { data: categoriesData, isLoading: categoriesLoading, refetch: refetchCategories } = useQuery({
    queryKey: ['data-explorer-categories', days, sourceFilter],
    queryFn: () => api.getCategories(days, sourceFilter || undefined),
    enabled: isConfigured && viewMode === 'dynamodb-categories',
  })

  const { data: sourcesData } = useQuery({
    queryKey: ['sources', days],
    queryFn: () => api.getSources(days),
    enabled: isConfigured,
  })

  const saveS3Mutation = useMutation({
    mutationFn: (params: { key: string; content: string; syncToDynamo?: boolean }) =>
      api.saveDataExplorerS3(params.key, params.content, params.syncToDynamo),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['data-explorer-s3'] })
      queryClient.invalidateQueries({ queryKey: ['data-explorer-feedback'] })
      setEditModal(null)
    },
  })

  const deleteS3Mutation = useMutation({
    mutationFn: (key: string) => api.deleteDataExplorerS3(key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['data-explorer-s3'] })
      setDeleteConfirm(null)
    },
  })

  const saveFeedbackMutation = useMutation({
    mutationFn: (params: { feedbackId: string; data: Partial<FeedbackItem>; syncToS3?: boolean }) =>
      api.saveDataExplorerFeedback(params.feedbackId, params.data, params.syncToS3),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['data-explorer-feedback'] })
      queryClient.invalidateQueries({ queryKey: ['data-explorer-s3'] })
      setEditModal(null)
    },
  })

  const deleteFeedbackMutation = useMutation({
    mutationFn: (feedbackId: string) => api.deleteDataExplorerFeedback(feedbackId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['data-explorer-feedback'] })
      setDeleteConfirm(null)
    },
  })

  const navigateToFolder = (folder: string) => setS3Path([...s3Path, folder])
  const navigateUp = () => setS3Path(s3Path.slice(0, -1))
  const navigateToBreadcrumb = (index: number) => setS3Path(index < 0 ? [] : s3Path.slice(0, index + 1))

  const openS3Editor = async (fullKey: string, mode: 'view' | 'edit') => {
    const preview = await api.getDataExplorerS3Preview(fullKey)
    setEditModal({ 
      isOpen: true, 
      mode, 
      type: 's3', 
      data: preview.content, 
      key: fullKey,
      contentType: preview.contentType,
      isPresignedUrl: preview.isPresignedUrl,
    })
  }

  const openS3Creator = () => {
    const prefix = s3Path.length > 0 ? s3Path.join('/') + '/' : 'raw/'
    setEditModal({
      isOpen: true, mode: 'create', type: 's3',
      data: { source_platform: 'manual', text: '', created_at: new Date().toISOString() },
      key: `${prefix}${Date.now()}.json`,
    })
  }

  const downloadS3File = async (fullKey: string, filename: string) => {
    try {
      const preview = await api.getDataExplorerS3Preview(fullKey)
      let blob: Blob
      let downloadFilename = filename

      if (preview.isPresignedUrl && typeof preview.content === 'string') {
        // For binary files, fetch from presigned URL
        const response = await fetch(preview.content)
        blob = await response.blob()
      } else {
        // For text/JSON files, create blob from content
        const content = typeof preview.content === 'string' 
          ? preview.content 
          : JSON.stringify(preview.content, null, 2)
        blob = new Blob([content], { type: preview.contentType || 'application/json' })
      }

      // Trigger download
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = downloadFilename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Download failed:', error)
    }
  }

  const openFeedbackEditor = (item: FeedbackItem, mode: 'view' | 'edit') => {
    const itemWithS3 = item as FeedbackItem & { s3_raw_uri?: string }
    setEditModal({
      isOpen: true, mode, type: 'dynamodb', data: item,
      feedbackId: item.feedback_id, s3RawUri: itemWithS3.s3_raw_uri,
    })
  }

  if (!isConfigured) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center text-gray-500">
          <Database size={48} className="mx-auto mb-4 opacity-50" />
          <p>Configure API endpoint in Settings to explore data</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Data Explorer</h1>
          <p className="text-sm text-gray-500">Browse, edit, and sync raw S3 data and processed DynamoDB records</p>
        </div>
        {viewMode === 's3-raw' && (
          <button onClick={openS3Creator} className="btn btn-primary flex items-center justify-center gap-2 text-sm">
            <Plus size={18} /> New File
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 sm:gap-4 border-b border-gray-200 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
        {[
          { id: 's3-raw', icon: HardDrive, label: 'S3 Raw Data', shortLabel: 'S3' },
          { id: 'dynamodb-processed', icon: Database, label: 'Processed Feedback', shortLabel: 'Feedback' },
          { id: 'dynamodb-categories', icon: FolderOpen, label: 'Categories', shortLabel: 'Categories' },
        ].map(({ id, icon: Icon, label, shortLabel }) => (
          <button
            key={id}
            onClick={() => setViewMode(id as ViewMode)}
            className={clsx(
              'flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-3 border-b-2 font-medium text-xs sm:text-sm transition-colors whitespace-nowrap',
              viewMode === id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            <Icon size={16} /> <span className="hidden sm:inline">{label}</span><span className="sm:hidden">{shortLabel}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
        {viewMode !== 's3-raw' && (
          <>
            <div className="flex items-center gap-2">
              <Filter size={16} className="text-gray-400 flex-shrink-0" />
              <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="input py-1.5 text-sm flex-1 sm:min-w-[150px]">
                <option value="">All Sources</option>
                {sourcesData?.sources && Object.keys(sourcesData.sources).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {viewMode === 'dynamodb-processed' && (
              <div className="flex items-center gap-2 flex-1">
                <Search size={16} className="text-gray-400 flex-shrink-0" />
                <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search..." className="input py-1.5 text-sm flex-1 sm:max-w-md" />
              </div>
            )}
          </>
        )}
        <button onClick={() => viewMode === 's3-raw' ? refetchS3() : viewMode === 'dynamodb-processed' ? refetchFeedback() : refetchCategories()} className="btn btn-secondary py-1.5 text-sm flex items-center justify-center gap-1 sm:ml-auto">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="card p-0 overflow-hidden">
        {viewMode === 's3-raw' && (
          <S3Browser path={s3Path} data={s3Data} loading={s3Loading}
            onNavigateToFolder={navigateToFolder} onNavigateUp={navigateUp} onNavigateToBreadcrumb={navigateToBreadcrumb}
            onView={(k) => openS3Editor(k, 'view')} onEdit={(k) => openS3Editor(k, 'edit')}
            onDelete={(k) => setDeleteConfirm({ type: 's3', key: k })} onDownload={downloadS3File} />
        )}
        {viewMode === 'dynamodb-processed' && (
          <ProcessedFeedbackView data={feedbackData} loading={feedbackLoading} searchQuery={searchQuery}
            onView={(i) => openFeedbackEditor(i, 'view')} onEdit={(i) => openFeedbackEditor(i, 'edit')}
            onDelete={(i) => setDeleteConfirm({ type: 'dynamodb', key: i.feedback_id, id: i.feedback_id })} />
        )}
        {viewMode === 'dynamodb-categories' && <CategoriesView data={categoriesData} loading={categoriesLoading} />}
      </div>

      {editModal && (
        <EditModal {...editModal} onClose={() => setEditModal(null)}
          onSave={(content, sync) => {
            if (editModal.type === 's3') {
              saveS3Mutation.mutate({ key: editModal.key!, content: typeof content === 'string' ? content : JSON.stringify(content, null, 2), syncToDynamo: sync })
            } else {
              saveFeedbackMutation.mutate({ feedbackId: editModal.feedbackId!, data: content as Partial<FeedbackItem>, syncToS3: sync })
            }
          }}
          saving={saveS3Mutation.isPending || saveFeedbackMutation.isPending}
          error={saveS3Mutation.error?.message || saveFeedbackMutation.error?.message} />
      )}

      <ConfirmModal isOpen={!!deleteConfirm} title={`Delete ${deleteConfirm?.type === 's3' ? 'S3 File' : 'Feedback'}`}
        message="Are you sure? This cannot be undone." confirmLabel="Delete" variant="danger"
        onConfirm={() => deleteConfirm?.type === 's3' ? deleteS3Mutation.mutate(deleteConfirm.key) : deleteFeedbackMutation.mutate(deleteConfirm!.id!)}
        onCancel={() => setDeleteConfirm(null)} isLoading={deleteS3Mutation.isPending || deleteFeedbackMutation.isPending} />
    </div>
  )
}

function S3Browser({ path, data, loading, onNavigateToFolder, onNavigateUp, onNavigateToBreadcrumb, onView, onEdit, onDelete, onDownload }: {
  path: string[]; data: { objects: S3Object[]; bucket: string; prefix: string } | undefined; loading: boolean
  onNavigateToFolder: (folder: string) => void; onNavigateUp: () => void; onNavigateToBreadcrumb: (index: number) => void
  onView: (key: string) => void; onEdit: (key: string) => void; onDelete: (key: string) => void; onDownload: (key: string, filename: string) => void
}) {
  if (loading) return <div className="p-8 text-center"><Loader2 className="mx-auto animate-spin text-gray-400" size={32} /></div>
  const objects = data?.objects || []
  const bucket = data?.bucket || 'voc-raw-data'

  const getFileIcon = (filename: string) => {
    const ext = filename.split('.').pop()?.toLowerCase() || ''
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
      return <Image size={20} className="text-purple-500" />
    }
    if (ext === 'pdf') {
      return <FileText size={20} className="text-red-500" />
    }
    return <FileJson size={20} className="text-blue-500" />
  }

  const isEditableFile = (filename: string) => {
    const ext = filename.split('.').pop()?.toLowerCase() || ''
    return !['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'pdf'].includes(ext)
  }

  return (
    <div>
      <div className="bg-gray-50 px-4 py-3 border-b flex items-center gap-2 text-sm">
        <HardDrive size={16} className="text-gray-400" />
        <button onClick={() => onNavigateToBreadcrumb(-1)} className="text-blue-600 hover:underline">{bucket}</button>
        {path.map((segment, i) => (
          <span key={i} className="flex items-center gap-2">
            <ChevronRight size={14} className="text-gray-400" />
            <button onClick={() => onNavigateToBreadcrumb(i)} className={clsx(i === path.length - 1 ? 'text-gray-900 font-medium' : 'text-blue-600 hover:underline')}>{segment}</button>
          </span>
        ))}
      </div>
      {path.length > 0 && <div className="px-4 py-2 border-b"><button onClick={onNavigateUp} className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"><ArrowLeft size={16} /> Back</button></div>}
      {objects.length === 0 ? (
        <div className="p-8 text-center text-gray-500"><FolderOpen size={48} className="mx-auto mb-4 opacity-50" /><p>No files found</p></div>
      ) : (
        <div className="divide-y">
          {objects.map((obj) => (
            <div key={obj.key} className="flex items-center justify-between px-4 py-3 hover:bg-gray-50">
              <div className="flex items-center gap-3 cursor-pointer flex-1" onClick={() => obj.isFolder ? onNavigateToFolder(obj.key) : onView(obj.fullKey || obj.key)}>
                {obj.isFolder ? <FolderOpen size={20} className="text-yellow-500" /> : getFileIcon(obj.key)}
                <div>
                  <p className="font-medium text-sm">{obj.key}</p>
                  {!obj.isFolder && <p className="text-xs text-gray-500">{formatFileSize(obj.size)} • {format(new Date(obj.lastModified), 'MMM d, yyyy HH:mm')}</p>}
                </div>
              </div>
              {!obj.isFolder && (
                <div className="flex items-center gap-1">
                  <button onClick={() => onView(obj.fullKey || obj.key)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded" title="View"><Eye size={16} /></button>
                  <button onClick={() => onDownload(obj.fullKey || obj.key, obj.key)} className="p-1.5 text-gray-400 hover:text-purple-600 hover:bg-purple-50 rounded" title="Download"><Download size={16} /></button>
                  {isEditableFile(obj.key) && (
                    <button onClick={() => onEdit(obj.fullKey || obj.key)} className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded" title="Edit"><Pencil size={16} /></button>
                  )}
                  <button onClick={() => onDelete(obj.fullKey || obj.key)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete"><Trash2 size={16} /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ProcessedFeedbackView({ data, loading, searchQuery, onView, onEdit, onDelete }: {
  data: { count: number; items: FeedbackItem[] } | undefined; loading: boolean; searchQuery: string
  onView: (item: FeedbackItem) => void; onEdit: (item: FeedbackItem) => void; onDelete: (item: FeedbackItem) => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  if (loading) return <div className="p-8 text-center"><Loader2 className="mx-auto animate-spin text-gray-400" size={32} /></div>
  const items = data?.items || []
  const filtered = searchQuery ? items.filter(i => i.original_text?.toLowerCase().includes(searchQuery.toLowerCase()) || i.category?.toLowerCase().includes(searchQuery.toLowerCase())) : items
  if (filtered.length === 0) return <div className="p-8 text-center text-gray-500"><Database size={48} className="mx-auto mb-4 opacity-50" /><p>No feedback found</p></div>

  return (
    <div>
      <div className="bg-gray-50 px-4 py-3 border-b text-sm text-gray-600">Showing {filtered.length} of {data?.count || 0} records</div>
      <div className="divide-y max-h-[600px] overflow-y-auto">
        {filtered.map((item) => (
          <div key={item.feedback_id} className="px-4 py-3">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setExpandedId(expandedId === item.feedback_id ? null : item.feedback_id)}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium px-2 py-0.5 bg-gray-100 rounded">{item.source_platform}</span>
                  <span className="text-xs text-gray-500">{format(new Date(item.source_created_at), 'MMM d, yyyy HH:mm')}</span>
                  <SentimentBadge sentiment={item.sentiment_label} score={item.sentiment_score} />
                </div>
                <p className="text-sm text-gray-900 line-clamp-2">{item.original_text}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-gray-500">Category: {item.category}</span>
                  {item.urgency === 'high' && <span className="text-xs px-1.5 py-0.5 bg-red-100 text-red-700 rounded">Urgent</span>}
                </div>
              </div>
              <div className="flex items-center gap-1 ml-2">
                <button onClick={() => onView(item)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded" title="View"><Eye size={16} /></button>
                <button onClick={() => onEdit(item)} className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded" title="Edit"><Pencil size={16} /></button>
                <button onClick={() => onDelete(item)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete"><Trash2 size={16} /></button>
                <button onClick={() => setExpandedId(expandedId === item.feedback_id ? null : item.feedback_id)} className="p-1 text-gray-400">
                  {expandedId === item.feedback_id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
              </div>
            </div>
            {expandedId === item.feedback_id && <div className="mt-3 p-3 bg-gray-50 rounded-lg text-xs"><pre className="whitespace-pre-wrap overflow-x-auto">{JSON.stringify(item, null, 2)}</pre></div>}
          </div>
        ))}
      </div>
    </div>
  )
}

function CategoriesView({ data, loading }: { data: { period_days: number; categories: Record<string, number> } | undefined; loading: boolean }) {
  if (loading) return <div className="p-8 text-center"><Loader2 className="mx-auto animate-spin text-gray-400" size={32} /></div>
  const categories = data?.categories || {}
  const sorted = Object.entries(categories).sort((a, b) => b[1] - a[1])
  const total = Object.values(categories).reduce((s, c) => s + c, 0)
  if (sorted.length === 0) return <div className="p-8 text-center text-gray-500"><FolderOpen size={48} className="mx-auto mb-4 opacity-50" /><p>No categories</p></div>

  return (
    <div>
      <div className="bg-gray-50 px-4 py-3 border-b text-sm text-gray-600">{sorted.length} categories • {total} items • Last {data?.period_days} days</div>
      <div className="divide-y">
        {sorted.map(([cat, count]) => {
          const pct = total > 0 ? (count / total) * 100 : 0
          return (
            <div key={cat} className="px-4 py-3">
              <div className="flex items-center justify-between mb-1"><span className="font-medium text-sm">{cat}</span><span className="text-sm text-gray-600">{count} ({pct.toFixed(1)}%)</span></div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} /></div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function EditModal({ mode, type, data, key, feedbackId, s3RawUri, contentType, isPresignedUrl, onClose, onSave, saving, error }: EditModalState & {
  onClose: () => void; onSave: (content: unknown, syncOption?: boolean) => void; saving: boolean; error?: string
}) {
  const [content, setContent] = useState(() => typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [jsonError, setJsonError] = useState<string | null>(null)

  // Determine file type from isPresignedUrl flag, contentType, or key extension
  const getFileType = (): 'image' | 'pdf' | 'text' => {
    if (isPresignedUrl) {
      const ct = contentType?.toLowerCase() || ''
      const ext = key?.split('.').pop()?.toLowerCase() || ''
      
      if (ct.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
        return 'image'
      }
      if (ct === 'application/pdf' || ext === 'pdf') {
        return 'pdf'
      }
    }
    return 'text'
  }
  
  const fileType = getFileType()
  const isMediaFile = fileType === 'image' || fileType === 'pdf'

  const validateJson = (text: string) => { try { JSON.parse(text); setJsonError(null); return true } catch (e) { setJsonError((e as Error).message); return false } }
  const handleSave = () => { if (!validateJson(content)) return; try { onSave(JSON.parse(content), syncEnabled) } catch { onSave(content, syncEnabled) } }
  const isReadOnly = mode === 'view' || isMediaFile
  const title = mode === 'create' ? 'Create New File' : mode === 'edit' ? `Edit ${type === 's3' ? 'S3 File' : 'Feedback'}` : `View ${type === 's3' ? 'S3 File' : 'Feedback'}`

  // For images and PDFs, data should be a URL or base64
  const renderMediaContent = () => {
    const mediaUrl = typeof data === 'string' ? data : ''
    
    if (fileType === 'image') {
      return (
        <div className="flex items-center justify-center p-4 bg-gray-100 rounded-lg min-h-[300px] sm:min-h-[400px]">
          <img 
            src={mediaUrl} 
            alt={key || 'Preview'} 
            className="max-w-full max-h-[50vh] sm:max-h-[60vh] object-contain rounded shadow-lg"
            onError={(e) => {
              const target = e.target as HTMLImageElement
              target.style.display = 'none'
              target.parentElement!.innerHTML = '<p class="text-gray-500">Failed to load image</p>'
            }}
          />
        </div>
      )
    }
    
    if (fileType === 'pdf') {
      return (
        <div className="w-full h-[50vh] sm:h-[60vh] bg-gray-100 rounded-lg overflow-hidden">
          <iframe 
            src={mediaUrl} 
            className="w-full h-full border-0"
            title={key || 'PDF Preview'}
          />
        </div>
      )
    }
    
    return null
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[95vh] sm:max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-3 sm:px-4 py-3 border-b">
          <div className="flex items-center gap-2 min-w-0">
            {type === 's3' ? <FileJson size={18} className="text-blue-500 flex-shrink-0" /> : <Database size={18} className="text-green-500 flex-shrink-0" />}
            <span className="font-medium text-sm sm:text-base truncate">{title}</span>
            {fileType !== 'text' && (
              <span className="text-xs px-2 py-0.5 bg-gray-100 rounded text-gray-600 uppercase flex-shrink-0">{fileType}</span>
            )}
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded flex-shrink-0"><X size={20} /></button>
        </div>
        <div className="px-3 sm:px-4 py-2 bg-gray-50 border-b text-xs text-gray-600 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 overflow-x-auto">
          {type === 's3' && key && <span className="truncate">Key: <code className="bg-gray-200 px-1 rounded">{key}</code></span>}
          {type === 'dynamodb' && feedbackId && <span className="truncate">ID: <code className="bg-gray-200 px-1 rounded">{feedbackId}</code></span>}
          {s3RawUri && <span className="flex items-center gap-1 truncate"><Link2 size={12} className="flex-shrink-0" /> S3: <code className="bg-gray-200 px-1 rounded text-xs truncate">{s3RawUri}</code></span>}
          {contentType && <span className="truncate">Type: <code className="bg-gray-200 px-1 rounded">{contentType}</code></span>}
        </div>
        <div className="flex-1 overflow-auto p-3 sm:p-4">
          {isMediaFile ? (
            renderMediaContent()
          ) : (
            <>
              <textarea value={content} onChange={(e) => { setContent(e.target.value); validateJson(e.target.value) }} readOnly={isReadOnly}
                className={clsx('w-full h-full min-h-[300px] sm:min-h-[400px] font-mono text-xs p-3 sm:p-4 rounded-lg border resize-none', isReadOnly ? 'bg-gray-50 text-gray-700' : 'bg-white', jsonError ? 'border-red-300' : 'border-gray-200')} spellCheck={false} />
              {jsonError && <p className="text-xs text-red-600 mt-2 flex items-center gap-1"><AlertTriangle size={14} /> Invalid JSON: {jsonError}</p>}
            </>
          )}
        </div>
        <div className="px-3 sm:px-4 py-3 border-t bg-gray-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            {!isReadOnly && !isMediaFile && (
              <label className="flex items-center gap-2 text-xs sm:text-sm">
                <input type="checkbox" checked={syncEnabled} onChange={(e) => setSyncEnabled(e.target.checked)} className="rounded border-gray-300 text-blue-600" />
                <span className="text-gray-700">{type === 's3' ? 'Also update DynamoDB' : 'Also update S3'}</span>
              </label>
            )}
          </div>
          <div className="flex items-center gap-2 justify-end">
            {error && <span className="text-xs text-red-600">{error}</span>}
            <button onClick={onClose} className="btn btn-secondary text-sm">{isMediaFile ? 'Close' : 'Cancel'}</button>
            {!isReadOnly && !isMediaFile && <button onClick={handleSave} disabled={saving || !!jsonError} className="btn btn-primary flex items-center gap-2 text-sm">{saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}{mode === 'create' ? 'Create' : 'Save'}</button>}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Formats a byte count into a human-readable file size string.
 *
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted size string (e.g., "1.5 KB", "2.3 MB")
 *
 * @example
 * formatFileSize(1024) // "1.0 KB"
 * formatFileSize(1048576) // "1.0 MB"
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
