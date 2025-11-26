import { useState } from 'react'
import { Filter, X, ChevronDown, Tag } from 'lucide-react'
import type { ChatFilters as ChatFiltersType } from '../store/chatStore'
import clsx from 'clsx'

interface ChatFiltersProps {
  filters: ChatFiltersType
  onChange: (filters: ChatFiltersType) => void
  availableTags?: string[]
}

const sources = [
  { value: '', label: 'All Sources' },
  { value: 'trustpilot', label: 'Trustpilot' },
  { value: 'google_reviews', label: 'Google Reviews' },
  { value: 'twitter', label: 'Twitter/X' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'reddit', label: 'Reddit' },
  { value: 'tavily', label: 'Tavily' },
  { value: 'web_scrape', label: 'Web Scraper' },
  { value: 'appstore_apple', label: 'Apple App Store' },
  { value: 'appstore_google', label: 'Google Play' },
  { value: 'appstore_huawei', label: 'Huawei AppGallery' },
]

const categories = [
  { value: '', label: 'All Categories' },
  { value: 'delivery', label: 'Delivery' },
  { value: 'customer_support', label: 'Customer Support' },
  { value: 'product_quality', label: 'Product Quality' },
  { value: 'pricing', label: 'Pricing' },
  { value: 'website', label: 'Website' },
  { value: 'app', label: 'App' },
  { value: 'billing', label: 'Billing' },
  { value: 'returns', label: 'Returns' },
  { value: 'communication', label: 'Communication' },
  { value: 'other', label: 'Other' },
]

const sentiments = [
  { value: '', label: 'All Sentiments' },
  { value: 'positive', label: '😊 Positive' },
  { value: 'neutral', label: '😐 Neutral' },
  { value: 'negative', label: '😞 Negative' },
  { value: 'mixed', label: '🤔 Mixed' },
]

export default function ChatFilters({ filters, onChange, availableTags = [] }: ChatFiltersProps) {
  const [showTagInput, setShowTagInput] = useState(false)
  const [tagInput, setTagInput] = useState('')

  const hasActiveFilters = filters.source || filters.category || filters.sentiment || (filters.tags && filters.tags.length > 0)

  const updateFilter = (key: keyof ChatFiltersType, value: string | string[] | undefined) => {
    onChange({ ...filters, [key]: value || undefined })
  }

  const addTag = (tag: string) => {
    const currentTags = filters.tags || []
    if (!currentTags.includes(tag)) {
      updateFilter('tags', [...currentTags, tag])
    }
    setTagInput('')
    setShowTagInput(false)
  }

  const removeTag = (tag: string) => {
    const currentTags = filters.tags || []
    updateFilter('tags', currentTags.filter(t => t !== tag))
  }

  const clearFilters = () => {
    onChange({})
  }

  const filteredSuggestions = availableTags
    .filter(tag => tag.toLowerCase().includes(tagInput.toLowerCase()))
    .filter(tag => !(filters.tags || []).includes(tag))
    .slice(0, 5)

  return (
    <div className="bg-gray-50 rounded-lg p-3 mb-3">
      <div className="flex items-center gap-2 mb-2">
        <Filter size={14} className="text-gray-400" />
        <span className="text-xs font-medium text-gray-600">Filter Context</span>
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="ml-auto text-xs text-red-500 hover:text-red-600 flex items-center gap-1"
          >
            <X size={12} />
            Clear
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Source Filter */}
        <div className="relative">
          <select
            value={filters.source || ''}
            onChange={(e) => updateFilter('source', e.target.value)}
            className={clsx(
              'text-xs px-2 py-1.5 pr-6 rounded border appearance-none cursor-pointer',
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
              'text-xs px-2 py-1.5 pr-6 rounded border appearance-none cursor-pointer',
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
              'text-xs px-2 py-1.5 pr-6 rounded border appearance-none cursor-pointer',
              filters.sentiment ? 'bg-green-50 border-green-200 text-green-700' : 'bg-white border-gray-200'
            )}
          >
            {sentiments.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <ChevronDown size={12} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        </div>

        {/* Tags */}
        <div className="flex items-center gap-1 flex-wrap">
          {(filters.tags || []).map(tag => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-orange-50 border border-orange-200 text-orange-700 rounded"
            >
              <Tag size={10} />
              {tag}
              <button onClick={() => removeTag(tag)} className="hover:text-orange-900">
                <X size={10} />
              </button>
            </span>
          ))}
          
          {showTagInput ? (
            <div className="relative">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && tagInput.trim()) {
                    addTag(tagInput.trim())
                  }
                  if (e.key === 'Escape') {
                    setShowTagInput(false)
                    setTagInput('')
                  }
                }}
                placeholder="Add tag..."
                className="text-xs px-2 py-1 border border-gray-200 rounded w-24"
                autoFocus
              />
              {filteredSuggestions.length > 0 && tagInput && (
                <div className="absolute top-full left-0 mt-1 bg-white border rounded shadow-lg z-10 w-40">
                  {filteredSuggestions.map(tag => (
                    <button
                      key={tag}
                      onClick={() => addTag(tag)}
                      className="block w-full text-left text-xs px-2 py-1.5 hover:bg-gray-100"
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={() => setShowTagInput(true)}
              className="text-xs px-2 py-1 border border-dashed border-gray-300 rounded text-gray-500 hover:border-gray-400 hover:text-gray-600"
            >
              + Tag
            </button>
          )}
        </div>
      </div>

      {/* Active Filters Summary */}
      {hasActiveFilters && (
        <div className="mt-2 text-xs text-gray-500">
          Focusing on: {[
            filters.source && sources.find(s => s.value === filters.source)?.label,
            filters.category && categories.find(c => c.value === filters.category)?.label,
            filters.sentiment && sentiments.find(s => s.value === filters.sentiment)?.label.replace(/^[^\s]+\s/, ''),
            ...(filters.tags || []),
          ].filter(Boolean).join(', ')}
        </div>
      )}
    </div>
  )
}
