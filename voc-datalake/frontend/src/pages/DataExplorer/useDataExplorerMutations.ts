/**
 * @fileoverview Custom hooks for Data Explorer mutations and handlers.
 * @module pages/DataExplorer/useDataExplorerMutations
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { FeedbackItem } from '../../api/types'
import { isStaleEditorRefusal } from './openedStamp'
import { dataExplorerKeys } from './useDataExplorerQueries'

/**
 * Save-only by design: customer data is never deleted, so the explorer has no
 * delete mutations (the API removed both DELETE routes).
 */
interface MutationCallbacks {
  onS3SaveSuccess: () => void
  onFeedbackSaveSuccess: () => void
}

export function useDataExplorerMutations(selectedBucket: string, callbacks: MutationCallbacks) {
  const queryClient = useQueryClient()

  const saveS3Mutation = useMutation({
    mutationFn: (params: { key: string; content: string; syncToDynamo?: boolean }) =>
      api.saveDataExplorerS3(params.key, params.content, params.syncToDynamo, selectedBucket),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: dataExplorerKeys.s3() })
      void queryClient.invalidateQueries({ queryKey: dataExplorerKeys.feedback() })
      callbacks.onS3SaveSuccess()
    },
  })

  const saveFeedbackMutation = useMutation({
    mutationFn: (params: { feedbackId: string; data: Partial<FeedbackItem> & { updated_at?: string } }) =>
      api.saveDataExplorerFeedback(params.feedbackId, params.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: dataExplorerKeys.feedback() })
      callbacks.onFeedbackSaveSuccess()
    },
    // A 409 means the listed copy is stale: refetch it, so reopening the record brings the current stamp.
    onError: (error) => {
      if (isStaleEditorRefusal(error)) void queryClient.invalidateQueries({ queryKey: dataExplorerKeys.feedback() })
    },
  })

  return { saveS3Mutation, saveFeedbackMutation }
}
