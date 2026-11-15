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
  const name = t('canvas.revise.showThread', { label })
  // The quote wraps (two lines at most, the rest in the name and the tooltip) rather than cut to a few words on a
  // phone's width. The tooltip is the name itself, so a screen reader does not read the quote a second time.
  return (
    <button type="button" className="btn btn-ghost btn-sm max-w-full justify-start items-start text-left" onClick={() => onShowThread(threadId)}
      aria-label={name} title={name}>
      <MessageSquare size={12} aria-hidden className="mt-0.5 shrink-0" />
      <span data-testid="thread-link-label" className="min-w-0 line-clamp-2 break-words">{label}</span>
    </button>
  )
}
