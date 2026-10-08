/**
 * @fileoverview Custom hooks for Data Explorer mutations and handlers.
 * @module pages/DataExplorer/useDataExplorerMutations
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { FeedbackItem } from '../../api/types'

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
      void queryClient.invalidateQueries({ queryKey: ['data-explorer-s3'] })
      void queryClient.invalidateQueries({ queryKey: ['data-explorer-feedback'] })
      callbacks.onS3SaveSuccess()
    },
  })

  const saveFeedbackMutation = useMutation({
    mutationFn: (params: { feedbackId: string; data: Partial<FeedbackItem> }) =>
      api.saveDataExplorerFeedback(params.feedbackId, params.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['data-explorer-feedback'] })
      callbacks.onFeedbackSaveSuccess()
    },
  })

  return { saveS3Mutation, saveFeedbackMutation }
}
