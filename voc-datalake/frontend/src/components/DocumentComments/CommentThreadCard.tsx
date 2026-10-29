/**
 * @fileoverview One comment thread: who wrote it (a teammate, a persona, an outside reviewer),
 * the quoted passage, the text, its replies, and the actions its host allows.
 *
 * @module components/DocumentComments/CommentThreadCard
 */
import clsx from 'clsx'
import { CheckCircle2, ExternalLink, MessageSquare, RotateCcw, ShieldAlert, Trash2, User, UserRound } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import CommentComposer from './CommentComposer'
import { formatDateTime } from '../../utils/dateUtils'
import type { CommentActions, ViewedVersion } from './commentTypes'
import type { CommentAuthor, CommentThread } from '../../api/documentReviewSchema'
import type { LucideIcon } from 'lucide-react'

const AUTHOR_ICONS: Readonly<Record<CommentAuthor['kind'], LucideIcon>> = {
  user: User,
  persona: UserRound,
  reviewer: ExternalLink,
}

function AuthorLine({ author, at }: Readonly<{ author: CommentAuthor; at: string }>) {
  const { t, i18n } = useTranslation('components')
  const Icon = AUTHOR_ICONS[author.kind]
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted min-w-0">
      <Icon size={12} aria-hidden className="shrink-0" />
      <span className="font-medium text-text truncate">{author.name || t(`documentComments.authorKind.${author.kind}`)}</span>
      <span className="shrink-0">· {t(`documentComments.authorKind.${author.kind}`)}</span>
      {at === '' ? null : <span className="ml-auto shrink-0 font-mono">{formatDateTime(at, i18n.language, '', 'short')}</span>}
    </div>
  )
}

function ThreadBadges({ thread, viewed }: Readonly<{ thread: CommentThread; viewed: ViewedVersion }>) {
  const { t } = useTranslation('components')
  const otherVersion = thread.document_id !== '' && thread.document_id !== viewed.documentId && thread.version !== null
  return (
    <div className="flex flex-wrap gap-1">
      {thread.verdict === undefined ? null : (
        <span className="badge badge-muted">{t(`documentComments.stance.${thread.verdict}`)}</span>
      )}
      {otherVersion ? <span className="badge badge-muted">{t('documentComments.onVersion', { version: thread.version })}</span> : null}
      {thread.status === 'resolved' ? <span className="badge badge-ok">{t('documentComments.resolved')}</span> : null}
      {thread.flagged ? (
        <span className="badge badge-warn" title={t('documentComments.flaggedHint')}>
          <ShieldAlert size={10} aria-hidden />{t('documentComments.flagged')}
        </span>
      ) : null}
    </div>
  )
}

function ThreadActions({ thread, actions }: Readonly<{ thread: CommentThread; actions: CommentActions }>) {
  const { t } = useTranslation('components')
  const [busy, setBusy] = useState(false)
  const run = (action: ((id: string) => Promise<unknown>) | undefined) => {
    if (action === undefined) return
    setBusy(true)
    void action(thread.comment_id).catch(() => undefined).finally(() => setBusy(false))
  }
  const resolved = thread.status === 'resolved'
  const toggle = resolved ? actions.reopen : actions.resolve
  const canRemove = actions.remove !== undefined && (actions.canRemove?.(thread) ?? false)
  return (
    <div className="flex gap-1">
      {toggle === undefined ? null : (
        <button type="button" className="icon-btn p-1" disabled={busy} onClick={() => run(toggle)}
          title={resolved ? t('documentComments.reopen') : t('documentComments.resolve')}
          aria-label={resolved ? t('documentComments.reopen') : t('documentComments.resolve')}>
          {resolved ? <RotateCcw size={14} aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
        </button>
      )}
      {canRemove ? (
        <button type="button" className="icon-btn p-1 hover:text-danger" disabled={busy} onClick={() => run(actions.remove)}
          title={t('documentComments.delete')} aria-label={t('documentComments.delete')}>
          <Trash2 size={14} aria-hidden />
        </button>
      ) : null}
    </div>
  )
}

interface CommentThreadCardProps {
  readonly thread: CommentThread
  readonly actions: CommentActions
  readonly viewed: ViewedVersion
  readonly active: boolean
  readonly onActivate: (commentId: string | null) => void
}

export default function CommentThreadCard({ thread, actions, viewed, active, onActivate }: CommentThreadCardProps) {
  const { t } = useTranslation('components')
  const [replying, setReplying] = useState(false)
  return (
    <article
      aria-label={t('documentComments.threadBy', { name: thread.author.name })}
      className={clsx('rounded-lg border bg-card p-3 space-y-2 text-sm transition-shadow',
        active ? 'border-warn shadow-md' : 'border-border', thread.status === 'resolved' && 'opacity-75')}
      onFocus={() => onActivate(thread.comment_id)}
      onMouseEnter={() => onActivate(thread.comment_id)}
      onMouseLeave={() => onActivate(null)}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1"><AuthorLine author={thread.author} at={thread.created_at} /></div>
        <ThreadActions thread={thread} actions={actions} />
      </div>
      <ThreadBadges thread={thread} viewed={viewed} />
      {thread.anchor === null ? null : (
        <blockquote className="border-l-2 border-warn pl-2 text-xs text-muted line-clamp-3">{thread.anchor.exact}</blockquote>
      )}
      <p className="whitespace-pre-wrap break-words text-text">{thread.text}</p>
      {thread.replies.length === 0 ? null : (
        <ul className="space-y-2 border-t border-border pt-2">
          {thread.replies.map((reply) => (
            <li key={reply.reply_id} className="space-y-1">
              <AuthorLine author={reply.author} at={reply.at} />
              <p className="whitespace-pre-wrap break-words text-text">{reply.text}</p>
            </li>
          ))}
        </ul>
      )}
      {replying ? (
        <CommentComposer label={t('documentComments.replyPlaceholder')} submitLabel={t('documentComments.reply')} autoFocus
          onSubmit={async (text) => { await actions.reply(thread.comment_id, text); setReplying(false) }}
          onCancel={() => setReplying(false)} />
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReplying(true)}>
          <MessageSquare size={14} aria-hidden />{t('documentComments.reply')}
        </button>
      )}
    </article>
  )
}
