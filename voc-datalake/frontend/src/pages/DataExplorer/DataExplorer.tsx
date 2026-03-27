/**
 * @fileoverview Data Explorer page with full CRUD for S3 and DynamoDB data.
 * @module pages/DataExplorer
 */

import clsx from 'clsx'
import {
  Database, FolderOpen, HardDrive, Plus, RefreshCw,
} from 'lucide-react'
import {
  useState, useCallback, useMemo,
} from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal'
import CategoriesView from './CategoriesView'
import {
  BucketSelector, SourceSelector, SearchInput,
} from './DataExplorerFilters'
import EditModal, { type EditModalState } from './EditModal'
import ProcessedFeedbackView from './ProcessedFeedbackView'
import S3Browser, { type S3Object } from './S3Browser'
import {
  openS3Editor, openS3Creator, downloadS3File,
} from './s3Handlers'
import { useDataExplorerMutations } from './useDataExplorerMutations'
import { useDataExplorerQueries } from './useDataExplorerQueries'
import type { FeedbackItem } from '../../api/types'

type ViewMode = 's3-raw' | 'dynamodb-processed' | 'dynamodb-categories'

interface DeleteConfirmState {
  type: 's3' | 'dynamodb'
  key: string
  id?: string
}

interface FeedbackItemWithS3 extends FeedbackItem { s3_raw_uri?: string }

function isFeedbackItemWithS3(item: FeedbackItem): item is FeedbackItemWithS3 {
  return 's3_raw_uri' in item
}
function isPartialFeedbackItem(content: unknown): content is Partial<FeedbackItem> {
  return typeof content === 'object' && content !== null
}

function executeSave(
  editModal: EditModalState,
  content: unknown,
  sync: boolean | undefined,
  mutations: ReturnType<typeof useDataExplorerMutations>,
) {
  if (editModal.type === 's3' && editModal.key != null && editModal.key !== '') {
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
    mutations.saveS3Mutation.mutate({
      key: editModal.key,
      content: contentStr,
      syncToDynamo: sync,
    })
  } else if (editModal.feedbackId != null && editModal.feedbackId !== '') {
    const feedbackData = isPartialFeedbackItem(content) ? content : {}
    mutations.saveFeedbackMutation.mutate({
      feedbackId: editModal.feedbackId,
      data: feedbackData,
      syncToS3: sync,
    })
  }
}

function getDeleteTitle(type: 's3' | 'dynamodb' | undefined, t: (key: string) => string): string {
  return type === 's3' ? t('deleteConfirm.deleteS3File') : t('deleteConfirm.deleteFeedback')
}

