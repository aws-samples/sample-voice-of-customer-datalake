/**
 * @fileoverview The team's comments on one PR/FAQ or PRD: the threads of its series, its review
 * link, and the actions (comment, reply, resolve, reopen, delete, share, ask personas).
 * Every write refetches the series (comments change rarely; one GET keeps the order right).
 *
 * @module pages/ProjectDetail/useDocumentComments
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { appDocumentCommentsApi } from '../../api/documentReviewApi'
import { useAuthStore } from '../../store/authStore'
import type { NewComment, ShareSettings } from '../../api/documentReviewApi'
import type { CommentThread } from '../../api/documentReviewSchema'
import type { CommentActions } from '../../components/DocumentComments/commentTypes'

const documentCommentsKey = (projectId: string, documentId: string) =>
  ['document-comments', projectId, documentId] as const

export function useDocumentComments(projectId: string, documentId: string) {
  const queryClient = useQueryClient()
  const mySub = useAuthStore((state) => state.user?.sub)
  const key = documentCommentsKey(projectId, documentId)
  const query = useQuery({
    queryKey: key,
    queryFn: () => appDocumentCommentsApi.list(projectId, documentId),
  })
  const canEdit = query.data?.can_edit ?? false
  const actions = useMemo<CommentActions>(() => {
    const api = appDocumentCommentsApi
    const refreshing = <A extends unknown[]>(call: (...args: A) => Promise<unknown>) =>
      async (...args: A) => {
        await call(...args)
        await queryClient.invalidateQueries({ queryKey: documentCommentsKey(projectId, documentId) })
      }
    return {
      create: refreshing((comment: NewComment) => api.create(projectId, documentId, comment)),
      reply: refreshing((id: string, text: string) => api.reply(projectId, documentId, id, text)),
      resolve: refreshing((id: string) => api.resolve(projectId, documentId, id)),
      reopen: refreshing((id: string) => api.reopen(projectId, documentId, id)),
      remove: refreshing((id: string) => api.remove(projectId, documentId, id)),
      canRemove: (thread: CommentThread) =>
        canEdit || (thread.author.kind === 'user' && mySub !== undefined && thread.author.sub === mySub),
    }
  }, [queryClient, projectId, documentId, canEdit, mySub])
  const refresh = () => queryClient.invalidateQueries({ queryKey: key })
  return {
    query,
    actions,
    share: query.data?.share ?? null,
    canEdit,
    createShare: async (settings: ShareSettings) => {
      await appDocumentCommentsApi.createShare(projectId, documentId, settings)
      await refresh()
    },
    revokeShare: async () => {
      await appDocumentCommentsApi.revokeShare(projectId, documentId)
      await refresh()
    },
    personaReview: async () => {
      const result = await appDocumentCommentsApi.personaReview(projectId, documentId)
      await refresh()
      return result
    },
  }
}
