/**
 * @fileoverview Data Explorer page (admin-only): browse S3 raw data and DynamoDB
 * processed feedback. Nothing is ever deleted and existing raw objects are never
 * overwritten — the explorer reads, creates new raw files, and edits processed records.
 * @module pages/DataExplorer
 */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, HardDrive, Plus, RefreshCw, Search, Filter } from 'lucide-react'
import type { FeedbackItem } from '../../api/types'
import clsx from 'clsx'
import S3Browser from './S3Browser'
import ProcessedFeedbackView from './ProcessedFeedbackView'
import EditModal, { type EditModalState } from './EditModal'
import { useDataExplorerQueries } from './useDataExplorerQueries'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { useDataExplorerMutations } from './useDataExplorerMutations'
import { openS3Editor, openS3Creator, downloadS3File } from './s3Handlers'

type ViewMode = 's3-raw' | 'dynamodb-processed'

const VIEW_TABS = [
  { id: 's3-raw', icon: HardDrive, labelKey: 'tabs.s3RawData', shortLabelKey: 'tabs.s3Short' },
  { id: 'dynamodb-processed', icon: Database, labelKey: 'tabs.processedFeedback', shortLabelKey: 'tabs.feedbackShort' },
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

  const queries = useDataExplorerQueries(viewMode, selectedBucket, s3Path, sourceFilter)
  const mutations = useDataExplorerMutations(selectedBucket, {
    onS3SaveSuccess: () => setEditModal(null),
    onFeedbackSaveSuccess: () => setEditModal(null),
  })

  const handleBucketChange = useCallback((bucketId: string) => {
    setSelectedBucket(bucketId)
    setS3Path([])
  }, [])

  const handleOpenS3Editor = useCallback((fullKey: string, mode: 'view' | 'edit') => {
    // Same contract as download: a failed preview fetch must not surface as an
    // unhandled rejection; the modal simply does not open.
    openS3Editor(fullKey, mode, selectedBucket, setEditModal).catch(console.error)
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
      mutations.saveFeedbackMutation.mutate({ feedbackId: editModal.feedbackId, data: feedbackData })
    }
  }, [editModal, mutations.saveS3Mutation, mutations.saveFeedbackMutation])

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
      />

      {editModal && (
        <EditModal
          {...editModalProps(editModal)}
          onClose={() => setEditModal(null)}
          onSave={handleSave}
          saving={mutations.saveS3Mutation.isPending || mutations.saveFeedbackMutation.isPending}
          error={mutations.saveS3Mutation.error?.message ?? mutations.saveFeedbackMutation.error?.message}
        />
      )}
    </div>
  )
}

/**
 * EditModalState carries the S3 object key as `key`, which React reserves: a
 * `{...state}` spread would hand React a list key instead of a prop (and warn).
 * Pass it through under its own name instead.
 */
function editModalProps({ key: s3Key, ...rest }: EditModalState) {
  return { ...rest, s3Key }
}

function NotConfiguredView() {
  const { t } = useTranslation('dataExplorer')
  return (
    <div className="card flex flex-col items-center justify-center text-center py-12 gap-2">
      <Database size={20} className="text-muted" />
      <p className="text-sm text-muted">{t('notConfigured')}</p>
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
}

function ContentPanel({
  viewMode, queries, s3Path, searchQuery, onS3PathChange, onOpenS3Editor, onDownloadS3File, onOpenFeedbackEditor
}: ContentPanelProps) {
  // A failed listing is not an empty folder / "no feedback": say so, with a retry.
  const failure = viewMode === 's3-raw' ? queries.s3Failure : queries.feedbackFailure
  if (failure.loadFailed) {
    return <LoadFailed onRetry={failure.retry} retrying={failure.retrying} />
  }
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
        />
      )}
    </div>
  )
}

interface HeaderProps {
  readonly viewMode: ViewMode
  readonly onCreateFile: () => void
}

function Header({ viewMode, onCreateFile }: HeaderProps) {
  const { t } = useTranslation('dataExplorer')
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('title')}</h1>
        <p className="text-sm text-muted mt-1">{t('description')}</p>
      </div>
      {viewMode === 's3-raw' && (
        <button onClick={onCreateFile} className="btn btn-primary justify-center">
          <Plus size={16} /> {t('newFile')}
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
  const { t } = useTranslation('dataExplorer')
  return (
    <div className="tabs-rail -mx-4 px-4 sm:mx-0 sm:px-0">
      <div className="tabs-track" role="tablist" aria-label={t('tabs.label')}>
        {VIEW_TABS.map(({ id, icon: Icon, labelKey, shortLabelKey }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={viewMode === id}
            onClick={() => onViewModeChange(id)}
            className={clsx('tab', viewMode === id && 'tab-active')}
          >
            <Icon size={14} />
            <span className="hidden sm:inline">{t(labelKey)}</span>
            <span className="sm:hidden">{t(shortLabelKey)}</span>
          </button>
        ))}
      </div>
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
  const { t } = useTranslation('dataExplorer')
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
      {viewMode === 's3-raw' && buckets && buckets.length > 1 && (
        <BucketSelector selectedBucket={selectedBucket} buckets={buckets} onBucketChange={onBucketChange} />
      )}
      {viewMode !== 's3-raw' && (
        <>
          <SourceSelector sourceFilter={sourceFilter} sources={sources} onSourceFilterChange={onSourceFilterChange} />
          <SearchInput searchQuery={searchQuery} onSearchChange={onSearchChange} />
        </>
      )}
      <button onClick={onRefresh} className="btn btn-secondary justify-center sm:ml-auto">
        <RefreshCw size={16} /> {t('refresh')}
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
  const { t } = useTranslation('dataExplorer')
  return (
    <div className="flex items-center gap-2">
      <HardDrive size={16} className="text-muted flex-shrink-0" aria-hidden="true" />
      <select
        aria-label={t('filters.bucket')}
        value={selectedBucket}
        onChange={(e) => onBucketChange(e.target.value)}
        className="select flex-1 sm:min-w-[200px]"
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
  const { t } = useTranslation('dataExplorer')
  return (
    <div className="flex items-center gap-2">
      <Filter size={16} className="text-muted flex-shrink-0" aria-hidden="true" />
      <select
        aria-label={t('filters.source')}
        value={sourceFilter}
        onChange={(e) => onSourceFilterChange(e.target.value)}
        className="select flex-1 sm:min-w-[160px]"
      >
        <option value="">{t('filters.allSources')}</option>
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
  const { t } = useTranslation('dataExplorer')
  return (
    <div className="flex items-center gap-2 flex-1">
      <Search size={16} className="text-muted flex-shrink-0" aria-hidden="true" />
      <input
        type="search"
        aria-label={t('filters.search')}
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={t('filters.searchPlaceholder')}
        className="input flex-1 sm:max-w-md"
      />
    </div>
  )
}
