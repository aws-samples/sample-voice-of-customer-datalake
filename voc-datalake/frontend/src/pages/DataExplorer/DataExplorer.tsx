/**
 * @fileoverview Data Explorer page with full CRUD for S3 and DynamoDB data.
 * @module pages/DataExplorer
 */

import { useState, useCallback } from 'react'
import { Database, HardDrive, FolderOpen, Plus, RefreshCw, Search, Filter } from 'lucide-react'
import type { FeedbackItem } from '../../api/client'
import ConfirmModal from '../../components/ConfirmModal'
import clsx from 'clsx'
import S3Browser from './S3Browser'
import ProcessedFeedbackView from './ProcessedFeedbackView'
import CategoriesView from './CategoriesView'
import EditModal, { type EditModalState } from './EditModal'
import { useDataExplorerQueries } from './useDataExplorerQueries'
import { useDataExplorerMutations } from './useDataExplorerMutations'
import { openS3Editor, openS3Creator, downloadS3File } from './s3Handlers'

type ViewMode = 's3-raw' | 'dynamodb-processed' | 'dynamodb-categories'

interface DeleteConfirmState {
  type: 's3' | 'dynamodb'
  key: string
  id?: string
}

const VIEW_TABS = [
  { id: 's3-raw', icon: HardDrive, label: 'S3 Raw Data', shortLabel: 'S3' },
  { id: 'dynamodb-processed', icon: Database, label: 'Processed Feedback', shortLabel: 'Feedback' },
  { id: 'dynamodb-categories', icon: FolderOpen, label: 'Categories', shortLabel: 'Categories' },
] as const

// Extended feedback item type that may include s3_raw_uri from API
interface FeedbackItemWithS3 extends FeedbackItem {
  s3_raw_uri?: string
}

function isFeedbackItemWithS3(item: FeedbackItem): item is FeedbackItemWithS3 {
  return 's3_raw_uri' in item
}

function isPartialFeedbackItem(content: unknown): content is Partial<FeedbackItem> {
  return typeof content === 'object' && content !== null
}

export default function DataExplorer() {
  const [viewMode, setViewMode] = useState<ViewMode>('s3-raw')
  const [selectedBucket, setSelectedBucket] = useState<string>('raw-data')
  const [s3Path, setS3Path] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<string>('')
  const [editModal, setEditModal] = useState<EditModalState | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null)

  const queries = useDataExplorerQueries(viewMode, selectedBucket, s3Path, sourceFilter)
  const mutations = useDataExplorerMutations(selectedBucket, {
    onS3SaveSuccess: () => setEditModal(null),
    onS3DeleteSuccess: () => setDeleteConfirm(null),
    onFeedbackSaveSuccess: () => setEditModal(null),
    onFeedbackDeleteSuccess: () => setDeleteConfirm(null),
  })

  const handleBucketChange = useCallback((bucketId: string) => {
    setSelectedBucket(bucketId)
    setS3Path([])
  }, [])

  const handleOpenS3Editor = useCallback((fullKey: string, mode: 'view' | 'edit') => {
    openS3Editor(fullKey, mode, selectedBucket, setEditModal)
  }, [selectedBucket])

  const handleOpenS3Creator = useCallback(() => {
    openS3Creator(s3Path, setEditModal)
  }, [s3Path])

  const handleDownloadS3File = useCallback((fullKey: string, filename: string) => {
    downloadS3File(fullKey, filename, selectedBucket).catch(console.error)
  }, [selectedBucket])

  const handleOpenFeedbackEditor = useCallback((item: FeedbackItem, mode: 'view' | 'edit') => {
    const s3RawUri = isFeedbackItemWithS3(item) ? item.s3_raw_uri : undefined
    setEditModal({
      isOpen: true, mode, type: 'dynamodb', data: item,
      feedbackId: item.feedback_id, s3RawUri,
    })
  }, [])

  const handleSave = useCallback((content: unknown, sync?: boolean) => {
    if (!editModal) return
    if (editModal.type === 's3' && editModal.key) {
      const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
      mutations.saveS3Mutation.mutate({ key: editModal.key, content: contentStr, syncToDynamo: sync })
    } else if (editModal.feedbackId) {
      const feedbackData = isPartialFeedbackItem(content) ? content : {}
      mutations.saveFeedbackMutation.mutate({ feedbackId: editModal.feedbackId, data: feedbackData, syncToS3: sync })
    }
  }, [editModal, mutations.saveS3Mutation, mutations.saveFeedbackMutation])

  const handleDelete = useCallback(() => {
    if (!deleteConfirm) return
    if (deleteConfirm.type === 's3') {
      mutations.deleteS3Mutation.mutate(deleteConfirm.key)
    } else if (deleteConfirm.id) {
      mutations.deleteFeedbackMutation.mutate(deleteConfirm.id)
    }
  }, [deleteConfirm, mutations.deleteS3Mutation, mutations.deleteFeedbackMutation])

  if (!queries.isConfigured) {
    return <NotConfiguredView />
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <Header viewMode={viewMode} onCreateFile={handleOpenS3Creator} />
      <ViewTabs viewMode={viewMode} onViewModeChange={setViewMode} />
      <FilterBar
        viewMode={viewMode}
        selectedBucket={selectedBucket}
        buckets={queries.bucketsData?.buckets}
        sourceFilter={sourceFilter}
        sources={queries.sourcesData?.sources}
        searchQuery={searchQuery}
        onBucketChange={handleBucketChange}
        onSourceFilterChange={setSourceFilter}
        onSearchChange={setSearchQuery}
        onRefresh={queries.refetch}
      />

      <ContentPanel
        viewMode={viewMode}
        queries={queries}
        s3Path={s3Path}
        searchQuery={searchQuery}
        onS3PathChange={setS3Path}
        onOpenS3Editor={handleOpenS3Editor}
        onDownloadS3File={handleDownloadS3File}
        onOpenFeedbackEditor={handleOpenFeedbackEditor}
        onDeleteConfirm={setDeleteConfirm}
      />

      {editModal && (
        <EditModal
          {...editModal}
          onClose={() => setEditModal(null)}
          onSave={handleSave}
          saving={mutations.saveS3Mutation.isPending || mutations.saveFeedbackMutation.isPending}
          error={mutations.saveS3Mutation.error?.message ?? mutations.saveFeedbackMutation.error?.message}
        />
      )}

      <ConfirmModal
        isOpen={!!deleteConfirm}
        title={`Delete ${deleteConfirm?.type === 's3' ? 'S3 File' : 'Feedback'}`}
        message="Are you sure? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleteConfirm(null)}
        isLoading={mutations.deleteS3Mutation.isPending || mutations.deleteFeedbackMutation.isPending}
      />
    </div>
  )
}

