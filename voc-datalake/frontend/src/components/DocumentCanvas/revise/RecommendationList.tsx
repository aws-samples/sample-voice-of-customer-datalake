/**
 * @fileoverview One recommendation per thread a pass considered, each linked to its thread in the rail. Nothing is
 * written by it: it reads like a reviewer's notes.
 *
 * @module components/DocumentCanvas/revise/RecommendationList
 */
import { useTranslation } from 'react-i18next'
import ThreadLink from './ThreadLink'
import type { CommentThread, ReviseFromCommentsResult } from '../../../api/documentReviewSchema'

export default function RecommendationList({ recommendations, threads, onShowThread }: Readonly<{
  recommendations: ReviseFromCommentsResult['recommendations']
  threads: ReadonlyMap<string, CommentThread>
  onShowThread: (threadId: string) => void
}>) {
  const { t } = useTranslation('projectDetail')
  return (
    <ul aria-label={t('canvas.revise.recommendations.listLabel')} className="space-y-2">
      {recommendations.map((recommendation, index) => (
        <li key={`${recommendation.thread_id}-${String(index)}`} className="rounded-md border border-border bg-card p-2 space-y-1 min-w-0">
          <p className="whitespace-pre-wrap break-words text-[13px] text-text">{recommendation.text}</p>
          <ThreadLink threadId={recommendation.thread_id} threads={threads} onShowThread={onShowThread} />
        </li>
      ))}
    </ul>
  )
}
