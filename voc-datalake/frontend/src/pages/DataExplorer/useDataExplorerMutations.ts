/**
 * @fileoverview Custom hooks for Data Explorer mutations and handlers.
 * @module pages/DataExplorer/useDataExplorerMutations
 */

import {
  useMutation, useQueryClient,
} from '@tanstack/react-query'
import { dataExplorerApi } from '../../api/dataExplorerApi'
import type { FeedbackItem } from '../../api/types'

interface MutationCallbacks {
  onS3SaveSuccess: () => void
  onS3DeleteSuccess: () => void
  onFeedbackSaveSuccess: () => void
  onFeedbackDeleteSuccess: () => void
}

export function useDataExplorerMutations(selectedBucket: string, callbacks: MutationCallbacks) {
  const queryClient = useQueryClient()

  const saveS3Mutation = useMutation({
    mutationFn: (params: {
      key: string;
      content: string;
      syncToDynamo?: boolean
    }) =>
      dataExplorerApi.saveDataExplorerS3(params.key, params.content, params.syncToDynamo, selectedBucket),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['data-explorer-s3'] })
      void queryClient.invalidateQueries({ queryKey: ['data-explorer-feedback'] })
      callbacks.onS3SaveSuccess()
    },
  })

  const deleteS3Mutation = useMutation({
    mutationFn: (key: string) => dataExplorerApi.deleteDataExplorerS3(key, selectedBucket),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['data-explorer-s3'] })
      callbacks.onS3DeleteSuccess()
    },
  })

  const saveFeedbackMutation = useMutation({
    mutationFn: (params: {
      feedbackId: string;
      data: Partial<FeedbackItem>;
      syncToS3?: boolean
    }) =>
      dataExplorerApi.saveDataExplorerFeedback(params.feedbackId, params.data, params.syncToS3),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['data-explorer-feedback'] })
      void queryClient.invalidateQueries({ queryKey: ['data-explorer-s3'] })
      callbacks.onFeedbackSaveSuccess()
    },
  })

  const deleteFeedbackMutation = useMutation({
    mutationFn: (feedbackId: string) => dataExplorerApi.deleteDataExplorerFeedback(feedbackId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['data-explorer-feedback'] })
      callbacks.onFeedbackDeleteSuccess()
    },
  })

  return {
    saveS3Mutation,
    deleteS3Mutation,
    saveFeedbackMutation,
    deleteFeedbackMutation,
  }
}
