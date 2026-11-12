/**
 * @fileoverview A link from a recommendation or a proposed change to the comment it answers: the thread's quote (or
 * its text, on the whole document), as a button that brings the thread into view in the rail.
 *
 * @module components/DocumentCanvas/revise/ThreadLink
 */
import { MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CommentThread } from '../../../api/documentReviewSchema'

/** What names a thread in a short line: its quote, else its text. */
const threadLabel = (thread: CommentThread): string => thread.anchor?.exact ?? thread.text

export default function ThreadLink({ threadId, threads, onShowThread }: Readonly<{
  threadId: string; threads: ReadonlyMap<string, CommentThread>; onShowThread: (threadId: string) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const thread = threads.get(threadId)
  // Deleted since the pass: nothing to show.
  if (thread === undefined) return <span className="text-xs text-muted">{t('canvas.revise.threadGone')}</span>
  const label = threadLabel(thread)
  return (
    <button type="button" className="btn btn-ghost btn-sm max-w-full text-left" onClick={() => onShowThread(threadId)}
      aria-label={t('canvas.revise.showThread', { label })}>
      <MessageSquare size={12} aria-hidden className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}
