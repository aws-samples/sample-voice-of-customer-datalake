/**
 * Restore = a NEW version carrying an earlier version's content (one fresh `edit_id` per click),
 * selected once it lands. The document page's History dialog and a prototype's Back to vN share it.
 *
 * @module pages/ProjectDetail/useVersionRestore
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'
import type { ProjectDocument } from '../../api/types'

export function useVersionRestore(projectId: string, documentId: string, onSelectDoc: (doc: ProjectDocument) => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (versionId: string) =>
      projectsApi.restoreDocumentVersion(projectId, documentId, versionId, crypto.randomUUID()),
    onSuccess: (restored) => {
      // The project prefix also covers every versions list of this project.
      void queryClient.invalidateQueries({ queryKey: projectKey(projectId) })
      if (restored !== null) onSelectDoc(restored)
    },
  })
}
