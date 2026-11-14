/**
 * @fileoverview The create-workspace form's own checks, the rules of `parse_new_workspace`
 * (lambda/shared/platform_workspaces.py): a name of 1 to 80 characters once trimmed, and a slug the platform can
 * make (`isWorkspaceSlug`). The server checks both again.
 *
 * @module pages/Settings/workspaceDraft
 */
import { WORKSPACE_NAME_MAX } from '../../api/platformWorkspacesApi'
import { isWorkspaceSlug } from '../../workspace/workspacePath'

export type DraftProblem = 'name' | 'slug'

/** What is wrong with the draft, field by field (none when it may be sent). */
export function workspaceDraftProblems(name: string, slug: string): DraftProblem[] {
  const problems: DraftProblem[] = []
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > WORKSPACE_NAME_MAX) problems.push('name')
  if (!isWorkspaceSlug(slug)) problems.push('slug')
  return problems
}
