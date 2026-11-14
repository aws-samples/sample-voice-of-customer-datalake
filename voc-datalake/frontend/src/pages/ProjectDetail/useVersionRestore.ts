/**
 * Writes that make a NEW version (one fresh `edit_id` per click), selected once it lands: a restore (the document
 * page's History dialog and a prototype's Back to vN) and a prototype's walkthrough save share the one hook.
 *
 * @module pages/ProjectDetail/useVersionRestore
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'
import type { ProjectDocument } from '../../api/types'

/** `write(input, editId)` makes the next version; on success the project is refetched and the version selected. */
export function useNewVersionWrite<T>(
  projectId: string, write: (input: T, editId: string) => Promise<ProjectDocument | null>,
  onSelectDoc: (doc: ProjectDocument) => void,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: T) => write(input, crypto.randomUUID()),
    onSuccess: (written) => {
      // The project prefix also covers every versions list of this project.
      void queryClient.invalidateQueries({ queryKey: projectKey(projectId) })
      if (written !== null) onSelectDoc(written)
    },
  })
}

/** Restore = a NEW version carrying an earlier version's content. */
export function useVersionRestore(projectId: string, documentId: string, onSelectDoc: (doc: ProjectDocument) => void) {
  return useNewVersionWrite(projectId, (versionId: string, editId) =>
    projectsApi.restoreDocumentVersion(projectId, documentId, versionId, editId), onSelectDoc)
}
