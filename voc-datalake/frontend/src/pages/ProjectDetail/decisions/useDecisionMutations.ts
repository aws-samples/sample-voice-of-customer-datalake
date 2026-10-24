/**
 * @fileoverview Save and Pursue for decision records. Both refresh the project
 * (a decision is a project document); Pursue also hands the new PR/FAQ job to the
 * page's Background Jobs panel.
 * @module pages/ProjectDetail/decisions/useDecisionMutations
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { decisionsApi } from '../../../api/decisionsApi'
import { projectKey } from '../../../api/projectQueryKeys'
import type { DecisionInput } from '../../../api/decisionsApi'

interface SaveArgs {
  input: DecisionInput
  /** The decision being edited, with the revision the editor loaded; absent = a new one. */
  editing?: { documentId: string; revision: number }
}

export function useDecisionMutations(projectId: string, onJobStarted?: () => void) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: projectKey(projectId) })

  const save = useMutation({
    mutationFn: ({ input, editing }: SaveArgs) => (editing
      ? decisionsApi.updateDecision(projectId, editing.documentId, input, editing.revision)
      : decisionsApi.createDecision(projectId, input)),
    onSuccess: refresh,
  })

  const pursue = useMutation({
    mutationFn: ({ documentId, language }: { documentId: string; language: string }) =>
      decisionsApi.pursueDecision(projectId, documentId, language),
    onSuccess: async () => {
      onJobStarted?.()
      await refresh()
    },
  })

  return { save, pursue }
}
