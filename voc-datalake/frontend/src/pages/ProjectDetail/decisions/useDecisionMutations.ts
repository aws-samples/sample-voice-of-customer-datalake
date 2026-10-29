/**
 * @fileoverview Save, Delete and Pursue for decision records. Save and Delete write their
 * result into the project cache at once (`decisionCache.ts` says why), then refresh the
 * project in the background; Pursue refreshes it and hands the new PR/FAQ job to the
 * page's Background Jobs panel.
 * @module pages/ProjectDetail/decisions/useDecisionMutations
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { decisionsApi } from '../../../api/decisionsApi'
import { projectKey } from '../../../api/projectQueryKeys'
import { projectsApi } from '../../../api/projectsApi'
import type { DecisionInput } from '../../../api/decisionsApi'
import type { ProjectDetail } from '../../../api/projectTypes'
import { withSavedDocument, withoutDocument } from './decisionCache'

interface SaveArgs {
  input: DecisionInput
  /** The decision being edited, with the revision the editor loaded; absent = a new one. */
  editing?: { documentId: string; revision: number }
}

export function useDecisionMutations(projectId: string, onJobStarted?: () => void) {
  const queryClient = useQueryClient()
  const key = projectKey(projectId)
  const refresh = () => queryClient.invalidateQueries({ queryKey: key })
  const updateCache = (update: (detail: ProjectDetail | undefined) => ProjectDetail | undefined) => {
    queryClient.setQueryData<ProjectDetail>(key, update)
  }

  const save = useMutation({
    mutationFn: ({ input, editing }: SaveArgs) => (editing
      ? decisionsApi.updateDecision(projectId, editing.documentId, input, editing.revision)
      : decisionsApi.createDecision(projectId, input)),
    onSuccess: (saved) => {
      if (saved !== null) updateCache((detail) => withSavedDocument(detail, saved))
      void refresh()
    },
  })

  const remove = useMutation({
    mutationFn: (documentId: string) => projectsApi.deleteDocument(projectId, documentId),
    onSuccess: (_answer, documentId) => {
      updateCache((detail) => withoutDocument(detail, documentId))
      void refresh()
    },
  })

  const pursue = useMutation({
    mutationFn: ({ documentId, language }: { documentId: string; language: string }) =>
      decisionsApi.pursueDecision(projectId, documentId, language),
    onSuccess: async () => {
      onJobStarted?.()
      await refresh()
    },
  })

  return { save, remove, pursue }
}