function NotConfiguredView() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center text-gray-500">
        <Database size={48} className="mx-auto mb-4 opacity-50" />
        <p>Configure API endpoint in Settings to explore data</p>
      </div>
    </div>
  )
}

interface ContentPanelProps {
  readonly viewMode: ViewMode
  readonly queries: ReturnType<typeof useDataExplorerQueries>
  readonly s3Path: string[]
  readonly searchQuery: string
  readonly onS3PathChange: (path: string[]) => void
  readonly onOpenS3Editor: (key: string, mode: 'view' | 'edit') => void
  readonly onDownloadS3File: (key: string, filename: string) => void
  readonly onOpenFeedbackEditor: (item: FeedbackItem, mode: 'view' | 'edit') => void
  readonly onDeleteConfirm: (state: DeleteConfirmState) => void
}

function ContentPanel({
  viewMode, queries, s3Path, searchQuery, onS3PathChange, onOpenS3Editor, onDownloadS3File, onOpenFeedbackEditor, onDeleteConfirm
}: ContentPanelProps) {
  return (
    <div className="card p-0 overflow-hidden">
      {viewMode === 's3-raw' && (
        <S3Browser
          path={s3Path}
          data={queries.s3Data}
          loading={queries.s3Loading}
          onNavigateToFolder={(folder) => onS3PathChange([...s3Path, folder])}
          onNavigateUp={() => onS3PathChange(s3Path.slice(0, -1))}
          onNavigateToBreadcrumb={(i) => onS3PathChange(i < 0 ? [] : s3Path.slice(0, i + 1))}
          onView={(k) => onOpenS3Editor(k, 'view')}
          onEdit={(k) => onOpenS3Editor(k, 'edit')}
          onDelete={(k) => onDeleteConfirm({ type: 's3', key: k })}
          onDownload={onDownloadS3File}
        />
      )}
      {viewMode === 'dynamodb-processed' && (
        <ProcessedFeedbackView
          data={queries.feedbackData}
          loading={queries.feedbackLoading}
          searchQuery={searchQuery}
          onView={(i) => onOpenFeedbackEditor(i, 'view')}
          onEdit={(i) => onOpenFeedbackEditor(i, 'edit')}
          onDelete={(i) => onDeleteConfirm({ type: 'dynamodb', key: i.feedback_id, id: i.feedback_id })}
        />
      )}
      {viewMode === 'dynamodb-categories' && (
        <CategoriesView data={queries.categoriesData} loading={queries.categoriesLoading} />
      )}
    </div>
  )
}

