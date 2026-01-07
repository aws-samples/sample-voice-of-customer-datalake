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

interface ChatFiltersProps {
  filters: ChatFiltersType
  onChange: (filters: ChatFiltersType) => void
}

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

export default function ChatFilters({ filters, onChange }: ChatFiltersProps) {
  const [sources, setSources] = useState(defaultSources)
  const [categories, setCategories] = useState(defaultCategories)
  const { config } = useConfigStore()

  // Fetch actual sources and categories from API
  useEffect(() => {
    if (!config.apiEndpoint) return
    
    // Fetch sources
    api.getSources(30).then(data => {
      if (data.sources && Object.keys(data.sources).length > 0) {
        const dynamicSources = [
          { value: '', label: 'All Sources' },
          ...Object.keys(data.sources)
            .sort((a, b) => data.sources[b] - data.sources[a])
            .map(source => ({
              value: source,
              label: source.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
            }))
        ]
        setSources(dynamicSources)
      }
    }).catch(() => {})
    
    // Fetch categories
    api.getCategories(30).then(data => {
      if (data.categories && Object.keys(data.categories).length > 0) {
        const dynamicCategories = [
          { value: '', label: 'All Categories' },
          ...Object.keys(data.categories)
            .sort((a, b) => data.categories[b] - data.categories[a])
            .map(cat => ({
              value: cat,
              label: cat.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
            }))
        ]
        setCategories(dynamicCategories)
      }
    }).catch(() => {})
  }, [config.apiEndpoint])

  const hasActiveFilters = filters.source || filters.category || filters.sentiment

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
        {/* Source Filter */}
        <div className="relative">
          <select
            value={filters.source || ''}
            onChange={(e) => updateFilter('source', e.target.value)}
            className={clsx(
              'w-full sm:w-auto text-xs px-2 py-2 sm:py-1.5 pr-6 rounded border appearance-none cursor-pointer',
              filters.source ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-gray-200'
            )}
          >
            {sources.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <ChevronDown size={12} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        </div>

        {/* Category Filter */}
        <div className="relative">
          <select
            value={filters.category || ''}
            onChange={(e) => updateFilter('category', e.target.value)}
            className={clsx(
              'w-full sm:w-auto text-xs px-2 py-2 sm:py-1.5 pr-6 rounded border appearance-none cursor-pointer',
              filters.category ? 'bg-purple-50 border-purple-200 text-purple-700' : 'bg-white border-gray-200'
            )}
          >
            {categories.map(c => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          <ChevronDown size={12} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        </div>

        {/* Sentiment Filter */}
        <div className="relative">
          <select
            value={filters.sentiment || ''}
            onChange={(e) => updateFilter('sentiment', e.target.value)}
            className={clsx(
              'w-full sm:w-auto text-xs px-2 py-2 sm:py-1.5 pr-6 rounded border appearance-none cursor-pointer',
              filters.sentiment ? 'bg-green-50 border-green-200 text-green-700' : 'bg-white border-gray-200'
            )}
          >
            {sentiments.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <ChevronDown size={12} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        </div>
      </div>

      {/* Active Filters Summary */}
      {hasActiveFilters && (
        <div className="mt-2 text-xs text-gray-500 truncate">
          Focusing on: {[
            filters.source && sources.find(s => s.value === filters.source)?.label,
            filters.category && categories.find(c => c.value === filters.category)?.label,
            filters.sentiment && sentiments.find(s => s.value === filters.sentiment)?.label.replace(/^[^\s]+\s/, ''),
          ].filter(Boolean).join(', ')}
        </div>
      )}
    </div>
  )
}
