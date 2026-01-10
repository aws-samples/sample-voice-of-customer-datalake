/**
 * @fileoverview Chat filter controls component.
 *
 * Provides filter dropdowns for scoping chat queries:
 * - Source filter (Trustpilot, Twitter, etc.)
 * - Category filter
 * - Sentiment filter
 *
 * @module components/ChatFilters
 */

import { useState, useEffect } from 'react'
import { Filter, X, ChevronDown } from 'lucide-react'
import type { ChatFilters as ChatFiltersType } from '../../store/chatStore'
import { api } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import clsx from 'clsx'

// Default options as fallback
const defaultSources = [
  { value: '', label: 'All Sources' },
  { value: 'trustpilot', label: 'Trustpilot' },
  { value: 'google_reviews', label: 'Google Reviews' },
  { value: 'twitter', label: 'Twitter/X' },
]

const defaultCategories = [
  { value: '', label: 'All Categories' },
  { value: 'delivery', label: 'Delivery' },
  { value: 'customer_support', label: 'Customer Support' },
  { value: 'product_quality', label: 'Product Quality' },
  { value: 'pricing', label: 'Pricing' },
  { value: 'other', label: 'Other' },
]

const sentiments = [
  { value: '', label: 'All Sentiments' },
  { value: 'positive', label: '😊 Positive' },
  { value: 'neutral', label: '😐 Neutral' },
  { value: 'negative', label: '😞 Negative' },
  { value: 'mixed', label: '🤔 Mixed' },
]

interface ChatFiltersProps {
  readonly filters: ChatFiltersType
  readonly onChange: (filters: ChatFiltersType) => void
}

type FilterOption = { value: string; label: string }

function formatLabel(str: string): string {
  return str.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function buildSourceOptions(data: { sources: Record<string, number> }): FilterOption[] {
  return [
    { value: '', label: 'All Sources' },
    ...Object.keys(data.sources)
      .sort((a, b) => data.sources[b] - data.sources[a])
      .map(source => ({ value: source, label: formatLabel(source) }))
  ]
}

function buildCategoryOptions(data: { categories: Record<string, number> }): FilterOption[] {
  return [
    { value: '', label: 'All Categories' },
    ...Object.keys(data.categories)
      .sort((a, b) => data.categories[b] - data.categories[a])
      .map(cat => ({ value: cat, label: formatLabel(cat) }))
  ]
}

function getActiveFilterSummary(
  filters: ChatFiltersType,
  sources: FilterOption[],
  categories: FilterOption[]
): string {
  const parts = [
    filters.source && sources.find(s => s.value === filters.source)?.label,
    filters.category && categories.find(c => c.value === filters.category)?.label,
    filters.sentiment && sentiments.find(s => s.value === filters.sentiment)?.label.replace(/^[^\s]+\s/, ''),
  ].filter(Boolean)
  return parts.join(', ')
}

// Filter select component
function FilterSelect({
  value,
  options,
  onChange,
  activeColorClass,
}: Readonly<{
  value: string
  options: FilterOption[]
  onChange: (value: string) => void
  activeColorClass: string
}>) {
  const isActive = Boolean(value)
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(
          'w-full sm:w-auto text-xs px-2 py-2 sm:py-1.5 pr-6 rounded border appearance-none cursor-pointer',
          isActive ? activeColorClass : 'bg-white border-gray-200'
        )}
      >
        {options.map(s => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>
      <ChevronDown size={12} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
    </div>
  )
}

export default function ChatFilters({ filters, onChange }: ChatFiltersProps) {
  const [sources, setSources] = useState(defaultSources)
  const [categories, setCategories] = useState(defaultCategories)
  const { config } = useConfigStore()

  useEffect(() => {
    if (!config.apiEndpoint) return

    api.getSources(30).then(data => {
      if (data.sources && Object.keys(data.sources).length > 0) {
        setSources(buildSourceOptions(data))
      }
    }).catch(() => { /* ignore */ })

    api.getCategories(30).then(data => {
      if (data.categories && Object.keys(data.categories).length > 0) {
        setCategories(buildCategoryOptions(data))
      }
    }).catch(() => { /* ignore */ })
  }, [config.apiEndpoint])

  const hasActiveFilters = Boolean(filters.source || filters.category || filters.sentiment)

  const updateFilter = (key: keyof ChatFiltersType, value: string | undefined) => {
    onChange({ ...filters, [key]: value || undefined })
  }

  const clearFilters = () => {
    onChange({})
  }

  return (
    <div className="bg-gray-50 rounded-lg p-2.5 sm:p-3 mb-3">
      <div className="flex items-center gap-2 mb-2">
        <Filter size={14} className="text-gray-400 flex-shrink-0" />
        <span className="text-xs font-medium text-gray-600 truncate">Filter Context (max 30 reviews)</span>
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="ml-auto text-xs text-red-500 hover:text-red-600 flex items-center gap-1 flex-shrink-0"
          >
            <X size={12} />
            <span className="hidden sm:inline">Clear</span>
          </button>
        )}
      </div>

      <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2">
        <FilterSelect
          value={filters.source ?? ''}
          options={sources}
          onChange={(v) => updateFilter('source', v)}
          activeColorClass="bg-blue-50 border-blue-200 text-blue-700"
        />
        <FilterSelect
          value={filters.category ?? ''}
          options={categories}
          onChange={(v) => updateFilter('category', v)}
          activeColorClass="bg-purple-50 border-purple-200 text-purple-700"
        />
        <FilterSelect
          value={filters.sentiment ?? ''}
          options={sentiments}
          onChange={(v) => updateFilter('sentiment', v)}
          activeColorClass="bg-green-50 border-green-200 text-green-700"
        />
      </div>

      {hasActiveFilters && (
        <div className="mt-2 text-xs text-gray-500 truncate">
          Focusing on: {getActiveFilterSummary(filters, sources, categories)}
        </div>
      )}
    </div>
  )
}