export default function DataExplorer() {
  const { t } = useTranslation('dataExplorer')
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
    void openS3Editor(fullKey, mode, selectedBucket, setEditModal)
  }, [selectedBucket])

  const handleOpenS3Creator = useCallback(() => {
    openS3Creator(s3Path, setEditModal)
  }, [s3Path])
  const handleDownloadS3File = useCallback((fullKey: string, filename: string) => {
    void downloadS3File(fullKey, filename, selectedBucket)
  }, [selectedBucket])
  const handleOpenFeedbackEditor = useCallback((item: FeedbackItem, mode: 'view' | 'edit') => {
    const s3RawUri = isFeedbackItemWithS3(item) ? item.s3_raw_uri : undefined
    setEditModal({
      isOpen: true,
      mode,
      type: 'dynamodb',
      data: item,
      feedbackId: item.feedback_id,
      s3RawUri,
    })
  }, [])
  const handleSave = useCallback((content: unknown, sync?: boolean) => {
    if (!editModal) return
    executeSave(editModal, content, sync, mutations)
  }, [editModal, mutations])

  const handleDelete = useCallback(() => {
    if (!deleteConfirm) return
    if (deleteConfirm.type === 's3') {
      mutations.deleteS3Mutation.mutate(deleteConfirm.key)
    } else if (deleteConfirm.id != null && deleteConfirm.id !== '') {
      mutations.deleteFeedbackMutation.mutate(deleteConfirm.id)
    }
  }, [deleteConfirm, mutations.deleteS3Mutation, mutations.deleteFeedbackMutation])

  const s3BrowserData = useMemo(() => {
    if (!queries.s3Data) return
    const bucketLabel = queries.s3Data.bucketLabel
    return {
      objects: queries.s3Data.objects,
      bucket: (bucketLabel != null && bucketLabel !== '') ? bucketLabel : queries.s3Data.bucket,
      prefix: queries.s3Data.prefix,
    }
  }, [queries.s3Data])

  const buckets = useMemo(() =>
    queries.bucketsData?.buckets.map((b: {
      id: string;
      name: string;
      label: string
    }) => ({
      id: b.id,
      label: b.label === '' ? b.name : b.label,
    })),
  [queries.bucketsData])

  if (!queries.isConfigured) {
    return <NotConfiguredView />
  }

  const deleteTitle = getDeleteTitle(deleteConfirm?.type, t)

  return (
    <div className="space-y-4 sm:space-y-6">
      <Header viewMode={viewMode} onCreateFile={handleOpenS3Creator} />
      <ViewTabs viewMode={viewMode} onViewModeChange={setViewMode} />
      <FilterBar
        viewMode={viewMode}
        selectedBucket={selectedBucket}
        buckets={buckets}
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
        s3BrowserData={s3BrowserData}
        s3Path={s3Path}
        searchQuery={searchQuery}
        onS3PathChange={setS3Path}
        onOpenS3Editor={handleOpenS3Editor}
        onDownloadS3File={handleDownloadS3File}
        onOpenFeedbackEditor={handleOpenFeedbackEditor}
        onDeleteConfirm={setDeleteConfirm}
      />

      {editModal ? <EditModal
        {...editModal}
        onClose={() => setEditModal(null)}
        onSave={handleSave}
        saving={mutations.saveS3Mutation.isPending || mutations.saveFeedbackMutation.isPending}
        error={mutations.saveS3Mutation.error?.message ?? mutations.saveFeedbackMutation.error?.message}
      /> : null}

      <ConfirmModal
        isOpen={!!deleteConfirm}
        title={deleteTitle}
        message={t('deleteConfirm.message')}
        confirmLabel={t('s3Browser.delete')}
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleteConfirm(null)}
        isLoading={mutations.deleteS3Mutation.isPending || mutations.deleteFeedbackMutation.isPending}
      />
    </div>
  )
}

function NotConfiguredView() {
  const { t } = useTranslation('dataExplorer')
  return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center text-gray-500">
        <Database size={48} className="mx-auto mb-4 opacity-50" />
        <p>{t('notConfigured')}</p>
      </div>
    </div>
  )
}

interface ContentPanelProps {
  readonly viewMode: ViewMode
  readonly queries: ReturnType<typeof useDataExplorerQueries>
  readonly s3BrowserData: {
    objects: S3Object[];
    bucket: string;
    prefix: string
  } | undefined
  readonly s3Path: string[]
  readonly searchQuery: string
  readonly onS3PathChange: (path: string[]) => void
  readonly onOpenS3Editor: (key: string, mode: 'view' | 'edit') => void
  readonly onDownloadS3File: (key: string, filename: string) => void
  readonly onOpenFeedbackEditor: (item: FeedbackItem, mode: 'view' | 'edit') => void
  readonly onDeleteConfirm: (state: DeleteConfirmState) => void
}

