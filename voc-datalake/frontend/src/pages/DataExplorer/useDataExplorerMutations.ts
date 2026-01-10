/**
 * @fileoverview Custom hooks for Data Explorer mutations and handlers.
 * @module pages/DataExplorer/useDataExplorerMutations
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { FeedbackItem } from '../../api/client'

interface MutationCallbacks {
  onS3SaveSuccess: () => void
  onS3DeleteSuccess: () => void
  onFeedbackSaveSuccess: () => void
  onFeedbackDeleteSuccess: () => void
}

export function useDataExplorerMutations(selectedBucket: string, callbacks: MutationCallbacks) {
  const queryClient = useQueryClient()

  const saveS3Mutation = useMutation({
    mutationFn: (params: { key: string; content: string; syncToDynamo?: boolean }) =>
      api.saveDataExplorerS3(params.key, params.content, params.syncToDynamo, selectedBucket),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['data-explorer-s3'] })
      queryClient.invalidateQueries({ queryKey: ['data-explorer-feedback'] })
      callbacks.onS3SaveSuccess()
    },
  })

  const deleteS3Mutation = useMutation({
    mutationFn: (key: string) => api.deleteDataExplorerS3(key, selectedBucket),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['data-explorer-s3'] })
      callbacks.onS3DeleteSuccess()
    },
  })

  const saveFeedbackMutation = useMutation({
    mutationFn: (params: { feedbackId: string; data: Partial<FeedbackItem>; syncToS3?: boolean }) =>
      api.saveDataExplorerFeedback(params.feedbackId, params.data, params.syncToS3),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['data-explorer-feedback'] })
      queryClient.invalidateQueries({ queryKey: ['data-explorer-s3'] })
      callbacks.onFeedbackSaveSuccess()
    },
  })

  const deleteFeedbackMutation = useMutation({
    mutationFn: (feedbackId: string) => api.deleteDataExplorerFeedback(feedbackId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['data-explorer-feedback'] })
      callbacks.onFeedbackDeleteSuccess()
    },
  })

  return { saveS3Mutation, deleteS3Mutation, saveFeedbackMutation, deleteFeedbackMutation }
}
