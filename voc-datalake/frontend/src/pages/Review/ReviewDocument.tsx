/**
 * @fileoverview The shared document on `/review/:shareId` for a signed-in reviewer: its newest
 * version, the reviewer's own comment threads, and comment / reply (docs/document-review.md).
 *
 * @module pages/Review/ReviewDocument
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import DocumentComments from '../../components/DocumentComments/DocumentComments'
import { createReviewApi } from '../../api/documentReviewApi'
import { formatDate } from '../../utils/dateUtils'
import type { FetchApi } from '../../api/requestKit'
import type { NewComment } from '../../api/documentReviewApi'
import type { CommentActions } from '../../components/DocumentComments/commentTypes'

interface ReviewDocumentProps {
  readonly shareId: string
  /** The caller's session transport (the board pool's, or the app's for a teammate). */
  readonly fetchApi: FetchApi
  /** Separates the cache of the two sessions. */
  readonly session: 'app' | 'board'
}

export default function ReviewDocument({ shareId, fetchApi, session }: ReviewDocumentProps) {
  const { t, i18n } = useTranslation('components')
  const queryClient = useQueryClient()
  const api = useMemo(() => createReviewApi(fetchApi), [fetchApi])
  const key = useMemo(() => ['review', session, shareId] as const, [session, shareId])
  const query = useQuery({ queryKey: key, queryFn: () => api.get(shareId), retry: false })
  const actions = useMemo<CommentActions>(() => ({
    create: async (comment: NewComment) => {
      await api.comment(shareId, comment)
      await queryClient.invalidateQueries({ queryKey: key })
    },
    reply: async (commentId: string, text: string) => {
      await api.reply(shareId, commentId, text)
      await queryClient.invalidateQueries({ queryKey: key })
    },
  }), [api, shareId, queryClient, key])
  if (query.isPending) {
    return <p className="flex items-center gap-2 text-sm text-muted"><Loader2 size={14} className="animate-spin" aria-hidden />{t('reviewPage.loading')}</p>
  }
  if (query.isError) {
    return (
      <div className="card p-6 space-y-2 max-w-lg mx-auto">
        <h1 className="text-lg font-semibold text-text-strong">{t('reviewPage.goneTitle')}</h1>
        <p className="text-sm text-text">{t('reviewPage.gone')}</p>
      </div>
    )
  }
  const { document, share, threads } = query.data
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-xl font-bold tracking-tight text-text-strong break-words">{document.title}</h1>
        <p className="text-sm text-muted">
          {t('reviewPage.intro')}
          {share.expires_at === '' ? null : ` ${t('reviewPage.expires', { date: formatDate(share.expires_at, i18n.language) })}`}
        </p>
      </div>
      <div className="bg-card rounded-xl border border-border p-4 sm:p-6">
        <DocumentComments markdown={document.content} threads={threads}
          viewed={{ documentId: document.document_id }} actions={actions} canComment />
      </div>
    </div>
  )
}