function ContentPanel({
  viewMode, queries, s3BrowserData, s3Path, searchQuery, onS3PathChange, onOpenS3Editor, onDownloadS3File, onOpenFeedbackEditor, onDeleteConfirm,
}: ContentPanelProps) {
  return (
    <div className="card p-0 overflow-hidden">
      {viewMode === 's3-raw' && (
        <S3Browser
          path={s3Path}
          data={s3BrowserData}
          loading={queries.s3Loading}
          error={queries.s3Error}
          onNavigateToFolder={(folder) => onS3PathChange([...s3Path, folder])}
          onNavigateUp={() => onS3PathChange(s3Path.slice(0, -1))}
          onNavigateToBreadcrumb={(i) => onS3PathChange(i < 0 ? [] : s3Path.slice(0, i + 1))}
          onView={(k) => onOpenS3Editor(k, 'view')}
          onEdit={(k) => onOpenS3Editor(k, 'edit')}
          onDelete={(k) => onDeleteConfirm({
            type: 's3',
            key: k,
          })}
          onDownload={onDownloadS3File}
        />
      )}
      {viewMode === 'dynamodb-processed' && (
        <ProcessedFeedbackView
          data={queries.feedbackData}
          loading={queries.feedbackLoading}
          error={queries.feedbackError}
          searchQuery={searchQuery}
          onView={(i) => onOpenFeedbackEditor(i, 'view')}
          onEdit={(i) => onOpenFeedbackEditor(i, 'edit')}
          onDelete={(i) => onDeleteConfirm({
            type: 'dynamodb',
            key: i.feedback_id,
            id: i.feedback_id,
          })}
        />
      )}
      {viewMode === 'dynamodb-categories' && (
        <CategoriesView data={queries.categoriesData} loading={queries.categoriesLoading} error={queries.categoriesError} />
      )}
    </div>
  )
}

interface HeaderProps {
  readonly viewMode: ViewMode
  readonly onCreateFile: () => void
}

function Header({
  viewMode, onCreateFile,
}: HeaderProps) {
  const { t } = useTranslation('dataExplorer')
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500">{t('description')}</p>
      </div>
      {viewMode === 's3-raw' && (
        <button onClick={onCreateFile} className="btn btn-primary flex items-center justify-center gap-2 text-sm">
          <Plus size={18} /> {t('newFile')}
        </button>
      )}
    </div>
  )
}

interface ViewTabsProps {
  readonly viewMode: ViewMode
  readonly onViewModeChange: (mode: ViewMode) => void
}

function ViewTabs({
  viewMode, onViewModeChange,
}: ViewTabsProps) {
  const { t } = useTranslation('dataExplorer')

  const viewTabs = [
    {
      id: 's3-raw' as const,
      icon: HardDrive,
      label: t('tabs.s3RawData'),
      shortLabel: t('tabs.s3Short'),
    },
    {
      id: 'dynamodb-processed' as const,
      icon: Database,
      label: t('tabs.processedFeedback'),
      shortLabel: t('tabs.feedbackShort'),
    },
    {
      id: 'dynamodb-categories' as const,
      icon: FolderOpen,
      label: t('tabs.categories'),
      shortLabel: t('tabs.categoriesShort'),
    },
  ]

  return (
    <div className="flex items-center gap-2 sm:gap-4 border-b border-gray-200 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      {viewTabs.map(({
        id, icon, label, shortLabel,
      }) => {
        const TabIcon = icon
        return (
          <button
            key={id}
            onClick={() => onViewModeChange(id)}
            className={clsx(
              'flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-3 border-b-2 font-medium text-xs sm:text-sm transition-colors whitespace-nowrap',
              viewMode === id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700',
            )}
          >
            <TabIcon size={16} />
            <span className="hidden sm:inline">{label}</span>
            <span className="sm:hidden">{shortLabel}</span>
          </button>
        )
      })}
    </div>
  )
}

interface FilterBarProps {
  readonly viewMode: ViewMode
  readonly selectedBucket: string
  readonly buckets?: Array<{
    id: string;
    label: string
  }>
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
  onBucketChange, onSourceFilterChange, onSearchChange, onRefresh,
}: FilterBarProps) {
  const { t } = useTranslation('dataExplorer')
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
      {viewMode === 's3-raw' && buckets && buckets.length > 1 ? <BucketSelector selectedBucket={selectedBucket} buckets={buckets} onBucketChange={onBucketChange} /> : null}
      {viewMode !== 's3-raw' && (
        <>
          <SourceSelector sourceFilter={sourceFilter} sources={sources} onSourceFilterChange={onSourceFilterChange} />
          {viewMode === 'dynamodb-processed' && (
            <SearchInput searchQuery={searchQuery} onSearchChange={onSearchChange} />
          )}
        </>
      )}
      <button onClick={onRefresh} className="btn btn-secondary py-1.5 text-sm flex items-center justify-center gap-1 sm:ml-auto">
        <RefreshCw size={14} /> {t('refresh')}
      </button>
    </div>
  )
}
