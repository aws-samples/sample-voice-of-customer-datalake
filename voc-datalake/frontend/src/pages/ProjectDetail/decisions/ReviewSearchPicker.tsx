/**
 * @fileoverview Pick the reviews a decision cites by searching for them
 * (`GET /feedback/search`), instead of typing feedback ids. A picked review is a
 * removable chip named by its title or first words; the ids still travel in the
 * draft's `feedbackIds` text, and that text stays editable under "Advanced" (for
 * pasting ids from elsewhere).
 *
 * The search is debounced (one request per typed query, 300 ms) and waits for the
 * route's minimum of 2 characters.
 *
 * @module pages/ProjectDetail/decisions/ReviewSearchPicker
 */
import { useQuery } from '@tanstack/react-query'
import { Loader2, Plus, Search, X } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../../api/client'
import { useDebouncedValue } from '../../../hooks/useDebouncedValue'
import { parseIds } from './decisionDraft'
import type { FeedbackItem } from '../../../api/types'

/** The route refuses shorter (trimmed) terms with a 400 (`SEARCH_QUERY_MIN_LENGTH`). */
const SEARCH_MIN_CHARS = 2
const RESULTS_SHOWN = 8
/** A year back: decisions cite recent evidence, and the route walks fewer days. */
const SEARCH_DAYS = 365
const LABEL_WORDS = 10

/** A review as its link reads: its title, else its first words. */
function reviewLabel(item: Pick<FeedbackItem, 'title' | 'original_text'>): string {
  const title = item.title?.trim() ?? ''
  if (title !== '') return title
  const words = item.original_text.split(/\s+/).filter(Boolean)
  return words.length > LABEL_WORDS ? `${words.slice(0, LABEL_WORDS).join(' ')}…` : words.join(' ')
}

function useReviewSearch(query: string) {
  const q = useDebouncedValue(query.trim())
  const enabled = q.length >= SEARCH_MIN_CHARS
  const result = useQuery({
    queryKey: ['decision-review-search', q],
    queryFn: () => api.searchFeedback({ q, days: SEARCH_DAYS, limit: RESULTS_SHOWN }),
    enabled,
    staleTime: 60_000,
  })
  return { enabled, q, ...result }
}

function Results({ search, picked, onPick }: Readonly<{
  search: ReturnType<typeof useReviewSearch>; picked: readonly string[]; onPick: (item: FeedbackItem) => void
}>) {
  const { t } = useTranslation('decisions')
  if (!search.enabled) return null
  if (search.isLoading) return <p className="text-xs text-muted flex items-center gap-1"><Loader2 size={12} className="animate-spin" aria-hidden /> {t('picker.searching')}</p>
  if (search.isError) return <p role="alert" className="text-xs text-danger">{t('picker.failed')}</p>
  const items = (search.data?.items ?? []).filter((item) => !picked.includes(item.feedback_id))
  if (items.length === 0) return <p className="text-xs text-muted">{t('picker.noMatch', { q: search.q })}</p>
  return (
    <ul className="border border-border rounded-md divide-y divide-border max-h-56 overflow-y-auto" aria-label={t('picker.results')}>
      {items.map((item) => (
        <li key={item.feedback_id}>
          <button type="button" onClick={() => onPick(item)} className="w-full text-left px-3 py-2 text-sm hover:bg-bg-hover focus-ring flex items-start gap-2">
            <Plus size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 break-words">{reviewLabel(item)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export default function ReviewSearchPicker({ value, onChange }: Readonly<{
  /** The draft's ids text (space separated). */
  value: string
  onChange: (value: string) => void
}>) {
  const { t } = useTranslation('decisions')
  const searchId = useId()
  const advancedId = useId()
  const [query, setQuery] = useState('')
  // Names of the reviews picked here; an id that came in another way reads as "Linked review".
  const [labels, setLabels] = useState<Readonly<Record<string, string>>>({})
  const search = useReviewSearch(query)
  const ids = parseIds(value)
  const pick = (item: FeedbackItem) => {
    setLabels((current) => ({ ...current, [item.feedback_id]: reviewLabel(item) }))
    onChange([...ids, item.feedback_id].join(' '))
  }
  const remove = (id: string) => onChange(ids.filter((other) => other !== id).join(' '))
  return (
    <div className="space-y-2">
      <label htmlFor={searchId} className="text-sm font-medium text-text">{t('picker.label')}</label>
      {ids.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('picker.picked')}>
          {ids.map((id, index) => {
            const label = labels[id] ?? t('picker.linked', { n: index + 1 })
            return (
              <li key={id} className="badge badge-muted inline-flex items-center gap-1 max-w-full">
                <span className="truncate">{label}</span>
                <button type="button" onClick={() => remove(id)} className="icon-btn p-0.5" aria-label={t('picker.remove', { label })}>
                  <X size={12} aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
        <input id={searchId} type="search" className="input pl-8" value={query} placeholder={t('picker.placeholder')}
          onChange={(e) => setQuery(e.target.value)} />
      </div>
      <Results search={search} picked={ids} onPick={pick} />
      <details className="text-xs">
        <summary className="cursor-pointer text-muted">{t('picker.advanced')}</summary>
        <div className="mt-2 space-y-1">
          <label htmlFor={advancedId} className="text-sm font-medium text-text">{t('fields.feedbackIds')}</label>
          <input id={advancedId} className="input font-mono" value={value} aria-describedby={`${advancedId}-hint`} onChange={(e) => onChange(e.target.value)} />
          <p id={`${advancedId}-hint`} className="text-xs text-muted">{t('fields.feedbackIdsHint')}</p>
        </div>
      </details>
    </div>
  )
}
