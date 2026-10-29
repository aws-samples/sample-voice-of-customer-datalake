/**
 * @fileoverview "Start writing": create blank-template PR/FAQs / PRDs by hand, then open them.
 *
 * The Human-driven path of the document wizard (docs/ways-of-working.md): one
 * `POST /projects/{id}/documents` per selected type, then the project refetches and
 * `onOpen` receives the first new document's id (the page opens it on the Documents tab).
 *
 * @module pages/ProjectDetail/useStartWriting
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'
import type { GatedDocType } from '../../api/aiModeApi'

interface StartWritingInput {
  readonly docTypes: readonly GatedDocType[]
  readonly title: string
  /** Made once per click (see `start`), so a retried request files one document, not two. */
  readonly clickId: string
}

export function useStartWriting(projectId: string, onDone: () => void, onOpen?: (documentId: string) => void) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async ({ docTypes, title, clickId }: StartWritingInput) => {
      const created = []
      for (const docType of docTypes) {
        created.push(await projectsApi.startHandWrittenDocument(projectId, {
          document_type: docType, title: title.trim(), create_id: `${clickId}_${docType}`,
        }))
      }
      return created
    },
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: projectKey(projectId) })
      onDone()
      const first = created[0]?.document.document_id
      if (first !== undefined) onOpen?.(first)
    },
  })
  const start = (docTypes: readonly GatedDocType[], title: string) => {
    mutation.mutate({ docTypes, title, clickId: crypto.randomUUID().replaceAll('-', '') })
  }
  return { start, isPending: mutation.isPending, error: mutation.error }
}
