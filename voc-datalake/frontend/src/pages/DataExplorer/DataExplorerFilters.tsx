/**
 * @fileoverview Filter sub-components for Data Explorer.
 * @module pages/DataExplorer/DataExplorerFilters
 */

import {
  Filter, HardDrive, Search,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface BucketSelectorProps {
  readonly selectedBucket: string
  readonly buckets: Array<{
    id: string;
    label: string
  }>
  readonly onBucketChange: (bucket: string) => void
}

export function BucketSelector({
  selectedBucket, buckets, onBucketChange,
}: BucketSelectorProps) {
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

export function SourceSelector({
  sourceFilter, sources, onSourceFilterChange,
}: SourceSelectorProps) {
  const { t } = useTranslation('dataExplorer')
  return (
    <div className="flex items-center gap-2">
      <Filter size={16} className="text-gray-400 flex-shrink-0" />
      <select
        value={sourceFilter}
        onChange={(e) => onSourceFilterChange(e.target.value)}
        className="input py-1.5 text-sm flex-1 sm:min-w-[150px]"
      >
        <option value="">{t('filters.allSources')}</option>
        {sources ? Object.keys(sources).map((s) => <option key={s} value={s}>{s}</option>) : null}
      </select>
    </div>
  )
}

interface SearchInputProps {
  readonly searchQuery: string
  readonly onSearchChange: (query: string) => void
}

export function SearchInput({
  searchQuery, onSearchChange,
}: SearchInputProps) {
  const { t } = useTranslation('dataExplorer')
  return (
    <div className="flex items-center gap-2 flex-1">
      <Search size={16} className="text-gray-400 flex-shrink-0" />
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={t('filters.searchPlaceholder')}
        className="input py-1.5 text-sm flex-1 sm:max-w-md"
      />
    </div>
  )
}