interface HeaderProps {
  readonly viewMode: ViewMode
  readonly onCreateFile: () => void
}

function Header({ viewMode, onCreateFile }: HeaderProps) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Data Explorer</h1>
        <p className="text-sm text-gray-500">Browse, edit, and sync raw S3 data and processed DynamoDB records</p>
      </div>
      {viewMode === 's3-raw' && (
        <button onClick={onCreateFile} className="btn btn-primary flex items-center justify-center gap-2 text-sm">
          <Plus size={18} /> New File
        </button>
      )}
    </div>
  )
}

interface ViewTabsProps {
  readonly viewMode: ViewMode
  readonly onViewModeChange: (mode: ViewMode) => void
}

function ViewTabs({ viewMode, onViewModeChange }: ViewTabsProps) {
  return (
    <div className="flex items-center gap-2 sm:gap-4 border-b border-gray-200 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      {VIEW_TABS.map(({ id, icon: Icon, label, shortLabel }) => (
        <button
          key={id}
          onClick={() => onViewModeChange(id)}
          className={clsx(
            'flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-3 border-b-2 font-medium text-xs sm:text-sm transition-colors whitespace-nowrap',
            viewMode === id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
          )}
        >
          <Icon size={16} />
          <span className="hidden sm:inline">{label}</span>
          <span className="sm:hidden">{shortLabel}</span>
        </button>
      ))}
    </div>
  )
}

interface FilterBarProps {
  readonly viewMode: ViewMode
  readonly selectedBucket: string
  readonly buckets?: Array<{ id: string; label: string }>
  readonly sourceFilter: string
  readonly sources?: Record<string, number>
  readonly searchQuery: string
  readonly onBucketChange: (bucket: string) => void
  readonly onSourceFilterChange: (source: string) => void
  readonly onSearchChange: (query: string) => void
  readonly onRefresh: () => void
}

function FilterBar({
  viewMode, selectedBucket, buckets, sourceFilter, sources, searchQuery,
  onBucketChange, onSourceFilterChange, onSearchChange, onRefresh
}: FilterBarProps) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
      {viewMode === 's3-raw' && buckets && buckets.length > 1 && (
        <BucketSelector selectedBucket={selectedBucket} buckets={buckets} onBucketChange={onBucketChange} />
      )}
      {viewMode !== 's3-raw' && (
        <>
          <SourceSelector sourceFilter={sourceFilter} sources={sources} onSourceFilterChange={onSourceFilterChange} />
          {viewMode === 'dynamodb-processed' && (
            <SearchInput searchQuery={searchQuery} onSearchChange={onSearchChange} />
          )}
        </>
      )}
      <button onClick={onRefresh} className="btn btn-secondary py-1.5 text-sm flex items-center justify-center gap-1 sm:ml-auto">
        <RefreshCw size={14} /> Refresh
      </button>
    </div>
  )
}

interface BucketSelectorProps {
  readonly selectedBucket: string
  readonly buckets: Array<{ id: string; label: string }>
  readonly onBucketChange: (bucket: string) => void
}

function BucketSelector({ selectedBucket, buckets, onBucketChange }: BucketSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <HardDrive size={16} className="text-gray-400 flex-shrink-0" />
      <select
        value={selectedBucket}
        onChange={(e) => onBucketChange(e.target.value)}
        className="input py-1.5 text-sm flex-1 sm:min-w-[200px]"
      >
        {buckets.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
      </select>
    </div>
  )
}

interface SourceSelectorProps {
  readonly sourceFilter: string
  readonly sources?: Record<string, number>
  readonly onSourceFilterChange: (source: string) => void
}

function SourceSelector({ sourceFilter, sources, onSourceFilterChange }: SourceSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <Filter size={16} className="text-gray-400 flex-shrink-0" />
      <select
        value={sourceFilter}
        onChange={(e) => onSourceFilterChange(e.target.value)}
        className="input py-1.5 text-sm flex-1 sm:min-w-[150px]"
      >
        <option value="">All Sources</option>
        {sources && Object.keys(sources).map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  )
}

interface SearchInputProps {
  readonly searchQuery: string
  readonly onSearchChange: (query: string) => void
}

function SearchInput({ searchQuery, onSearchChange }: SearchInputProps) {
  return (
    <div className="flex items-center gap-2 flex-1">
      <Search size={16} className="text-gray-400 flex-shrink-0" />
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search..."
        className="input py-1.5 text-sm flex-1 sm:max-w-md"
      />
    </div>
  )
}
