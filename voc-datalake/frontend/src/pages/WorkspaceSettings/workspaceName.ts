/**
 * @fileoverview A workspace name's own checks before a rename is sent, the rules of `validated_workspace_name`
 * (lambda/shared/platform_workspaces.py): 1 to 80 characters once trimmed (counted as Python counts them, by code
 * point), and no control character (Unicode category Cc: a tab, a line break). The server checks both again.
 *
 * @module pages/WorkspaceSettings/workspaceName
 */
import { WORKSPACE_NAME_MAX } from '../../api/platformWorkspacesApi'

export type WorkspaceNameProblem = 'length' | 'control'

const CONTROL_CHARACTER = /\p{Cc}/u

/** What is wrong with `name` as a workspace's name, or null when it may be sent (trimmed). */
export function workspaceNameProblem(name: string): WorkspaceNameProblem | null {
  const trimmed = name.trim()
  // Code points, as Python's len() counts them (not UTF-16 units, nor what a reader sees as one character).
  const length = Array.from(trimmed).length
  if (length === 0 || length > WORKSPACE_NAME_MAX) return 'length'
  return CONTROL_CHARACTER.test(trimmed) ? 'control' : null
}
