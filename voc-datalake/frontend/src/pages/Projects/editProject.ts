/**
 * @fileoverview The Projects list's Edit dialog: its draft, validation and save.
 *
 * Saving is up to two calls, because the server splits the permissions:
 * `PUT /projects/{id}` (name, description) needs EDIT, and
 * `PUT /projects/{id}/visibility` needs MANAGE (lambda/shared/project_access.py).
 * Only the fields that changed are sent, so an editor who renames a project never
 * sends a visibility call the gate would refuse.
 *
 * The list card updates optimistically and rolls back on failure; the project's
 * own queries (detail, the Prioritization fan-out) are invalidated when it settles.
 *
 * @module pages/Projects/editProject
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { allProjectDetailsKey, projectKey, projectsKey } from '../../api/projectQueryKeys'
import { projectsApi } from '../../api/projectsApi'
import type { Project, ProjectVisibility } from '../../api/projectTypes'

/** What the dialog edits. */
export interface EditProjectDraft {
  name: string
  description: string
  visibility: ProjectVisibility
}

/** The i18n key (projects namespace) of the name error; the only rule the dialog enforces. */
const NAME_REQUIRED_KEY = 'editModal.nameRequired'

/**
 * The draft as it is SENT: the name trimmed and non-blank (the server refuses a
 * blank name with a 400 too; see `_validated_name` in lambda/api/projects.py).
 */
export const EditProjectDraftSchema = z.object({
  name: z.string().trim().min(1, NAME_REQUIRED_KEY),
  description: z.string(),
  visibility: z.enum(['public', 'private']),
})

/** The draft a dialog opens with: the project's current values. */
export function draftFrom(project: Project): EditProjectDraft {
  return {
    name: project.name,
    description: project.description,
    // A legacy row without visibility reads public on the server (project_access.py).
    visibility: project.visibility ?? 'public',
  }
}

/** The calls a validated draft needs; `undefined` parts are left alone. */
export interface ProjectEdits {
  fields?: { name?: string; description?: string }
  visibility?: ProjectVisibility
}

/**
 * Only what changed, and visibility only for a caller who may manage. Empty when
 * nothing would change, which is how the dialog disables Save.
 */
export function editsFor(project: Project, draft: EditProjectDraft, canManage: boolean): ProjectEdits {
  const parsed = EditProjectDraftSchema.safeParse(draft)
  if (!parsed.success) return {}
  const { name, description, visibility } = parsed.data
  const fields: NonNullable<ProjectEdits['fields']> = {}
  if (name !== project.name) fields.name = name
  if (description !== project.description) fields.description = description
  const edits: ProjectEdits = {}
  if (Object.keys(fields).length > 0) edits.fields = fields
  if (canManage && visibility !== draftFrom(project).visibility) edits.visibility = visibility
  return edits
}

export function hasEdits(edits: ProjectEdits): boolean {
  return edits.fields !== undefined || edits.visibility !== undefined
}

/** The list cache with `edits` applied to the project they belong to. */
function withEdits(list: { projects: Project[] } | undefined, projectId: string, edits: ProjectEdits) {
  if (list === undefined) return undefined
  return {
    ...list,
    projects: list.projects.map((p) => (p.project_id === projectId
      ? { ...p, ...edits.fields, ...(edits.visibility === undefined ? {} : { visibility: edits.visibility }) }
      : p)),
  }
}

interface SaveVariables {
  projectId: string
  edits: ProjectEdits
}

/** Sends the edits: fields first (EDIT), then visibility (MANAGE). */
async function saveEdits({ projectId, edits }: SaveVariables): Promise<void> {
  if (edits.fields !== undefined) await projectsApi.updateProject(projectId, edits.fields)
  if (edits.visibility !== undefined) await projectsApi.setVisibility(projectId, edits.visibility)
}

/** The Edit dialog's save, with an optimistic list update and rollback. */
export function useEditProject(onSaved: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: saveEdits,
    onMutate: async ({ projectId, edits }: SaveVariables) => {
      await queryClient.cancelQueries({ queryKey: projectsKey() })
      const previous = queryClient.getQueryData<{ projects: Project[] }>(projectsKey())
      queryClient.setQueryData(projectsKey(), withEdits(previous, projectId, edits))
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(projectsKey(), context.previous)
    },
    onSuccess: onSaved,
    onSettled: (_data, _error, { projectId }) => Promise.all([
      queryClient.invalidateQueries({ queryKey: projectsKey() }),
      queryClient.invalidateQueries({ queryKey: projectKey(projectId) }),
      queryClient.invalidateQueries({ queryKey: allProjectDetailsKey() }),
    ]),
  })
}
