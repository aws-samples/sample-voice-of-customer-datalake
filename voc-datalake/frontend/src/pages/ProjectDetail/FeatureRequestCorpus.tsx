/**
 * @fileoverview The feedback-board requests behind a generated persona or document, beside its
 * reviews: "and N feature requests" (or "Written from N feature requests" when it read no review),
 * a "Show requests" toggle in the corpus line, and — beside the line, never inside its paragraph —
 * the requests as links that open each on its board.
 *
 * @module pages/ProjectDetail/FeatureRequestCorpus
 */
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { featureRequestHref } from './featureRequestCitations'

/** The count text, inline in the corpus line. */
export function FeatureRequestCount({ count, withReviews }: Readonly<{ count: number; withReviews: boolean }>) {
  const { t } = useTranslation('projectDetail')
  if (count === 0) return null
  return (
    <span data-testid="feature-request-corpus">
      {withReviews ? t('corpus.featureRequests', { count }) : t('corpus.featureRequestsOnly', { count })}
    </span>
  )
}

/** "Show requests" / "Hide requests", inline in the corpus line; `listId` names the list it opens. */
export function FeatureRequestToggle({ count, open, listId, onToggle }: Readonly<{
  count: number; open: boolean; listId: string; onToggle: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  if (count === 0) return null
  return (
    <button type="button" className="link" aria-expanded={open} aria-controls={listId} onClick={onToggle}>
      {open ? t('corpus.hideFeatureRequests') : t('corpus.showFeatureRequests')}
    </button>
  )
}

/** The requests as links (ids only: titles are read on the board), while open. */
export function FeatureRequestList({ ids, open, listId }: Readonly<{ ids: readonly string[]; open: boolean; listId: string }>) {
  const { t } = useTranslation('projectDetail')
  if (!open || ids.length === 0) return null
  return (
    <ul id={listId} className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs">
      {ids.map((id) => (
        <li key={id}><Link className="link font-mono" to={featureRequestHref(id)}>{t('corpus.featureRequestLink', { id })}</Link></li>
      ))}
    </ul>
  )
}
