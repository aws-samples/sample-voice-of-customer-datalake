/**
 * Deleting a form removes its card at once (optimistic), puts it back if the
 * delete fails, and refetches the list either way. The card used to stay
 * listed until a reload: the page invalidated the list, but the refetch could
 * still return the just-deleted form (an eventually consistent read — the
 * list route now reads consistently too).
 *
 * @module pages/FeedbackForms/useOptimisticFormDelete
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { feedbackFormsKey, feedbackFormsWithStatsKey } from '../../api/feedbackFormQueryKeys'
import { isRecord } from '../../lib/typeGuards'

/** `data` (the list query's raw `{forms, stats}`) without the form `formId`; anything else unchanged. */
function withoutForm(data: unknown, formId: string): unknown {
  if (!isRecord(data) || !Array.isArray(data['forms'])) return data
  const forms: readonly unknown[] = data['forms']
  return { ...data, forms: forms.filter((form) => !isRecord(form) || form['form_id'] !== formId) }
}

export function useOptimisticFormDelete() {
  const queryClient = useQueryClient()
  const listKey = feedbackFormsWithStatsKey()
  return useMutation({
    mutationFn: (formId: string) => api.deleteFeedbackForm(formId),
    onMutate: async (formId: string) => {
      await queryClient.cancelQueries({ queryKey: listKey })
      const previous: unknown = queryClient.getQueryData(listKey)
      queryClient.setQueryData(listKey, (data: unknown) => withoutForm(data, formId))
      return { previous }
    },
    onError: (_error, _formId, context) => {
      if (context !== undefined) queryClient.setQueryData(listKey, context.previous)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: feedbackFormsKey() }),
  })
}
