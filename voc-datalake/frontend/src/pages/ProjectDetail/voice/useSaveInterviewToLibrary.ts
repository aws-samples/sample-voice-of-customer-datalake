/**
 * @fileoverview "Save to Library" for a filed voice interview (docs/voice-personas.md, the Documents Library of
 * docs/documents-library.md): the `persona_interview` document's markdown becomes a Library item of the project, the
 * way the upload sheet makes one (a pending item and its presigned PUT, the PUT, then `markUploaded`). A failed PUT
 * takes its pending item back. The item is a reference, never evidence: the text keeps its synthetic label.
 *
 * @module pages/ProjectDetail/voice/useSaveInterviewToLibrary
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { libraryApi, libraryKeys, putLibraryFile } from '../../../api/libraryApi'
import { projectsApi } from '../../../api/projectsApi'
import { projectKey } from '../../../api/projectQueryKeys'

const MARKDOWN = 'text/markdown'
const MAX_FILENAME_CHARS = 80

/** `Interview with Ada` → `interview-with-ada.md`. */
function fileNameOf(title: string): string {
  const slug = title.toLowerCase().normalize('NFKD').split(/[^a-z0-9]+/).filter((part) => part !== '').join('-')
  return `${slug.slice(0, MAX_FILENAME_CHARS) || 'persona-interview'}.md`
}

async function saveToLibrary(projectId: string, documentId: string, readProject: () => ReturnType<typeof projectsApi.getProject>) {
  const document = (await readProject()).documents.find((one) => one.document_id === documentId)
  if (document === undefined) throw new Error('The transcript document is not in the project')
  const file = new File([document.content], fileNameOf(document.title), { type: MARKDOWN })
  const created = await libraryApi.create({
    filename: file.name, content_type: MARKDOWN, bytes: file.size, title: document.title, project_id: projectId,
  })
  try {
    await putLibraryFile(created.upload, file)
    await libraryApi.markUploaded(created.item.item_id)
  } catch (error) {
    libraryApi.remove(created.item.item_id).catch((removal: unknown) => { console.warn('Failed to remove a pending library item', removal) })
    throw error
  }
}

export function useSaveInterviewToLibrary(projectId: string, documentId: string | null) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      if (documentId === null) return
      await saveToLibrary(projectId, documentId, () => queryClient.query({
        queryKey: projectKey(projectId), queryFn: () => projectsApi.getProject(projectId), staleTime: 0,
      }))
      await queryClient.invalidateQueries({ queryKey: libraryKeys.all })
    },
  })
}
