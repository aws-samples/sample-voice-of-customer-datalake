/**
 * @fileoverview The comment view's toolbar: how many open threads, filter by author (teammates,
 * personas, one persona, reviewers), show resolved, and "Comment on the whole document".
 *
 * @module components/DocumentComments/CommentFiltersBar
 */
import { MessageSquarePlus } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { authorKindsPresent, personaOptions } from './commentFilters'
import { AUTHOR_KINDS } from '../../api/documentReviewSchema'
import type { AuthorFilter, CommentFilter } from './commentFilters'
import type { CommentThread } from '../../api/documentReviewSchema'

interface CommentFiltersBarProps {
  readonly threads: readonly CommentThread[]
  readonly filter: CommentFilter
  readonly onFilterChange: (filter: CommentFilter) => void
  /** Absent = the reader cannot comment here. */
  readonly onCommentWhole?: () => void
}

const isAuthorFilter = (value: string): value is AuthorFilter =>
  value === 'all' || AUTHOR_KINDS.some((kind) => kind === value)

export default function CommentFiltersBar({ threads, filter, onFilterChange, onCommentWhole }: CommentFiltersBarProps) {
  const { t } = useTranslation('components')
  const authorId = useId()
  const personaId = useId()
  const open = threads.filter((thread) => thread.status === 'open').length
  const kinds = authorKindsPresent(threads)
  const personas = personaOptions(threads)
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium text-text-strong">{t('documentComments.openCount', { count: open })}</span>
      {kinds.length > 1 ? (
        <>
          <label htmlFor={authorId} className="sr-only">{t('documentComments.filterAuthor')}</label>
          <select id={authorId} className="input w-auto py-1 text-sm" value={filter.author}
            onChange={(event) => {
              const value = event.target.value
              if (isAuthorFilter(value)) onFilterChange({ ...filter, author: value, personaId: '' })
            }}>
            <option value="all">{t('documentComments.filterAll')}</option>
            {kinds.map((kind) => <option key={kind} value={kind}>{t(`documentComments.authorKinds.${kind}`)}</option>)}
          </select>
        </>
      ) : null}
      {filter.author === 'persona' && personas.length > 1 ? (
        <>
          <label htmlFor={personaId} className="sr-only">{t('documentComments.filterPersona')}</label>
          <select id={personaId} className="input w-auto py-1 text-sm" value={filter.personaId}
            onChange={(event) => onFilterChange({ ...filter, personaId: event.target.value })}>
            <option value="">{t('documentComments.everyPersona')}</option>
            {personas.map((persona) => <option key={persona.personaId} value={persona.personaId}>{persona.name}</option>)}
          </select>
        </>
      ) : null}
      <label className="inline-flex items-center gap-1.5 text-muted">
        <input type="checkbox" checked={filter.showResolved}
          onChange={(event) => onFilterChange({ ...filter, showResolved: event.target.checked })} />
        {t('documentComments.showResolved')}
      </label>
      {onCommentWhole === undefined ? null : (
        <button type="button" className="btn btn-secondary btn-sm ml-auto" onClick={onCommentWhole}>
          <MessageSquarePlus size={14} aria-hidden />{t('documentComments.commentWhole')}
        </button>
      )}
    </div>
  )
}
